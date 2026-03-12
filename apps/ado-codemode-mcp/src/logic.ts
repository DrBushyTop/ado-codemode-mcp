import type { ExecuteResult, Executor } from "@cloudflare/codemode";
import { createCodeTool } from "@cloudflare/codemode/ai";
import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type {
  AzureDevOpsApiCaller,
  AzureDevOpsApiOperation,
  AzureDevOpsApiResponse,
  AzureDevOpsSearchOperation
} from "./catalog.js";
import { toSearchOperation } from "./catalog.js";

export interface CapabilitySummary {
  helperModules?: string[];
  hostFunctions?: Array<{ name: string; description: string }>;
  safetyRules: string[];
  executeInput: {
    code: string;
  };
  workflow?: string[];
}

export interface SearchResponse {
  result: unknown;
  error: string | null;
  logs: string[];
  code: string;
  implicitContext?: {
    organization: "server-bound";
    apiVersion: "defaulted-per-operation";
  };
  workflow?: string[] | undefined;
  executeInput: {
    code: string;
  };
}

export interface ExecuteResponse {
  result: unknown;
  logs: string[];
  code: string;
  sandboxEngine: string;
}

export function buildCapabilitySummary(
  operations: AzureDevOpsApiOperation[]
): CapabilitySummary {
  const exampleOperation =
    operations.find((operation) => operation.operationId === "Projects_List")
      ?.operationId ?? operations[0]?.operationId ?? "Projects_List";

  return {
    safetyRules: [
      "Generated code runs inside the sandbox executor, not in the trusted host process.",
      "Azure DevOps credentials stay in the trusted host process.",
      "Search works against a static Azure DevOps REST API catalog built from official Swagger specs.",
      "Execute performs authenticated Azure DevOps REST requests through a single host helper.",
      "The server already binds the Azure DevOps organization and default api-version handling."
    ],
    workflow: [
      "Call MCP search once first to narrow the smallest useful set of operationIds for the task.",
      "Then call execute once with a single combined JavaScript program that uses only those operationIds.",
      "Avoid splitting one task across many top-level execute invocations.",
      "Inside the single execute call, chain requests through response.data and do filtering, joins, and summarization in JavaScript.",
      "Do not inspect local config, environment variables, or CLI defaults; server-bound context is already applied."
    ],
    executeInput: {
      code: `async () => codemode.azdoRequest({ operationId: "${exampleOperation}", pathParams: {}, query: {} })`
    },
    helperModules: ["codemode.azdoRequest"],
    hostFunctions: [
      {
        name: "codemode.azdoRequest({ operationId, pathParams, query, headers, body, apiVersion })",
        description:
          "Calls one Azure DevOps REST operation by operationId. The server already provides the organization and default api-version handling, so only pass the remaining path/query/body inputs for the chosen operation. Returns `{ ok, status, statusText, url, operationId, headers, data, text }`. Prefer `data` for chaining."
      }
    ]
  };
}

function searchCatalogNote(operations: AzureDevOpsSearchOperation[]): string[] {
  const operationsWithPathParams = operations.some(
    (operation) => operation.parameters.some((parameter) => parameter.in === "path")
  );
  const operationsWithBodies = operations.some((operation) => operation.bodySchema !== undefined);
  const operationsWithSchemas = operations.some(
    (operation) => operation.responseSchema !== undefined
  );

  return [
    "Search receives sanitized operations: organization and default api-version are already bound by the server and omitted from visible parameters.",
    operationsWithPathParams
      ? "If an operation still shows required path parameters, discover and provide only those remaining values."
      : "Focus on query/body inputs; server-bound path context has already been applied.",
    operationsWithBodies
      ? "If an operation has a bodySchema, use that schema directly instead of guessing payload shape."
      : "Prefer operations that do not require request bodies when they are sufficient for the task.",
    operationsWithSchemas
      ? "Use responseSchema to plan chaining and prefer response.data for later calls."
      : "If responseSchema is absent, rely on response.data structure from earlier calls before broadening search."
  ];
}

export async function resolveToolExecution<T>(
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

export function createExecutionCodeTool(
  caller: AzureDevOpsApiCaller,
  executor: Executor
) {
  return createCodeTool({
    tools: {
      azdoRequest: tool({
        description:
          "Call one Azure DevOps REST operation by exact operationId. The server already binds organization and auth, so pass only the remaining path/query/body inputs. Returns `{ ok, status, statusText, url, operationId, headers, data, text }`; prefer `data` for chaining.",
        inputSchema: z.object({
          operationId: z.string().describe("Exact Azure DevOps REST operationId chosen from MCP search."),
          pathParams: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .default({})
            .describe("Only the non-server-bound path params for the chosen operation. Do not include organization."),
          query: z
            .record(z.string(), z.unknown())
            .default({})
            .describe("Query parameters for the chosen operation, excluding the default api-version unless you intentionally need to override it."),
          headers: z.record(z.string(), z.string()).default({}),
          body: z.unknown().optional(),
          apiVersion: z.string().optional()
        }),
        execute: async (input) => caller.callOperation(input)
      })
    },
    executor,
    description: [
      "Run JavaScript to orchestrate Azure DevOps REST API operations.",
      "Before execute, call the MCP search tool to inspect the Azure DevOps REST API catalog and identify the few relevant operationIds for the task.",
      "Do not try to rediscover the API surface inside execute. Search is the discovery step; execute is the orchestration step.",
      "Available helpers:",
      "{{types}}",
      "Pass an async arrow function in JavaScript.",
      "Use only codemode.azdoRequest({ operationId, pathParams, query, headers, body, apiVersion }).",
      "Each request returns `{ ok, status, statusText, url, operationId, headers, data, text }`. Prefer `response.data`, and only fall back to `response.text` if the endpoint is not JSON.",
      "For tasks that need several Azure DevOps reads or writes, combine them into one program and chain data from earlier calls into later ones.",
      "Prefer one top-level execute call per user task. Do not break a single task into many execute calls unless you need a checkpoint or hit output limits.",
      "Do lightweight filtering, aggregation, and formatting inside that one program instead of returning raw payloads from many separate execute calls.",
      "Do not probe globals, inspect the runtime environment, or use raw fetch. Use only the provided Azure DevOps request helper for external data.",
      "Do not inspect repo files or local config when the Azure DevOps API path is already available.",
      "Do not attempt shelling out or arbitrary filesystem access.",
      "Return concise JSON-friendly data from the function."
    ].join("\n\n")
  });
}

export async function runSearch(
  caller: AzureDevOpsApiCaller,
  executor: Executor,
  code: string
): Promise<SearchResponse> {
  const operations = await caller.listOperations();
  const searchOperations = await caller.listSearchOperations();
  const wrappedCode = `async () => { const operations = await codemode.getOperations({}); return await (${code})(operations); }`;
  const searchResult = await resolveToolExecution(
    executor.execute(wrappedCode, {
      getOperations: async () => searchOperations
    })
  );

  const summary = buildCapabilitySummary(operations);

  return {
    result: searchResult.result,
    error: searchResult.error ?? null,
    logs: searchResult.logs ?? [],
    code,
    implicitContext: {
      organization: "server-bound",
      apiVersion: "defaulted-per-operation"
    },
    workflow: [...(summary.workflow ?? []), ...searchCatalogNote(searchOperations)],
    executeInput: summary.executeInput
  };
}

export async function runExecute(
  codemode: ReturnType<typeof createExecutionCodeTool>,
  code: string,
  toolCallId: string,
  sandboxEngine: string
): Promise<ExecuteResponse> {
  if (!codemode.execute) {
    throw new Error("Code Mode execute handler is not available.");
  }

  const executionOptions: ToolExecutionOptions = {
    toolCallId,
    messages: []
  };
  const result = await resolveToolExecution(
    codemode.execute({ code }, executionOptions)
  );

  return {
    result: result.result,
    logs: result.logs ?? [],
    code: result.code,
    sandboxEngine
  };
}

export class InlineExecutor implements Executor {
  async execute(
    code: string,
    fns: Record<string, (...args: unknown[]) => Promise<unknown>>
  ): Promise<ExecuteResult> {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
      ...args: string[]
    ) => (...values: unknown[]) => Promise<unknown>;

    try {
      const fn = new AsyncFunction(
        "codemode",
        `return await (${code})()`
      ) as (codemode: Record<string, (...args: unknown[]) => Promise<unknown>>) => Promise<unknown>;
      const result = await fn(fns);
      return { result, logs: [] };
    } catch (error) {
      return {
        result: undefined,
        error: error instanceof Error ? error.message : String(error),
        logs: []
      };
    }
  }
}

export class FakeApiCaller implements AzureDevOpsApiCaller {
  constructor(
    private readonly operations: AzureDevOpsApiOperation[],
    private readonly responseFactory: (input: {
      operationId: string;
      pathParams?: Record<string, string | number | boolean>;
      query?: Record<string, unknown>;
      headers?: Record<string, string>;
      body?: unknown;
      apiVersion?: string;
    }) => Promise<AzureDevOpsApiResponse>
  ) {}

  async listOperations(): Promise<AzureDevOpsApiOperation[]> {
    return this.operations;
  }

  async listSearchOperations(): Promise<AzureDevOpsSearchOperation[]> {
    return this.operations
      .filter((operation) => operation.method !== "HEAD" && operation.method !== "OPTIONS")
      .map((operation) => toSearchOperation(operation));
  }

  async callOperation(input: {
    operationId: string;
    pathParams?: Record<string, string | number | boolean>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    apiVersion?: string;
  }): Promise<AzureDevOpsApiResponse> {
    return this.responseFactory(input);
  }
}
