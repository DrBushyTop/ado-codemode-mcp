import type { AzureDevOpsAuthProvider } from "./auth.js";
import type { AzureDevOpsDirectConfig } from "./config.js";

type HttpMethod =
  | "get"
  | "put"
  | "post"
  | "delete"
  | "options"
  | "head"
  | "patch";

interface GitTreeResponse {
  tree: Array<{ path: string; type: string }>;
}

interface SwaggerSpec {
  swagger?: string;
  info?: { title?: string; version?: string };
  host?: string;
  basePath?: string;
  paths?: Record<string, SwaggerPathItem>;
  parameters?: Record<string, SwaggerParameter>;
  definitions?: Record<string, unknown>;
}

interface SwaggerPathItem {
  parameters?: SwaggerParameterOrRef[];
  get?: SwaggerOperation;
  put?: SwaggerOperation;
  post?: SwaggerOperation;
  delete?: SwaggerOperation;
  options?: SwaggerOperation;
  head?: SwaggerOperation;
  patch?: SwaggerOperation;
}

interface SwaggerOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: SwaggerParameterOrRef[];
  responses?: Record<string, SwaggerResponse>;
  consumes?: string[];
  produces?: string[];
  security?: Array<Record<string, string[]>>;
  "x-ms-docs-override-version"?: string;
  "x-ms-preview"?: boolean;
}

interface SwaggerResponse {
  description?: string;
  schema?: unknown;
  "$ref"?: string;
}

interface SwaggerParameter {
  name?: string;
  in?: string;
  description?: string;
  required?: boolean;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  schema?: unknown;
  items?: unknown;
  collectionFormat?: string;
}

type SwaggerParameterOrRef = SwaggerParameter | { $ref: string };

export interface ApiParameterDescriptor {
  name: string;
  in: string;
  description: string;
  required: boolean;
  type?: string | undefined;
  format?: string | undefined;
  enum?: unknown[] | undefined;
  default?: unknown;
  schema?: unknown;
  items?: unknown;
  collectionFormat?: string | undefined;
}

export interface AzureDevOpsApiOperation {
  operationId: string;
  rawOperationId: string;
  displayName: string;
  area: string;
  specFile: string;
  specVersion: string;
  host: string;
  basePath: string;
  method: Uppercase<HttpMethod>;
  path: string;
  summary: string;
  description: string;
  tags: string[];
  preview: boolean;
  apiVersion: string;
  consumes: string[];
  produces: string[];
  parameters: ApiParameterDescriptor[];
  requestBody?: ApiParameterDescriptor | undefined;
  responseSchema?: unknown;
  responseDescription?: string | undefined;
  securityScopes: string[];
}

export interface AzureDevOpsSearchOperation {
  operationId: string;
  rawOperationId: string;
  summary: string;
  method: Uppercase<HttpMethod>;
  path: string;
  description: string;
  area: string;
  tags: string[];
  preview: boolean;
  parameters: ApiParameterDescriptor[];
  bodyRequired: boolean;
  bodyDescription?: string | undefined;
  bodySchema?: unknown;
  responseSchema?: unknown;
  responseDescription?: string | undefined;
  defaultApiVersion: string;
  consumes: string[];
  produces: string[];
  specVersion: string;
  implicitPathParams: string[];
  implicitQueryParams: string[];
}

export interface AzureDevOpsApiResponse {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  operationId: string;
  headers: Record<string, string>;
  data?: unknown;
  text?: string | undefined;
}

export interface AzureDevOpsApiCaller {
  listOperations(): Promise<AzureDevOpsApiOperation[]>;
  listSearchOperations(): Promise<AzureDevOpsSearchOperation[]>;
  callOperation(input: {
    operationId: string;
    pathParams?: Record<string, string | number | boolean>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    apiVersion?: string | undefined;
  }): Promise<AzureDevOpsApiResponse>;
}

interface RepoFileSelection {
  area: string;
  version: string;
  path: string;
}

function canonicalizeOperationId(value: string): string {
  const normalized = value
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return normalized || "Unknown_Operation";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

function encodePathValue(value: string | number | boolean): string {
  return encodeURIComponent(String(value)).replace(/%2F/g, "/");
}

function normalizeSchema(
  spec: SwaggerSpec,
  value: unknown,
  depth = 0
): unknown {
  if (depth > 6 || value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSchema(spec, entry, depth + 1));
  }

  if (typeof value !== "object") {
    return value;
  }

  if ("$ref" in value && typeof value.$ref === "string") {
    return normalizeSchema(spec, resolveReference(spec, value.$ref), depth + 1);
  }

  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      normalizeSchema(spec, entry, depth + 1)
    ])
  );
}

function summarizeSchema(value: unknown, depth = 0): unknown {
  if (depth > 2 || value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 5).map((entry) => summarizeSchema(entry, depth + 1));
  }

  if (typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const [key, entry] of Object.entries(record)) {
    if (
      key === "description" ||
      key === "format" ||
      key === "enum" ||
      key === "type" ||
      key === "required" ||
      key === "default" ||
      key === "example" ||
      key === "examples"
    ) {
      summary[key] = summarizeSchema(entry, depth + 1);
      continue;
    }

    if (key === "properties" && entry && typeof entry === "object") {
      const propertyEntries = Object.entries(entry as Record<string, unknown>).slice(0, 12);
      summary[key] = Object.fromEntries(
        propertyEntries.map(([propertyKey, propertyValue]) => [
          propertyKey,
          summarizeSchema(propertyValue, depth + 1)
        ])
      );
      continue;
    }

    if (key === "items") {
      summary[key] = summarizeSchema(entry, depth + 1);
      continue;
    }

    if (
      (key === "oneOf" || key === "anyOf" || key === "allOf") &&
      Array.isArray(entry)
    ) {
      summary[key] = entry
        .slice(0, 5)
        .map((option) => summarizeSchema(option, depth + 1));
      continue;
    }

    if (key === "additionalProperties") {
      summary[key] =
        typeof entry === "boolean" ? entry : summarizeSchema(entry, depth + 1);
    }
  }

  return summary;
}

function resolveReference(spec: SwaggerSpec, ref: string): unknown {
  if (!ref.startsWith("#/")) {
    return { $ref: ref };
  }

  const parts = ref
    .slice(2)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));

  let current: unknown = spec as unknown;
  for (const part of parts) {
    if (!current || typeof current !== "object") {
      return { $ref: ref };
    }

    current = (current as Record<string, unknown>)[part];
  }

  return current ?? { $ref: ref };
}

function resolveParameter(
  spec: SwaggerSpec,
  parameter: SwaggerParameterOrRef
): SwaggerParameter {
  if ("$ref" in parameter && typeof parameter.$ref === "string") {
    return resolveReference(spec, parameter.$ref) as SwaggerParameter;
  }

  return parameter as SwaggerParameter;
}

function extractSuccessResponse(
  spec: SwaggerSpec,
  operation: SwaggerOperation
): { schema?: unknown; description?: string } {
  const responses = operation.responses ?? {};
  const successKey = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort()[0];

  if (!successKey) {
    return {};
  }

  const response = responses[successKey];
  if (response?.$ref) {
    const resolved = resolveReference(spec, response.$ref) as SwaggerResponse;
    const output: { schema?: unknown; description?: string } = {};
    output.schema = normalizeSchema(spec, resolved.schema);
    const description = resolved.description ?? response.description;
    if (description) {
      output.description = description;
    }
    return output;
  }

  const output: { schema?: unknown; description?: string } = {};
  output.schema = normalizeSchema(spec, response?.schema);
  if (response?.description) {
    output.description = response.description;
  }
  return output;
}

function normalizeParameterDescriptor(
  spec: SwaggerSpec,
  parameter: SwaggerParameter
): ApiParameterDescriptor {
  const descriptor: ApiParameterDescriptor = {
    name: parameter.name ?? "",
    in: parameter.in ?? "query",
    description: parameter.description ?? "",
    required: Boolean(parameter.required)
  };

  if (parameter.type !== undefined) descriptor.type = parameter.type;
  if (parameter.format !== undefined) descriptor.format = parameter.format;
  if (parameter.enum !== undefined) descriptor.enum = parameter.enum;
  if (parameter.default !== undefined) descriptor.default = parameter.default;
  if (parameter.schema !== undefined)
    descriptor.schema = normalizeSchema(spec, parameter.schema);
  if (parameter.items !== undefined)
    descriptor.items = normalizeSchema(spec, parameter.items);
  if (parameter.collectionFormat !== undefined)
    descriptor.collectionFormat = parameter.collectionFormat;

  return descriptor;
}

export function extractOperationsFromSpec(
  specFile: string,
  spec: SwaggerSpec
): AzureDevOpsApiOperation[] {
  const methods: HttpMethod[] = [
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch"
  ];
  const operations: AzureDevOpsApiOperation[] = [];
  const paths = spec.paths ?? {};
  const area = specFile.split("/")[1] ?? "unknown";

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }

      const mergedParameters = [
        ...(pathItem.parameters ?? []),
        ...(operation.parameters ?? [])
      ].map((parameter) => resolveParameter(spec, parameter));
      const parameterDescriptors = mergedParameters.map((parameter) =>
        normalizeParameterDescriptor(spec, parameter)
      );
      const requestBody = parameterDescriptors.find(
        (parameter) => parameter.in === "body"
      );
      const parameters = parameterDescriptors.filter(
        (parameter) => parameter.in !== "body"
      );
      const response = extractSuccessResponse(spec, operation);
      const apiVersionParameter = parameterDescriptors.find(
        (parameter) => parameter.name === "api-version"
      );

      const rawOperationId =
        operation.operationId ??
        `${area}_${method.toUpperCase()}_${path.replace(/[^A-Za-z0-9]+/g, "_")}`;
      const normalizedOperation: AzureDevOpsApiOperation = {
        operationId: canonicalizeOperationId(rawOperationId),
        rawOperationId,
        displayName:
          operation.summary ?? rawOperationId ?? `${method.toUpperCase()} ${path}`,
        area,
        specFile,
        specVersion: spec.info?.version ?? "unknown",
        host: spec.host ?? "dev.azure.com",
        basePath: spec.basePath ?? "/",
        method: method.toUpperCase() as Uppercase<HttpMethod>,
        path,
        summary: operation.summary ?? "",
        description: operation.description ?? operation.summary ?? "",
        tags: operation.tags ?? [],
        preview: Boolean(operation["x-ms-preview"]),
        apiVersion:
          operation["x-ms-docs-override-version"] ??
          String(apiVersionParameter?.default ?? spec.info?.version ?? "7.2-preview.1"),
        consumes: operation.consumes ?? [],
        produces: operation.produces ?? [],
        parameters,
        securityScopes: (operation.security ?? []).flatMap((entry) =>
          Object.values(entry).flatMap((scopes) => scopes)
        )
      };

      if (requestBody) {
        normalizedOperation.requestBody = requestBody;
      }
      if (response.schema !== undefined) {
        normalizedOperation.responseSchema = response.schema;
      }
      if (response.description) {
        normalizedOperation.responseDescription = response.description;
      }

      operations.push(normalizedOperation);
    }
  }

  return operations;
}

export function selectLatestSpecFiles(
  paths: string[],
  allowedAreas?: readonly string[]
): RepoFileSelection[] {
  const versionsByArea = new Map<string, string>();
  const allFiles: RepoFileSelection[] = [];

  for (const path of paths) {
    const match = /^specification\/([^/]+)\/([0-9.]+)\/([^/]+\.json)$/.exec(path);
    if (!match) {
      continue;
    }

    const area = match[1] as string;
    const version = match[2] as string;
    if (allowedAreas && allowedAreas.length > 0 && !allowedAreas.includes(area)) {
      continue;
    }

    allFiles.push({ area, version, path });
    const current = versionsByArea.get(area);
    if (!current || compareVersions(version, current) > 0) {
      versionsByArea.set(area, version);
    }
  }

  return allFiles.filter(
    (file) => versionsByArea.get(file.area) === file.version
  );
}

export function toSearchOperation(
  operation: AzureDevOpsApiOperation
): AzureDevOpsSearchOperation {
  const implicitPathParams = operation.parameters
    .filter((parameter) => parameter.in === "path" && parameter.name === "organization")
    .map((parameter) => parameter.name);
  const implicitQueryParams = ["api-version"];

  const parameters = operation.parameters.filter((parameter) => {
    if (parameter.in === "path" && parameter.name === "organization") {
      return false;
    }

    if (parameter.in === "query" && parameter.name === "api-version") {
      return false;
    }

    return true;
  });

  return {
    operationId: operation.operationId,
    rawOperationId: operation.rawOperationId,
    summary: operation.summary,
    method: operation.method,
    path: operation.path.replace(/^\/\{organization\}/, ""),
    description: operation.description,
    area: operation.area,
    tags: operation.tags,
    preview: operation.preview,
    parameters,
    bodyRequired: Boolean(operation.requestBody?.required),
    bodyDescription: operation.requestBody?.description,
    bodySchema: summarizeSchema(operation.requestBody?.schema),
    responseSchema: summarizeSchema(operation.responseSchema),
    responseDescription: operation.responseDescription,
    defaultApiVersion: operation.apiVersion,
    consumes: operation.consumes,
    produces: operation.produces,
    specVersion: operation.specVersion,
    implicitPathParams,
    implicitQueryParams
  };
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

export class AzureDevOpsRestCatalog implements AzureDevOpsApiCaller {
  private readonly config: AzureDevOpsDirectConfig;
  private readonly authProvider: AzureDevOpsAuthProvider;
  private readonly fetchImpl: typeof fetch;
  private operationsPromise: Promise<AzureDevOpsApiOperation[]> | undefined;
  private operationMap: Map<string, AzureDevOpsApiOperation> | undefined;

  constructor(options: {
    config: AzureDevOpsDirectConfig;
    authProvider: AzureDevOpsAuthProvider;
    fetchImpl?: typeof fetch;
  }) {
    this.config = options.config;
    this.authProvider = options.authProvider;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async listOperations(): Promise<AzureDevOpsApiOperation[]> {
    if (!this.operationsPromise) {
      this.operationsPromise = this.loadOperations();
    }

    return this.operationsPromise;
  }

  async listSearchOperations(): Promise<AzureDevOpsSearchOperation[]> {
    return (await this.listOperations())
      .filter((operation) => operation.method !== "HEAD" && operation.method !== "OPTIONS")
      .map((operation) => toSearchOperation(operation));
  }

  async callOperation(input: {
    operationId: string;
    pathParams?: Record<string, string | number | boolean>;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    body?: unknown;
    apiVersion?: string | undefined;
  }): Promise<AzureDevOpsApiResponse> {
    const operations = await this.listOperations();
    if (!this.operationMap) {
      this.operationMap = new Map(
        operations.map((operation) => [operation.operationId, operation])
      );
    }

    const operation = this.operationMap.get(input.operationId);
    if (!operation) {
      throw new Error(`Unknown Azure DevOps operationId: ${input.operationId}`);
    }

    const pathParams: Record<string, string | number | boolean> = {
      ...(input.pathParams ?? {}),
      organization: this.config.organization
    };

    let resolvedPath = operation.path;
    for (const parameter of operation.parameters.filter(
      (entry) => entry.in === "path"
    )) {
      const value = pathParams[parameter.name];
      if (value === undefined || value === null) {
        throw new Error(
          `Missing path parameter '${parameter.name}' for operation ${operation.operationId}.`
        );
      }

      resolvedPath = resolvedPath.replace(
        new RegExp(`\\{${parameter.name}\\}`, "g"),
        encodePathValue(value)
      );
    }

    const url = new URL(
      `${operation.basePath.replace(/\/$/, "")}${resolvedPath}`,
      `https://${operation.host}`
    );
    const query = new URLSearchParams();
    const queryValues = {
      ...(input.query ?? {}),
      "api-version": input.apiVersion ?? operation.apiVersion
    };

    for (const [name, value] of Object.entries(queryValues)) {
      if (value === undefined || value === null) {
        continue;
      }

      const parameter = operation.parameters.find(
        (entry) => entry.in === "query" && entry.name === name
      );

      if (Array.isArray(value)) {
        if (parameter?.collectionFormat === "multi") {
          for (const entry of value) {
            query.append(name, String(entry));
          }
        } else {
          query.set(name, value.map((entry) => String(entry)).join(","));
        }
        continue;
      }

      query.set(name, String(value));
    }

    url.search = query.toString();

    const headers = new Headers(input.headers ?? {});
    headers.set("Authorization", await this.authProvider.getAuthorizationHeader());
    if (!headers.has("Accept")) {
      headers.set("Accept", operation.produces[0] ?? "application/json");
    }

    let body: string | undefined;
    if (input.body !== undefined) {
      const contentType = headers.get("Content-Type") ?? operation.consumes[0] ?? "application/json";
      headers.set("Content-Type", contentType);
      body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
    }

    const requestInit: RequestInit = {
      method: operation.method,
      headers
    };
    if (body !== undefined) {
      requestInit.body = body;
    }

    const response = await this.fetchImpl(url, requestInit);
    const responseHeaders = Object.fromEntries(response.headers.entries());
    const contentType = response.headers.get("content-type") ?? "";

    let data: unknown;
    let text: string | undefined;
    if (contentType.includes("application/json") || contentType.includes("+json")) {
      data = await response.json();
      text = JSON.stringify(data);
    } else {
      text = await response.text();
      data = text;
    }

    if (!response.ok) {
      throw new Error(
        `Azure DevOps API ${operation.operationId} failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`
      );
    }

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: url.toString(),
      operationId: operation.operationId,
      headers: responseHeaders,
      data,
      text
    };
  }

  private async loadOperations(): Promise<AzureDevOpsApiOperation[]> {
    const treeUrl = `https://api.github.com/repos/${this.config.specRepoOwner}/${this.config.specRepoName}/git/trees/${this.config.specRepoRef}?recursive=1`;
    const tree = await fetchJson<GitTreeResponse>(this.fetchImpl, treeUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ado-codemode-mcp"
      }
    });
    const files = selectLatestSpecFiles(
      tree.tree
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path),
      this.config.specAreas
    );

    const specs = await Promise.all(
      files.map(async (file) => {
        const rawUrl = `https://raw.githubusercontent.com/${this.config.specRepoOwner}/${this.config.specRepoName}/${this.config.specRepoRef}/${file.path}`;
        const spec = await fetchJson<SwaggerSpec>(this.fetchImpl, rawUrl);
        return extractOperationsFromSpec(file.path, spec);
      })
    );

    return specs
      .flat()
      .sort((left, right) => left.operationId.localeCompare(right.operationId));
  }
}
