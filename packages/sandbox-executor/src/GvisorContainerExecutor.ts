import { access, constants } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecuteResult, Executor } from "@cloudflare/codemode";
import type {
  SandboxCallbackRequest,
  SandboxCallbackResponse,
  SandboxJob,
  SandboxLimits,
  SandboxRunResult
} from "../../sandbox-protocol/src/index.js";

export type SandboxEngine = "podman" | "docker" | "process";

export interface GvisorContainerExecutorOptions {
  engine?: SandboxEngine;
  image?: string;
  runtime?: string;
  workspaceRoot?: string;
  timeoutMs?: number;
  callbackTimeoutMs?: number;
  maxLogBytes?: number;
  maxResultBytes?: number;
  maxCallbacks?: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  user?: string;
  preserveWorkspace?: boolean;
  runnerPath?: string;
}

interface SpawnPlan {
  command: string;
  args: string[];
}

interface CallbackLoopState {
  active: boolean;
  handledFiles: Set<string>;
  handledCount: number;
}

const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 120_000,
  callbackTimeoutMs: 30_000,
  maxLogBytes: 128_000,
  maxResultBytes: 256_000,
  maxCallbacks: 200,
  memory: "512m",
  cpus: "1",
  pidsLimit: 128
};

function defaultRunnerPath(): string {
  return path.resolve(process.cwd(), "docker", "sandbox-runner", "entrypoint.mjs");
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

function serializeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateLogs(logs: string[], maxBytes: number): string[] {
  const joined = logs.join("\n");
  if (Buffer.byteLength(joined, "utf8") <= maxBytes) {
    return logs;
  }

  const truncated = joined.slice(0, maxBytes);
  return [
    truncated,
    "[logs truncated after configured maxLogBytes limit]"
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export class GvisorContainerExecutor implements Executor {
  private readonly engine: SandboxEngine;
  private readonly image: string;
  private readonly runtime: string;
  private readonly workspaceRoot: string;
  private readonly limits: SandboxLimits;
  private readonly user: string;
  private readonly preserveWorkspace: boolean;
  private readonly runnerPath: string;

  constructor(options: GvisorContainerExecutorOptions = {}) {
    this.engine = options.engine ?? "podman";
    this.image = options.image ?? "codemode-sandbox-runner:local";
    this.runtime = options.runtime ?? "runsc";
    this.workspaceRoot = options.workspaceRoot ?? path.join(process.cwd(), ".tmp", "codemode-runs");
    this.limits = {
      timeoutMs: options.timeoutMs ?? DEFAULT_LIMITS.timeoutMs,
      callbackTimeoutMs:
        options.callbackTimeoutMs ?? DEFAULT_LIMITS.callbackTimeoutMs,
      maxLogBytes: options.maxLogBytes ?? DEFAULT_LIMITS.maxLogBytes,
      maxResultBytes: options.maxResultBytes ?? DEFAULT_LIMITS.maxResultBytes,
      maxCallbacks: options.maxCallbacks ?? DEFAULT_LIMITS.maxCallbacks,
      memory: options.memory ?? DEFAULT_LIMITS.memory,
      cpus: options.cpus ?? DEFAULT_LIMITS.cpus,
      pidsLimit: options.pidsLimit ?? DEFAULT_LIMITS.pidsLimit
    };
    this.user = options.user ?? "65532:65532";
    this.preserveWorkspace = options.preserveWorkspace ?? false;
    this.runnerPath = options.runnerPath ?? defaultRunnerPath();
  }

  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const workspace = await this.createWorkspace();
    const callbackDirectory = path.join(workspace, "callbacks");
    const jobPath = path.join(workspace, "job.json");
    const resultPath = path.join(workspace, "result.json");
    const runnerLogs: string[] = [];
    const callbackState: CallbackLoopState = {
      active: true,
      handledFiles: new Set<string>(),
      handledCount: 0
    };

    try {
      await mkdir(callbackDirectory, { recursive: true });

      const job: SandboxJob = {
        code,
        callbackDirectory: "callbacks",
        resultFile: "result.json",
        callbackTimeoutMs: this.limits.callbackTimeoutMs,
        maxLogBytes: this.limits.maxLogBytes
      };

      await writeFile(jobPath, JSON.stringify(job, null, 2), "utf8");

      const callbackLoop = this.processCallbacks(
        callbackDirectory,
        fns,
        callbackState
      );

      const spawnPlan = await this.buildSpawnPlan(workspace, jobPath);
      const child = spawn(spawnPlan.command, spawnPlan.args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      child.stdout.on("data", (chunk: Buffer) => {
        runnerLogs.push(`[runner stdout] ${chunk.toString("utf8").trimEnd()}`);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        runnerLogs.push(`[runner stderr] ${chunk.toString("utf8").trimEnd()}`);
      });

      const exitCode = await Promise.race([
        waitForExit(child),
        delay(this.limits.timeoutMs).then(() => {
          child.kill("SIGKILL");
          throw new Error(
            `Sandbox execution exceeded ${this.limits.timeoutMs}ms timeout.`
          );
        })
      ]);

      callbackState.active = false;
      await callbackLoop;

      if (!(await fileExists(resultPath))) {
        return {
          result: undefined,
          error:
            exitCode === 0
              ? "Sandbox completed without writing a result file."
              : `Sandbox process exited with code ${String(exitCode)}.`,
          logs: truncateLogs(runnerLogs, this.limits.maxLogBytes)
        };
      }

      const resultFile = await readFile(resultPath, "utf8");
      if (Buffer.byteLength(resultFile, "utf8") > this.limits.maxResultBytes) {
        return {
          result: undefined,
          error: "Sandbox result exceeded the configured maxResultBytes limit.",
          logs: truncateLogs(runnerLogs, this.limits.maxLogBytes)
        };
      }

      const parsed = JSON.parse(resultFile) as SandboxRunResult;
      const response: ExecuteResult = {
        result: parsed.result,
        logs: truncateLogs(
          [...(parsed.logs ?? []), ...runnerLogs],
          this.limits.maxLogBytes
        )
      };

      if (parsed.error) {
        response.error = parsed.error;
      }

      return response;
    } catch (error) {
      return {
        result: undefined,
        error: serializeError(error),
        logs: truncateLogs(runnerLogs, this.limits.maxLogBytes)
      };
    } finally {
      callbackState.active = false;
      if (!this.preserveWorkspace) {
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }

  private async createWorkspace(): Promise<string> {
    await mkdir(this.workspaceRoot, { recursive: true });
    return mkdtemp(path.join(this.workspaceRoot, "run-"));
  }

  private async buildSpawnPlan(
    workspace: string,
    jobPath: string
  ): Promise<SpawnPlan> {
    if (this.engine === "process") {
      await new Promise<void>((resolve, reject) => {
        access(this.runnerPath, constants.R_OK, (error) => {
          if (error) {
            reject(
              new Error(
                `Sandbox runner entrypoint was not found at ${this.runnerPath}.`
              )
            );
            return;
          }
          resolve();
        });
      });

      return {
        command: process.execPath,
        args: [this.runnerPath, jobPath]
      };
    }

    const runtimeArgs = await this.resolveRuntimeArgs();

    return {
      command: this.engine,
      args: [
        "run",
        "--rm",
        ...runtimeArgs,
        "--network=none",
        "--read-only",
        "--tmpfs=/tmp:rw,nosuid,nodev,size=64m",
        `--memory=${this.limits.memory}`,
        `--cpus=${this.limits.cpus}`,
        `--pids-limit=${String(this.limits.pidsLimit)}`,
        `--user=${this.user}`,
        `--volume=${workspace}:/workspace:rw`,
        "--workdir=/workspace",
        this.image,
        "/workspace/job.json"
      ]
    };
  }

  private async resolveRuntimeArgs(): Promise<string[]> {
    if (this.engine !== "podman" && this.engine !== "docker") {
      return [];
    }

    const runtimeFlag = `--runtime=${this.runtime}`;
    const helpOutput = await this.captureCommandOutput(this.engine, ["run", "--help"]);

    if (helpOutput.includes("--runtime")) {
      return [runtimeFlag];
    }

    if (this.engine === "podman") {
      const globalHelp = await this.captureCommandOutput("podman", ["--help"]);
      if (globalHelp.includes("--runtime")) {
        return [runtimeFlag];
      }
    }

    return [];
  }

  private async captureCommandOutput(
    command: string,
    args: string[]
  ): Promise<string> {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await waitForExit(child);
    return `${stdout}\n${stderr}`;
  }

  private async processCallbacks(
    callbackDirectory: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    state: CallbackLoopState
  ): Promise<void> {
    while (state.active) {
      await this.flushPendingRequests(callbackDirectory, fns, state);
      await delay(25);
    }

    await this.flushPendingRequests(callbackDirectory, fns, state);
  }

  private async flushPendingRequests(
    callbackDirectory: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>,
    state: CallbackLoopState
  ): Promise<void> {
    const entries = await readdir(callbackDirectory);
    const requestFiles = entries.filter((entry) => entry.endsWith(".request.json"));

    for (const fileName of requestFiles) {
      if (state.handledFiles.has(fileName)) {
        continue;
      }

      state.handledFiles.add(fileName);
      state.handledCount += 1;

      const requestPath = path.join(callbackDirectory, fileName);
      const requestText = await readFile(requestPath, "utf8");
      const request = JSON.parse(requestText) as SandboxCallbackRequest;
      const response: SandboxCallbackResponse = { id: request.id };

      try {
        if (state.handledCount > this.limits.maxCallbacks) {
          throw new Error(
            `Sandbox exceeded the callback limit of ${this.limits.maxCallbacks}.`
          );
        }

        const fn = fns[request.name];
        if (!fn) {
          throw new Error(`Host function "${request.name}" is not registered.`);
        }

        response.result = await fn(request.args);
      } catch (error) {
        response.error = serializeError(error);
      }

      const responsePath = path.join(
        callbackDirectory,
        `${request.id}.response.json`
      );
      await writeFile(responsePath, JSON.stringify(response), "utf8");
    }
  }
}
