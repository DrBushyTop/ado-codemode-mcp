import { createCodeTool } from "@cloudflare/codemode/ai";
import { tool, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import type { ExecuteResult, Executor } from "@cloudflare/codemode";
import type { AzdoToolInfo } from "../../../packages/azdo-mcp-client/src/index.js";

export interface CapabilitySummary {
  helperModules?: string[];
  hostFunctions?: Array<{ name: string; description: string }>;
  safetyRules: string[];
  allowlist?: string[];
  executeInput: {
    code: string;
  };
  workflow?: string[];
}

export interface BridgeLike {
  listTools(): Promise<AzdoToolInfo[]>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface SearchResponse {
  result: unknown;
  error: string | null;
  logs: string[];
  code: string;
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
  allowedTools: AzdoToolInfo[],
  options: {
    includeAllowlist?: boolean;
    includeHelpers?: boolean;
  } = {}
): CapabilitySummary {
  const { includeAllowlist = false, includeHelpers = false } = options;

  const summary: CapabilitySummary = {
    safetyRules: [
      "Generated code runs inside the sandbox executor, not in the trusted host process.",
      "Azure DevOps credentials stay in the local bridge process started by the gateway.",
      "The default container launch uses --network=none and runsc.",
      "The callback channel is a bind-mounted per-run request/response directory."
    ],
    workflow: [
      "Call MCP search first to inspect the Azure DevOps tool catalog and choose the few relevant tool names for the task.",
      "Then call execute once with a single combined JavaScript program that uses only those relevant tool names.",
      "Avoid splitting one task across many top-level execute invocations.",
      "Inside that single execute call, use multiple Azure DevOps tool calls and do filtering, sorting, joins, and summarization in JavaScript."
    ],
    executeInput: {
      code: 'async () => { return codemode.azdoCallTool({ tool: "core_list_projects", args: {} }); }'
    }
  };

  if (includeHelpers) {
    summary.helperModules = ["codemode.azdoCallTool"];
    summary.hostFunctions = [
      {
        name: "codemode.azdoCallTool({ tool, args })",
        description: "Calls one Azure DevOps MCP tool by exact name through the trusted host bridge."
      }
    ];
  }

  if (includeAllowlist) {
    summary.allowlist = allowedTools.map((toolInfo) => toolInfo.name);
  }

  return summary;
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

export function createExecutionCodeTool(bridge: BridgeLike, executor: Executor) {
  return createCodeTool({
    tools: {
      azdoCallTool: tool({
        description:
          "Call one Azure DevOps MCP tool by exact tool name. Returns `{ isError, text, structuredContent, data, content }`, where `data` is normalized structured JSON when available and should be preferred for chaining multiple tool calls.",
        inputSchema: z.object({
          tool: z.string().describe("Exact Azure DevOps MCP tool name from the allowlist."),
          args: z.record(z.string(), z.unknown()).default({})
        }),
        execute: async ({ tool: toolName, args }) => bridge.callTool(toolName, args)
      })
    },
    executor,
    description: [
      "Execute JavaScript code through @cloudflare/codemode.",
      "Before execute, call the MCP search tool to inspect the Azure DevOps tool catalog and identify the few relevant tool names for the task.",
      "Do not try to discover tool names inside execute. Search is the discovery step; execute is the action/orchestration step.",
      "Available helpers:",
      "{{types}}",
      "Pass an async arrow function in JavaScript.",
      "Use only codemode.azdoCallTool({ tool, args }).",
      "Each Azure DevOps tool call returns `{ isError, text, structuredContent, data, content }`. Prefer `response.data`, then `response.structuredContent`, and only fall back to parsing `response.text` when needed.",
      "For tasks that need several Azure DevOps reads, combine them into one program and make multiple helper calls inside that single async function.",
      "Prefer one top-level execute call per user task. Do not break a single task into many execute calls unless you need a checkpoint or hit output limits.",
      "Within that one execute call, you may call several Azure DevOps tools and do filtering, sorting, joins, and summarization in JavaScript.",
      "Avoid splitting one task across multiple top-level execute invocations unless the result would exceed sandbox limits or you need a checkpoint between steps.",
      "Do lightweight filtering, aggregation, and formatting inside the single program instead of returning raw payloads from many separate execute calls.",
      "Do not attempt network access, shelling out, or arbitrary filesystem access.",
      "Return concise JSON-friendly data from the function."
    ].join("\n\n")
  });
}

export async function runSearch(
  bridge: BridgeLike,
  executor: Executor,
  code: string
): Promise<SearchResponse> {
  const allowedTools = await bridge.listTools();
  const wrappedCode = `async () => { const tools = await codemode.getTools({}); return await (${code})(tools); }`;
  const searchResult = await resolveToolExecution(
    executor.execute(wrappedCode, {
      getTools: async () => allowedTools
    })
  );

  const summary = buildCapabilitySummary(allowedTools, { includeHelpers: true });

  return {
    result: searchResult.result,
    error: searchResult.error ?? null,
    logs: searchResult.logs ?? [],
    code,
    workflow: summary.workflow,
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
