import test from "node:test";
import assert from "node:assert/strict";
import type { Executor } from "@cloudflare/codemode";
import {
  InlineExecutor,
  createExecutionCodeTool,
  runExecute,
  runSearch,
  type BridgeLike
} from "./logic.js";

function createBridge(): BridgeLike {
  return {
    async listTools() {
      return [
        {
          name: "core_list_projects",
          description: "List projects",
          inputSchema: {},
          outputSchema: { type: "array", items: { type: "object" } }
        },
        {
          name: "wit_get_query",
          description: "Get a work item query",
          inputSchema: {},
          outputSchema: { type: "object", properties: { id: { type: "string" } } }
        },
        {
          name: "search_workitem",
          description: "Search work items",
          inputSchema: {},
          outputSchema: { type: "object", properties: { count: { type: "number" } } }
        }
      ];
    },
    async callTool(toolName, args) {
      return { toolName, args };
    }
  };
}

test("runSearch returns evaluated catalog matches", async () => {
  const bridge = createBridge();
  const executor = new InlineExecutor();

  const result = await runSearch(
    bridge,
    executor,
    "async () => tools.filter((tool) => /project|work item|query/i.test(`${tool.name} ${tool.description}`)).map((tool) => tool.name)"
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.result, [
    "core_list_projects",
    "wit_get_query",
    "search_workitem"
  ]);
  assert.match(result.executeInput.code, /core_list_projects/);
});

test("runSearch can surface input and output schemas", async () => {
  const bridge = createBridge();
  const executor = new InlineExecutor();

  const result = await runSearch(
    bridge,
    executor,
    "async () => tools.filter((tool) => /project|query/i.test(`${tool.name} ${tool.description}`)).map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null }))"
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.result, [
    {
      name: "core_list_projects",
      inputSchema: {},
      outputSchema: { type: "array", items: { type: "object" } }
    },
    {
      name: "wit_get_query",
      inputSchema: {},
      outputSchema: { type: "object", properties: { id: { type: "string" } } }
    }
  ]);
});

test("runExecute exposes only azdoCallTool helper", async () => {
  const bridge = createBridge();
  const executor: Executor = new InlineExecutor();
  const codemode = createExecutionCodeTool(bridge, executor);

  const success = await runExecute(
    codemode,
    'async () => codemode.azdoCallTool({ tool: "core_list_projects", args: { top: 5 } })',
    "test-success",
    "process"
  );

  assert.deepEqual(success.result, {
    toolName: "core_list_projects",
    args: { top: 5 }
  });

  await assert.rejects(
    () =>
      runExecute(
        codemode,
        "async () => codemode.azdoListTools({})",
        "test-failure",
        "process"
      ),
    /codemode\.azdoListTools is not a function|Host function "azdoListTools" is not registered|Tool "azdoListTools" not found/
  );
});
