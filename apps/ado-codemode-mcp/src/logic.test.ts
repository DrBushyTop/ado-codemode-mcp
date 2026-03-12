import test from "node:test";
import assert from "node:assert/strict";
import {
  extractOperationsFromSpec,
  selectLatestSpecFiles,
  toSearchOperation,
  type AzureDevOpsApiOperation,
  type AzureDevOpsApiResponse
} from "./catalog.js";
import {
  FakeApiCaller,
  InlineExecutor,
  createExecutionCodeTool,
  runExecute,
  runSearch
} from "./logic.js";

function createOperations(): AzureDevOpsApiOperation[] {
  return [
    {
      operationId: "Projects_List",
      rawOperationId: "Projects_List",
      displayName: "List projects",
      area: "core",
      specFile: "specification/core/7.2/projects.json",
      specVersion: "7.2-preview",
      host: "dev.azure.com",
      basePath: "/",
      method: "GET",
      path: "/{organization}/_apis/projects",
      summary: "List projects",
      description: "Retrieve projects",
      tags: ["Projects"],
      preview: false,
      apiVersion: "7.2-preview.1",
      consumes: [],
      produces: ["application/json"],
      parameters: [
        {
          name: "organization",
          in: "path",
          description: "Organization",
          required: true,
          type: "string"
        }
      ],
      requestBody: undefined,
      responseSchema: { type: "object", properties: { items: { type: "array" } } },
      responseDescription: "Projects",
      securityScopes: ["vso.project"]
    },
    {
      operationId: "Wiql_Query_By_Wiql",
      rawOperationId: "Wiql_Query By Wiql",
      displayName: "Run WIQL",
      area: "wit",
      specFile: "specification/wit/7.2/workItemTracking.json",
      specVersion: "7.2-preview",
      host: "dev.azure.com",
      basePath: "/",
      method: "POST",
      path: "/{organization}/{project}/_apis/wit/wiql",
      summary: "Run WIQL",
      description: "Run a WIQL query",
      tags: ["Wiql"],
      preview: false,
      apiVersion: "7.2-preview.2",
      consumes: ["application/json"],
      produces: ["application/json"],
      parameters: [
        {
          name: "organization",
          in: "path",
          description: "Organization",
          required: true,
          type: "string"
        },
        {
          name: "project",
          in: "path",
          description: "Project",
          required: true,
          type: "string"
        }
      ],
      requestBody: {
        name: "body",
        in: "body",
        description: "WIQL body",
        required: true,
        schema: { type: "object", properties: { query: { type: "string" } } }
      },
      responseSchema: { type: "object", properties: { workItems: { type: "array" } } },
      responseDescription: "Query results",
      securityScopes: ["vso.work"]
    }
  ];
}

test("selectLatestSpecFiles picks latest version per area", () => {
  const files = selectLatestSpecFiles([
    "specification/core/7.1/projects.json",
    "specification/core/7.2/projects.json",
    "specification/wit/7.0/workItemTracking.json",
    "specification/wit/7.2/workItemTracking.json"
  ]);

  assert.deepEqual(files, [
    {
      area: "core",
      version: "7.2",
      path: "specification/core/7.2/projects.json"
    },
    {
      area: "wit",
      version: "7.2",
      path: "specification/wit/7.2/workItemTracking.json"
    }
  ]);
});

test("extractOperationsFromSpec resolves request and response schemas", () => {
  const operations = extractOperationsFromSpec("specification/core/7.2/projects.json", {
    info: { version: "7.2-preview" },
    host: "dev.azure.com",
    basePath: "/",
    parameters: {
      apiVersion: {
        name: "api-version",
        in: "query",
        default: "7.2-preview.1",
        type: "string"
      }
    },
    definitions: {
      ProjectList: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "object" } }
        }
      }
    },
    paths: {
      "/{organization}/_apis/projects": {
        get: {
          operationId: "Projects_List",
          description: "List projects",
          parameters: [{ $ref: "#/parameters/apiVersion" }],
          responses: {
            "200": {
              description: "ok",
              schema: { $ref: "#/definitions/ProjectList" }
            }
          }
        }
      }
    }
  });

  assert.equal(operations[0]?.operationId, "Projects_List");
  assert.equal(operations[0]?.rawOperationId, "Projects_List");
  assert.deepEqual(operations[0]?.responseSchema, {
    type: "object",
    properties: {
      items: { type: "array", items: { type: "object" } }
    }
  });
  assert.equal(operations[0]?.apiVersion, "7.2-preview.1");
});

test("search view hides organization and api-version from visible inputs", () => {
  const searchOperation = toSearchOperation(createOperations()[1]!);

  assert.equal(searchOperation.path, "/{project}/_apis/wit/wiql");
  assert.equal(searchOperation.summary, "Run WIQL");
  assert.equal(searchOperation.area, "wit");
  assert.equal(searchOperation.preview, false);
  assert.deepEqual(searchOperation.implicitPathParams, ["organization"]);
  assert.deepEqual(searchOperation.implicitQueryParams, ["api-version"]);
  assert.deepEqual(
    searchOperation.parameters.map((parameter) => parameter.name),
    ["project"]
  );
  assert.equal(searchOperation.bodyRequired, true);
  assert.equal(searchOperation.bodyDescription, "WIQL body");
  assert.deepEqual(searchOperation.bodySchema, {
    type: "object",
    properties: { query: { type: "string" } }
  });
  assert.equal(searchOperation.responseDescription, "Query results");
  assert.deepEqual(searchOperation.consumes, ["application/json"]);
  assert.deepEqual(searchOperation.produces, ["application/json"]);
  assert.equal(searchOperation.specVersion, "7.2-preview");
});

test("search view keeps schemas compact and omits head endpoints from catalog", async () => {
  const operations = createOperations().concat({
    ...createOperations()[1]!,
    operationId: "Wiql_Get",
    rawOperationId: "Wiql_Get",
    method: "HEAD"
  });
  const caller = new FakeApiCaller(operations, async () => {
    throw new Error("not used");
  });

  const searchOperations = await caller.listSearchOperations();
  assert.equal(searchOperations.some((operation) => operation.method === "HEAD"), false);
  assert.deepEqual(searchOperations[1]?.responseSchema, {
    type: "object",
    properties: { workItems: { type: "array" } }
  });
});

test("search view preserves required fields in summarized schemas", () => {
  const operation = toSearchOperation({
    ...createOperations()[1]!,
    requestBody: {
      name: "body",
      in: "body",
      description: "WIQL body",
      required: true,
      schema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "The query" },
          top: { type: "integer", default: 10 }
        }
      }
    },
    responseSchema: {
      type: "object",
      required: ["workItems"],
      properties: {
        workItems: {
          type: "array",
          items: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "integer" } }
          }
        }
      }
    }
  });

  assert.deepEqual(operation.bodySchema, {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", description: "The query" },
      top: { type: "integer", default: 10 }
    }
  });
  assert.deepEqual(operation.responseSchema, {
    type: "object",
    required: ["workItems"],
    properties: {
      workItems: {
        type: "array",
        items: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } }
        }
      }
    }
  });
});

test("runSearch returns evaluated operation matches", async () => {
  const caller = new FakeApiCaller(createOperations(), async () => {
    throw new Error("not used");
  });

  const result = await runSearch(
    caller,
    new InlineExecutor(),
    "async (operations) => operations.filter((op) => /project|wiql/i.test(`${op.operationId} ${op.description}`)).map((op) => ({ operationId: op.operationId, method: op.method, bodyRequired: op.bodyRequired, bodySchema: op.bodySchema ?? null, responseSchema: op.responseSchema ?? null }))"
  );

  assert.equal(result.error, null);
  assert.deepEqual(result.result, [
    {
      operationId: "Projects_List",
      method: "GET",
      bodyRequired: false,
      bodySchema: null,
      responseSchema: { type: "object", properties: { items: { type: "array" } } }
    },
    {
      operationId: "Wiql_Query_By_Wiql",
      method: "POST",
      bodyRequired: true,
      bodySchema: { type: "object", properties: { query: { type: "string" } } },
      responseSchema: { type: "object", properties: { workItems: { type: "array" } } }
    }
  ]);
});

test("runExecute chains on response data", async () => {
  const operations = createOperations();
  const caller = new FakeApiCaller(
    operations,
    async (input): Promise<AzureDevOpsApiResponse> => ({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://dev.azure.com/example",
      operationId: input.operationId,
      headers: {},
      data: {
        operationId: input.operationId,
        pathParams: input.pathParams ?? {},
        body: input.body ?? null
      },
      text: JSON.stringify({ operationId: input.operationId })
    })
  );
  const codemode = createExecutionCodeTool(caller, new InlineExecutor());

  const result = await runExecute(
    codemode,
    'async () => { const first = await codemode.azdoRequest({ operationId: "Projects_List", pathParams: {} }); return { first: first.data, second: await codemode.azdoRequest({ operationId: "Wiql_Query_By_Wiql", pathParams: { project: "sample" }, body: { query: "Select [System.Id] From WorkItems" } }).then((response) => response.data) }; }',
    "test-call",
    "process"
  );

  assert.deepEqual(result.result, {
    first: {
      operationId: "Projects_List",
      pathParams: {},
      body: null
    },
    second: {
      operationId: "Wiql_Query_By_Wiql",
      pathParams: { project: "sample" },
      body: { query: "Select [System.Id] From WorkItems" }
    }
  });
});
