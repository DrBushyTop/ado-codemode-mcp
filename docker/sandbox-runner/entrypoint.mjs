import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

function stringify(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function waitForResponse(responsePath, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const text = await readFile(responsePath, "utf8");
      return JSON.parse(text);
    } catch {
      await delay(25);
    }
  }

  throw new Error(`Timed out waiting for host callback response at ${responsePath}`);
}

async function main() {
  const jobPath = process.argv[2] ?? "/workspace/job.json";
  const workspaceRoot = path.dirname(jobPath);
  const job = JSON.parse(await readFile(jobPath, "utf8"));
  const callbackDirectory = path.join(workspaceRoot, job.callbackDirectory);
  const resultPath = path.join(workspaceRoot, job.resultFile);

  const logs = [];
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error
  };

  function pushLog(prefix, values) {
    const line = `${prefix}${values.map((value) => stringify(value)).join(" ")}`;
    logs.push(line);

    const currentSize = Buffer.byteLength(logs.join("\n"), "utf8");
    if (currentSize > job.maxLogBytes) {
      logs.splice(0, logs.length, ...logs.join("\n").slice(0, job.maxLogBytes).split("\n"));
      logs.push("[logs truncated inside sandbox runner]");
    }
  }

  console.log = (...values) => pushLog("", values);
  console.warn = (...values) => pushLog("[warn] ", values);
  console.error = (...values) => pushLog("[error] ", values);

  async function hostCall(name, args) {
    const id = randomUUID();
    const requestPath = path.join(callbackDirectory, `${id}.request.json`);
    const responsePath = path.join(callbackDirectory, `${id}.response.json`);

    await writeFile(
      requestPath,
      JSON.stringify({ id, name, args }),
      "utf8"
    );

    const response = await waitForResponse(responsePath, job.callbackTimeoutMs);
    if (response.error) {
      throw new Error(response.error);
    }

    return response.result;
  }

  const codemode = new Proxy(
    {},
    {
      get(_target, property) {
        return async (args) => hostCall(String(property), args ?? {});
      }
    }
  );

  let payload;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const runner = new AsyncFunction(
      "codemode",
      `return await (${job.code})()`
    );

    const result = await runner(codemode);
    payload = { result, logs };
  } catch (error) {
    payload = {
      result: undefined,
      error: error instanceof Error ? error.message : String(error),
      logs
    };
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
  }

  await writeFile(resultPath, JSON.stringify(payload), "utf8");
}

main().catch(async (error) => {
  const resultPath = process.argv[2]
    ? path.join(path.dirname(process.argv[2]), "result.json")
    : "/workspace/result.json";

  await writeFile(
    resultPath,
    JSON.stringify({
      result: undefined,
      error: error instanceof Error ? error.message : String(error),
      logs: []
    }),
    "utf8"
  );
  process.exit(1);
});
