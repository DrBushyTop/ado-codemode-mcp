import assert from "node:assert/strict";
import { LocalStdioAzdoBridge } from "./index.js";

async function main(): Promise<void> {
  let connectCalls = 0;
  let callToolCalls = 0;
  let maxConcurrent = 0;
  let currentConcurrent = 0;

  const bridge = new LocalStdioAzdoBridge({
    serverCommand: {
      command: "npx",
      args: ["-y", "@azure-devops/mcp"]
    },
    clientFactory: async () => {
      connectCalls += 1;
      return {
        async callTool(args) {
          callToolCalls += 1;
          currentConcurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((resolve) => setTimeout(resolve, 20));
          currentConcurrent -= 1;
          return {
            isError: false,
            content: [{ type: "text", text: JSON.stringify({ ok: args.name }) }]
          };
        },
        async listTools() {
          return { tools: [] };
        },
        async close() {}
      };
    }
  });

  const results = await Promise.all([
    bridge.callTool("core_list_projects", {}),
    bridge.callTool("core_list_projects", {}),
    bridge.callTool("core_list_projects", {}),
    bridge.callTool("core_list_projects", {}),
    bridge.callTool("core_list_projects", {})
  ]);

  assert.equal(results.length, 5);
  assert.equal(connectCalls, 1);
  assert.equal(callToolCalls, 5);
  assert.equal(maxConcurrent, 1);

  console.log("bridge stress check passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
