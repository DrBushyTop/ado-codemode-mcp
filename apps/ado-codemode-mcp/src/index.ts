import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DEFAULT_ALLOWED_TOOLS,
  LocalStdioAzdoBridge,
  type AzdoToolInfo
} from "../../../packages/azdo-mcp-client/src/index.js";
import {
  readGatewayAzdoConfig,
  toAzureDevOpsServerCommand
} from "../../../packages/azdo-mcp-client/src/config.js";
import { GvisorContainerExecutor } from "../../../packages/sandbox-executor/src/index.js";
import {
  buildCapabilitySummary,
  createExecutionCodeTool,
  runExecute,
  runSearch
} from "./logic.js";

let executeSequence = 0;
const exposeDebugTools = process.env.ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS === "1";

function parseOptionalIntegerEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) {
    return undefined;
  }

  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer.`);
  }

  return value;
}

const azdoConfig = readGatewayAzdoConfig();
function contentText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

const bridge = new LocalStdioAzdoBridge({
  serverCommand: toAzureDevOpsServerCommand(azdoConfig)
});
const executorOptions: ConstructorParameters<typeof GvisorContainerExecutor>[0] = {
  engine:
    (process.env.CODEMODE_SANDBOX_ENGINE as
      | "podman"
      | "docker"
      | "process"
      | undefined) ?? "podman",
  preserveWorkspace: process.env.CODEMODE_PRESERVE_WORKSPACE === "1"
};

const timeoutMs = parseOptionalIntegerEnv("CODEMODE_SANDBOX_TIMEOUT_MS");
const callbackTimeoutMs = parseOptionalIntegerEnv(
  "CODEMODE_SANDBOX_CALLBACK_TIMEOUT_MS"
);
const maxLogBytes = parseOptionalIntegerEnv("CODEMODE_SANDBOX_MAX_LOG_BYTES");
const maxResultBytes = parseOptionalIntegerEnv(
  "CODEMODE_SANDBOX_MAX_RESULT_BYTES"
);
const maxCallbacks = parseOptionalIntegerEnv("CODEMODE_SANDBOX_MAX_CALLBACKS");

if (timeoutMs !== undefined) {
  executorOptions.timeoutMs = timeoutMs;
}

if (callbackTimeoutMs !== undefined) {
  executorOptions.callbackTimeoutMs = callbackTimeoutMs;
}

if (maxLogBytes !== undefined) {
  executorOptions.maxLogBytes = maxLogBytes;
}

if (maxResultBytes !== undefined) {
  executorOptions.maxResultBytes = maxResultBytes;
}

if (maxCallbacks !== undefined) {
  executorOptions.maxCallbacks = maxCallbacks;
}

if (process.env.CODEMODE_SANDBOX_IMAGE) {
  executorOptions.image = process.env.CODEMODE_SANDBOX_IMAGE;
}

if (process.env.CODEMODE_SANDBOX_RUNTIME) {
  executorOptions.runtime = process.env.CODEMODE_SANDBOX_RUNTIME;
}

const executor = new GvisorContainerExecutor(executorOptions);
const codemode = createExecutionCodeTool(bridge, executor);

const server = new McpServer({
  name: "ado-codemode-mcp",
  version: "0.1.0"
});

server.tool(
  "search",
  "Search the Azure DevOps tool catalog. Call this once first to narrow the exact tool names you need before execute. Return a compact result that includes `name`, `description`, `inputSchema`, and `outputSchema` when available so the next execute call knows the required parameters and expected structured output. Do not use search for repeated trial-and-error exploration once you already have the needed tool names and schemas.",
  {
    code: z
      .string()
      .min(1)
      .describe(
        "JavaScript async arrow function that receives a static Azure DevOps tool catalog as `tools` and returns the relevant subset or summary. Prefer returning a compact array of `{ name, description, inputSchema, outputSchema }` so you know which parameters to pass next and what structured output to expect when available. Example: async () => tools.filter((tool) => /project|query|wiql|work item/i.test(`${tool.name} ${tool.description}`)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null }))"
      )
  },
  async ({ code }) => contentText(await runSearch(bridge, executor, code))
);

if (exposeDebugTools) {
  server.tool(
    "list_capabilities",
    "Describe the helper APIs, safety rules, and Azure DevOps tool surface exposed by the gateway.",
    {},
    async () => {
      const allowedTools = await bridge.listTools();
      return contentText(
        buildCapabilitySummary(allowedTools, {
          includeAllowlist: true,
          includeHelpers: true
        })
      );
    }
  );

  server.tool(
    "health",
    "Return bridge and sandbox configuration health for the local gateway.",
    {},
    async () => {
      return contentText({
        bridge: await bridge.health(),
        azdo: {
          organization: azdoConfig.organization,
          authentication: azdoConfig.authentication,
          domains: azdoConfig.domains,
          binary: azdoConfig.binary,
          tenant: azdoConfig.tenant ?? null
        },
        sandbox: {
          engine: process.env.CODEMODE_SANDBOX_ENGINE ?? "podman",
          image: process.env.CODEMODE_SANDBOX_IMAGE ?? "codemode-sandbox-runner:local",
          runtime: process.env.CODEMODE_SANDBOX_RUNTIME ?? "runsc",
          timeoutMs: timeoutMs ?? 120_000,
          callbackTimeoutMs: callbackTimeoutMs ?? 30_000,
          maxLogBytes: maxLogBytes ?? 128_000,
          maxResultBytes: maxResultBytes ?? 256_000,
          maxCallbacks: maxCallbacks ?? 200
        }
      });
    }
  );
}

server.tool(
  "execute",
  "Run a JavaScript program that calls Azure DevOps tools. First call MCP search to find the relevant tool names, then use one combined execute program for the task instead of many small execute calls. Search is for tool discovery; execute is for calling the chosen tools and doing orchestration in one program. If search already returned the needed tool names and schemas, do not keep searching or probe the repo; proceed with the single execute program.",
  {
    code: z
      .string()
      .min(1)
      .describe(
        "JavaScript async arrow function to execute. Prefer a single program that calls only the relevant Azure DevOps tools selected from MCP search, performs filtering/aggregation inside that one program, and only retries argument shapes inside that same program when necessary. Tool calls return `{ isError, text, structuredContent, data, content }`; prefer `data` for chaining."
      )
  },
  async ({ code }) => {
    executeSequence += 1;
    return contentText(
      await runExecute(
        codemode,
        code,
        `ado-codemode-mcp-execute-${String(executeSequence)}`,
        process.env.CODEMODE_SANDBOX_ENGINE ?? "podman"
      )
    );
  }
);

const transport = new StdioServerTransport();

async function main(): Promise<void> {
  await server.connect(transport);
}

void main().catch(async (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  await bridge.close();
  process.exit(1);
});

process.on("uncaughtException", async (error) => {
  process.stderr.write(
    `[ado-codemode-mcp] uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  await bridge.close();
  process.exit(1);
});

process.on("unhandledRejection", async (reason) => {
  process.stderr.write(
    `[ado-codemode-mcp] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`
  );
  await bridge.close();
  process.exit(1);
});

process.on("SIGINT", async () => {
  await bridge.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bridge.close();
  process.exit(0);
});
