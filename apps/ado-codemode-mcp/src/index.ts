import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { GvisorContainerExecutor } from "../../../packages/sandbox-executor/src/index.js";
import { createAzureDevOpsAuthProvider } from "./auth.js";
import { AzureDevOpsRestCatalog } from "./catalog.js";
import { readAzureDevOpsDirectConfig } from "./config.js";
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

function contentText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

const searchOutputSchema = z.object({
  result: z.unknown(),
  error: z.string().nullable(),
  logs: z.array(z.string()),
  code: z.string(),
  implicitContext: z
    .object({
      organization: z.literal("server-bound"),
      apiVersion: z.literal("defaulted-per-operation")
    })
    .optional(),
  workflow: z.array(z.string()).optional(),
  executeInput: z.object({
    code: z.string()
  })
});

const executeOutputSchema = z.object({
  result: z.unknown(),
  logs: z.array(z.string())
});

const config = readAzureDevOpsDirectConfig();
const authProvider = createAzureDevOpsAuthProvider(config);
const catalog = new AzureDevOpsRestCatalog({
  config,
  authProvider
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

if (timeoutMs !== undefined) executorOptions.timeoutMs = timeoutMs;
if (callbackTimeoutMs !== undefined)
  executorOptions.callbackTimeoutMs = callbackTimeoutMs;
if (maxLogBytes !== undefined) executorOptions.maxLogBytes = maxLogBytes;
if (maxResultBytes !== undefined) executorOptions.maxResultBytes = maxResultBytes;
if (maxCallbacks !== undefined) executorOptions.maxCallbacks = maxCallbacks;
if (process.env.CODEMODE_SANDBOX_IMAGE)
  executorOptions.image = process.env.CODEMODE_SANDBOX_IMAGE;
if (process.env.CODEMODE_SANDBOX_RUNTIME)
  executorOptions.runtime = process.env.CODEMODE_SANDBOX_RUNTIME;

const executor = new GvisorContainerExecutor(executorOptions);
const codemode = createExecutionCodeTool(catalog, executor);

const server = new McpServer({
  name: "ado-codemode-mcp",
  version: "0.2.0"
});

server.registerTool(
  "search",
  {
    description:
      "Search the Azure DevOps REST API catalog before execute. Pass a JavaScript async arrow function that receives sanitized `operations` metadata and returns the smallest useful subset for the task. The tool returns a structured envelope with your `result` plus server guidance in `implicitContext`, `workflow`, and `executeInput`.",
    inputSchema: {
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript async arrow function that receives the static Azure DevOps REST operation catalog as `operations` and returns the relevant subset or summary as `result`. Prefer one focused search that projects only the fields you need, such as `{ operationId, method, path, summary, description, parameters, bodyRequired, bodySchema, responseSchema, defaultApiVersion }`. The server will wrap that `result` together with `error`, `logs`, `implicitContext`, `workflow`, and `executeInput`. Example: async (operations) => operations.filter((op) => /projects_list|categorized_teams_get|wiql_query_by_wiql|work_items_get_work_items_batch/i.test(op.operationId)).map((op) => ({ operationId: op.operationId, method: op.method, path: op.path, summary: op.summary, parameters: op.parameters, bodyRequired: op.bodyRequired, bodySchema: op.bodySchema ?? null, responseSchema: op.responseSchema ?? null, defaultApiVersion: op.defaultApiVersion }))"
        )
    },
    outputSchema: searchOutputSchema
  },
  async ({ code }) => {
    const result = await runSearch(catalog, executor, code);
    return {
      structuredContent: result as unknown as Record<string, unknown>,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

if (exposeDebugTools) {
  server.registerTool(
    "list_capabilities",
    {
      description: "Describe the helper APIs, safety rules, and loaded Azure DevOps REST API catalog.",
      inputSchema: {}
    },
    async () => {
      const operations = await catalog.listOperations();
      return contentText({
        ...buildCapabilitySummary(operations),
        operationCount: operations.length,
        sampleOperationIds: operations.slice(0, 20).map((operation) => operation.operationId)
      });
    }
  );

  server.registerTool(
    "health",
    {
      description: "Return Azure DevOps direct client and sandbox configuration health.",
      inputSchema: {}
    },
    async () => {
      const operations = await catalog.listOperations();
      return contentText({
        azdo: {
          organization: config.organization,
          authentication: config.authentication,
          tenant: config.tenant ?? null,
          specRepoOwner: config.specRepoOwner,
          specRepoName: config.specRepoName,
          specRepoRef: config.specRepoRef,
          specAreas: config.specAreas ?? null,
          operationCount: operations.length
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

server.registerTool(
  "execute",
  {
    description:
      "Run a JavaScript program that calls Azure DevOps REST operations. First call MCP search to find the relevant operationIds, then use one combined execute program for the task instead of many small execute calls. Search is for API discovery; execute is for calling the chosen operations and orchestrating them in one program. The server already supplies organization and auth context, so do not inspect CLI defaults, local config, or environment variables. If the chosen operation path does not work, stop and report the blocker instead of falling back to other systems.",
    inputSchema: {
      code: z
        .string()
        .min(1)
        .describe(
          "JavaScript async arrow function to execute. Prefer a single program that calls only the relevant Azure DevOps operationIds selected from MCP search, performs filtering/aggregation inside that one program, and chains on `response.data` from previous calls. Do not pass `organization`; the server already binds it for every request. Do not probe globals or use raw `fetch`; use only `codemode.azdoRequest(...)`."
        )
    },
    outputSchema: executeOutputSchema
  },
  async ({ code }) => {
    executeSequence += 1;
    const result = await runExecute(
      codemode,
      code,
      `ado-codemode-mcp-execute-${String(executeSequence)}`
    );
    return {
      structuredContent: result as unknown as Record<string, unknown>,
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

const transport = new StdioServerTransport();

async function main(): Promise<void> {
  await server.connect(transport);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(
    `[ado-codemode-mcp] uncaughtException: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(
    `[ado-codemode-mcp] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`
  );
  process.exit(1);
});
