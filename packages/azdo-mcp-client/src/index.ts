import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export interface AzureDevOpsServerCommand {
  command: string;
  args: string[];
}

export interface AzdoToolInfo {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
}

export interface AzdoToolCallResponse {
  isError: boolean;
  text: string;
  structuredContent?: unknown;
  data?: unknown;
  content: unknown;
}

export interface AzdoBridgeHealth {
  ok: boolean;
  connected: boolean;
  command?: AzureDevOpsServerCommand;
  toolCount?: number;
  error?: string;
}

export interface AzdoBridgeOptions {
  serverCommand: AzureDevOpsServerCommand;
  allowedTools?: readonly string[];
  clientFactory?: () => Promise<AzdoClient>;
}

interface AzdoClient {
  callTool(args: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
  listTools(): Promise<{ tools: Tool[] }>;
  close(): Promise<void>;
}

export const DEFAULT_ALLOWED_TOOLS: readonly string[] | undefined = undefined;

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function isReconnectableError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "connection closed",
    "not connected",
    "transport closed",
    "transport disconnected",
    "socket hang up",
    "epipe",
    "econnreset",
    "session closed"
  ].some((fragment) => message.includes(fragment));
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return "";
  }

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        Boolean(
          item &&
            typeof item === "object" &&
            "type" in item &&
            "text" in item &&
            (item as { type?: unknown }).type === "text" &&
            typeof (item as { text?: unknown }).text === "string"
        )
    )
    .map((item) => item.text)
    .join("\n\n");
}

function asToolResult(result: unknown): {
  isError?: boolean;
  structuredContent?: unknown;
  content?: unknown;
} {
  return (result ?? {}) as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: unknown;
  };
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function normalizeToolData(result: {
  structuredContent?: unknown;
  content?: unknown;
}): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const text = toolText(result);
  return parseJsonText(text);
}

function redactSecrets(input: string): string {
  return input
    .replace(/([A-Za-z0-9]{20,})/g, (value) => {
      if (value.startsWith("https")) {
        return value;
      }

      return `${value.slice(0, 4)}...${value.slice(-4)}`;
    })
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
}

function safeEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

export class LocalStdioAzdoBridge {
  private readonly command: AzureDevOpsServerCommand;
  private readonly allowedTools: Set<string> | undefined;
  private readonly clientFactory: (() => Promise<AzdoClient>) | undefined;
  private client: AzdoClient | undefined;
  private toolsCache: Tool[] | undefined;
  private operationChain: Promise<void> = Promise.resolve();

  constructor(options: AzdoBridgeOptions) {
    this.command = options.serverCommand;
    this.allowedTools = options.allowedTools
      ? new Set(options.allowedTools)
      : DEFAULT_ALLOWED_TOOLS
        ? new Set(DEFAULT_ALLOWED_TOOLS)
        : undefined;
    this.clientFactory = options.clientFactory;
  }

  async listTools(): Promise<AzdoToolInfo[]> {
    return this.runSerialized(async () => {
      const tools = await this.getAllowedTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        outputSchema: "outputSchema" in tool ? tool.outputSchema : undefined
      }));
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<AzdoToolCallResponse> {
    if (this.allowedTools && !this.allowedTools.has(name)) {
      throw new Error(`Azure DevOps tool "${name}" is not in the allowlist.`);
    }

    return this.runSerialized(async () => {
      try {
        const client = await this.getClient();
        const result = asToolResult(
          await client.callTool({
            name,
            arguments: args
          })
        );

        return {
          isError: Boolean(result.isError),
          text: toolText(result),
          structuredContent: result.structuredContent,
          data: normalizeToolData(result),
          content: result.content
        };
      } catch (error) {
        if (isReconnectableError(error)) {
          await this.resetConnection();
          try {
            const client = await this.getClient();
            const result = asToolResult(
              await client.callTool({
                name,
                arguments: args
              })
            );

            return {
              isError: Boolean(result.isError),
              text: toolText(result),
              structuredContent: result.structuredContent,
              data: normalizeToolData(result),
              content: result.content
            };
          } catch (retryError) {
            throw new Error(errorMessage(retryError));
          }
        }

        throw new Error(errorMessage(error));
      }
    });
  }

  async health(): Promise<AzdoBridgeHealth> {
    return this.runSerialized(async () => {
      try {
        const tools = await this.getAllowedTools();
        return {
          ok: true,
          connected: true,
          command: this.command,
          toolCount: tools.length
        };
      } catch (error) {
        return {
          ok: false,
          connected: false,
          command: this.command,
          error: redactSecrets(error instanceof Error ? error.message : String(error))
        };
      }
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.toolsCache = undefined;

    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close failures while tearing down a broken stdio session.
      }
    }
  }

  private async getAllowedTools(): Promise<Tool[]> {
    if (!this.toolsCache) {
      try {
        const client = await this.getClient();
        const response = await client.listTools();
        this.toolsCache = response.tools;
      } catch (error) {
        if (!isReconnectableError(error)) {
          throw error;
        }

        await this.resetConnection();
        const client = await this.getClient();
        const response = await client.listTools();
        this.toolsCache = response.tools;
      }
    }

    return this.allowedTools
      ? this.toolsCache.filter((tool) => this.allowedTools?.has(tool.name))
      : this.toolsCache;
  }

  private async getClient(): Promise<AzdoClient> {
    if (this.client) {
      return this.client;
    }

    if (this.clientFactory) {
      const client = await this.clientFactory();
      this.client = client;
      return client;
    }

    const client = new Client({
      name: "codemode-azdo-bridge",
      version: "0.1.0"
    });
    const transport = new StdioClientTransport({
      command: this.command.command,
      args: this.command.args,
      env: safeEnv()
    });

    await client.connect(transport);

    this.client = client as unknown as AzdoClient;
    return client;
  }

  private async resetConnection(): Promise<void> {
    await this.close();
  }

  private async runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChain;
    let release!: () => void;
    this.operationChain = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release();
    }
  }
}
