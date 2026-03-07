import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { GvisorContainerExecutor } from "./GvisorContainerExecutor.js";

test("flushPendingRequests retries partial callback files instead of crashing", async () => {
  const callbackDirectory = await mkdtemp(
    path.join(tmpdir(), "codemode-callback-test-")
  );
  const executor = new GvisorContainerExecutor({ engine: "process" });
  const state = {
    active: true,
    handledFiles: new Set<string>(),
    handledCount: 0
  };

  const requestPath = path.join(callbackDirectory, "req-1.request.json");
  await writeFile(requestPath, '{"id":"req-1","name":"demo","args":', "utf8");

  await (executor as any).flushPendingRequests(
    callbackDirectory,
    {
      demo: async (_args: unknown) => ({ ok: true })
    },
    state
  );

  assert.equal(state.handledCount, 0);
  assert.equal(state.handledFiles.size, 0);

  await writeFile(
    requestPath,
    JSON.stringify({ id: "req-1", name: "demo", args: { value: 1 } }),
    "utf8"
  );

  await (executor as any).flushPendingRequests(
    callbackDirectory,
    {
      demo: async (args: unknown) => args
    },
    state
  );

  assert.equal(state.handledCount, 1);
  assert.equal(state.handledFiles.has("req-1.request.json"), true);

  const responseText = await readFile(
    path.join(callbackDirectory, "req-1.response.json"),
    "utf8"
  );
  const response = JSON.parse(responseText);
  assert.deepEqual(response, {
    id: "req-1",
    result: { value: 1 }
  });
});
