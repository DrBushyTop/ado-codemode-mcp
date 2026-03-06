import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { tool, type ToolExecutionOptions } from "ai";
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

let executeSequence = 0;
const exposeDebugTools = process.env.ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS === "1";

interface CapabilitySummary {
  helperModules: string[];
  hostFunctions: Array<{ name: string; description: string }>;
  safetyRules: string[];
  allowlist: string[];
  executeInput: {
    code: string;
  };
  matchingTools?: AzdoToolInfo[];
}

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

function buildCapabilitySummary(
  allowedTools: AzdoToolInfo[],
  query?: string
): CapabilitySummary {
  const normalizedQuery = query?.trim().toLowerCase();
  const matchingTools = normalizedQuery
    ? allowedTools.filter((toolInfo) => {
        const haystack = `${toolInfo.name} ${toolInfo.description}`.toLowerCase();
        return normalizedQuery
          .split(/\s+/)
          .every((part) => haystack.includes(part));
      })
    : undefined;

  const summary: CapabilitySummary = {
    helperModules: ["codemode.azdoListTools", "codemode.azdoCallTool"],
    hostFunctions: [
      {
        name: "codemode.azdoListTools({})",
        description: "Returns the read-only Azure DevOps MCP tools exposed through the trusted host bridge."
      },
      {
        name: "codemode.azdoCallTool({ tool, args })",
        description: "Invokes one allowlisted Azure DevOps MCP tool through the host bridge."
      }
    ],
    safetyRules: [
      "Generated code runs inside the sandbox executor, not in the trusted host process.",
      "Azure DevOps credentials stay in the local bridge process started by the gateway.",
      DEFAULT_ALLOWED_TOOLS
        ? "Only allowlisted Azure DevOps tools are exposed through the bridge."
        : "All Azure DevOps MCP tools exposed by the host bridge are available.",
      "The default container launch uses --network=none and runsc.",
      "The callback channel is a bind-mounted per-run request/response directory."
    ],
    allowlist: allowedTools.map((toolInfo) => toolInfo.name),
    executeInput: {
      code: 'async () => { const tools = await codemode.azdoListTools({}); return tools.slice(0, 3).map((tool) => tool.name); }'
    }
  };

  if (matchingTools) {
    summary.matchingTools = matchingTools;
  }

  return summary;
}
function contentText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

async function resolveToolExecution<T>(
  value: PromiseLike<T> | AsyncIterable<T> | T
): Promise<T> {
  if (
    value &&
    typeof value === "object" &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  ) {
    let lastValue: T | undefined;
    for await (const chunk of value as AsyncIterable<T>) {
      lastValue = chunk;
    }

    if (lastValue === undefined) {
      throw new Error("Code Mode execution produced no result.");
    }

    return lastValue;
  }

  return (await value) as T;
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
const gatewayTools = {
  azdoListTools: tool({
    description:
      "List the read-only Azure DevOps tools exposed through the trusted host bridge.",
    inputSchema: z.object({}),
    execute: async () => bridge.listTools()
  }),
  azdoCallTool: tool({
    description:
      "Call one allowlisted Azure DevOps MCP tool through the trusted host bridge.",
    inputSchema: z.object({
      tool: z.string().describe("Exact Azure DevOps MCP tool name from the allowlist."),
      args: z.record(z.string(), z.unknown()).default({})
    }),
    execute: async ({ tool: toolName, args }) => bridge.callTool(toolName, args)
  })
};
const codemode = createCodeTool({
  tools: gatewayTools,
  executor,
  description: [
    "Execute JavaScript code through @cloudflare/codemode.",
    "Available helpers:",
    "{{types}}",
    "Pass an async arrow function in JavaScript.",
    "Use only codemode.azdoListTools({}) and codemode.azdoCallTool({ tool, args }).",
    "For tasks that need several Azure DevOps reads, combine them into one program and make multiple helper calls inside that single async function.",
    "Avoid splitting one task across multiple top-level execute invocations unless the result would exceed sandbox limits or you need a checkpoint between steps.",
    "Do lightweight filtering, aggregation, and formatting inside the single program instead of returning raw payloads from many separate execute calls.",
    "Do not attempt network access, shelling out, or arbitrary filesystem access.",
    "Return concise JSON-friendly data from the function."
  ].join("\n\n")
});

const server = new McpServer({
  name: "ado-codemode-mcp",
  version: "0.1.0"
});

server.tool(
  "search",
  "Return the helper APIs and Azure DevOps capability surface exposed to sandboxed generated code. Use this to discover which host helpers and MCP tool names to call from one combined execute program.",
  {
    query: z.string().min(1).describe("Keywords to match against the allowlisted Azure DevOps capability surface.")
  },
  async ({ query }) => {
    const allowedTools = await bridge.listTools();
    return contentText(buildCapabilitySummary(allowedTools, query));
  }
);

if (exposeDebugTools) {
  server.tool(
    "list_capabilities",
    "Describe the helper APIs, safety rules, and Azure DevOps tool surface exposed by the gateway.",
    {},
    async () => {
      const allowedTools = await bridge.listTools();
      return contentText(buildCapabilitySummary(allowedTools));
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
  "Execute JavaScript through @cloudflare/codemode using the sandbox executor and trusted Azure DevOps host bridge. Prefer one combined program that makes multiple helper calls inside a single execute invocation when a task needs several Azure DevOps reads or writes.",
  {
    code: z
      .string()
      .min(1)
      .describe(
        "JavaScript async arrow function to execute, for example async () => { const tools = await codemode.azdoListTools({}); return tools; }"
      )
  },
  async ({ code }) => {
    if (!codemode.execute) {
      throw new Error("Code Mode execute handler is not available.");
    }

    executeSequence += 1;
    const executionOptions: ToolExecutionOptions = {
      toolCallId: `ado-codemode-mcp-execute-${String(executeSequence)}`,
      messages: []
    };
    const result = await resolveToolExecution(
      codemode.execute({ code }, executionOptions)
    );

    return contentText({
      result: result.result,
      logs: result.logs ?? [],
      code: result.code,
      sandboxEngine: process.env.CODEMODE_SANDBOX_ENGINE ?? "podman"
    });
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

process.on("SIGINT", async () => {
  await bridge.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bridge.close();
  process.exit(0);
});
