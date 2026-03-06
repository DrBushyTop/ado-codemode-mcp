import {
  LocalStdioAzdoBridge,
  type AzureDevOpsServerCommand
} from "../../../packages/azdo-mcp-client/src/index.js";
import {
  readGatewayAzdoConfig,
  toAzureDevOpsServerCommand
} from "../../../packages/azdo-mcp-client/src/config.js";

function resolveCommand(): AzureDevOpsServerCommand {
  return toAzureDevOpsServerCommand(readGatewayAzdoConfig());
}

function usage(): string {
  return [
    "Usage:",
    "  bun run dev:bridge -- health",
    "  bun run dev:bridge -- list-tools",
    "  bun run dev:bridge -- call-tool <toolName> [jsonArgs]"
  ].join("\n");
}

async function main(): Promise<void> {
  const [command, toolName, jsonArgs] = process.argv.slice(2);
  const bridge = new LocalStdioAzdoBridge({ serverCommand: resolveCommand() });

  try {
    switch (command) {
      case "health": {
        process.stdout.write(`${JSON.stringify(await bridge.health(), null, 2)}\n`);
        break;
      }
      case "list-tools": {
        process.stdout.write(`${JSON.stringify(await bridge.listTools(), null, 2)}\n`);
        break;
      }
      case "call-tool": {
        if (!toolName) {
          throw new Error("call-tool requires a tool name argument.");
        }
        const args = jsonArgs
          ? (JSON.parse(jsonArgs) as Record<string, unknown>)
          : {};
        process.stdout.write(
          `${JSON.stringify(await bridge.callTool(toolName, args), null, 2)}\n`
        );
        break;
      }
      default:
        throw new Error(usage());
    }
  } finally {
    await bridge.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
