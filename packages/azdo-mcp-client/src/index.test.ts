import test from "node:test";
import assert from "node:assert/strict";
import { LocalStdioAzdoBridge } from "./index.js";

test("listTools surfaces outputSchema metadata", async () => {
  const bridge = new LocalStdioAzdoBridge({
    serverCommand: { command: "test", args: [] },
    clientFactory: async () => ({
      async callTool() {
        throw new Error("not needed");
      },
      async listTools() {
        return {
          tools: [
            {
              name: "core_list_projects",
              description: "List projects",
              inputSchema: { type: "object" },
              outputSchema: { type: "object", properties: { items: { type: "array" } } }
            }
          ]
        };
      },
      async close() {}
    })
  });

  const tools = await bridge.listTools();
  assert.deepEqual(tools, [
    {
      name: "core_list_projects",
      description: "List projects",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { items: { type: "array" } } }
    }
  ]);
});

test("callTool normalizes JSON text into data", async () => {
  const bridge = new LocalStdioAzdoBridge({
    serverCommand: { command: "test", args: [] },
    clientFactory: async () => ({
      async callTool() {
        return {
          content: [{ type: "text", text: JSON.stringify({ items: [{ id: 1 }], count: 1 }) }]
        };
      },
      async listTools() {
        return {
          tools: [
            {
              name: "core_list_projects",
              description: "List projects",
              inputSchema: { type: "object" }
            }
          ]
        };
      },
      async close() {}
    })
  });

  const result = await bridge.callTool("core_list_projects", {});
  assert.deepEqual(result.data, { items: [{ id: 1 }], count: 1 });
  assert.equal(result.text, '{"items":[{"id":1}],"count":1}');
});

test("callTool prefers structuredContent when available", async () => {
  const bridge = new LocalStdioAzdoBridge({
    serverCommand: { command: "test", args: [] },
    clientFactory: async () => ({
      async callTool() {
        return {
          structuredContent: { items: [{ id: 2 }], count: 1 },
          content: [{ type: "text", text: "ignored" }]
        };
      },
      async listTools() {
        return {
          tools: [
            {
              name: "core_list_projects",
              description: "List projects",
              inputSchema: { type: "object" }
            }
          ]
        };
      },
      async close() {}
    })
  });

  const result = await bridge.callTool("core_list_projects", {});
  assert.deepEqual(result.data, { items: [{ id: 2 }], count: 1 });
  assert.deepEqual(result.structuredContent, { items: [{ id: 2 }], count: 1 });
});
