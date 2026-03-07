# ado-codemode-mcp

`ado-codemode-mcp` is a local MCP server that exposes a minimal Azure DevOps execution surface to OpenCode:

- `search`
- `execute`

By default, debug-style endpoints such as `health` and `list_capabilities` stay hidden. To expose them for local troubleshooting, start `ado-codemode-mcp` with:

```bash
export ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS=1
```

## What it does

- loads a static Azure DevOps REST API catalog from the official Swagger repo
- keeps Azure DevOps credentials outside the sandbox
- runs generated JavaScript in a fresh sandbox per request
- exposes one execution helper to generated code:
  - `codemode.azdoRequest({ operationId, pathParams, query, headers, body, apiVersion })`

## Flow at a glance

```mermaid
flowchart LR
    OC[OpenCode]
    MCP[ado-codemode-mcp]
    CATALOG[Azure DevOps REST catalog]
    SANDBOX[Sandboxed Code Mode run]
    API[Trusted Azure DevOps REST caller]

    OC --> MCP
    MCP --> CATALOG
    MCP --> SANDBOX
    SANDBOX --> API
```

## Recommended usage pattern

Use `search` first when the model needs to discover relevant `operationId`s and request/response shape.

Use `execute` for the real task, and prefer one combined program per task. Inside that one program:

- make multiple Azure DevOps API calls as needed
- chain on `response.data`
- do lightweight aggregation, filtering, and shaping there
- return compact JSON-friendly output

Avoid splitting one task across many top-level `execute` calls unless:

- the result would exceed sandbox limits
- the task needs a deliberate checkpoint
- you are debugging a failing step in isolation

## Local runtime model

The current local-first implementation uses:

- `podman` by default
- `runsc` by default
- `--network=none`
- a file-backed callback channel between the sandbox and trusted host helper

The default sandbox limits are:

- timeout: 120s
- callback timeout: 30s
- logs: 128 KB
- result: 256 KB
- callbacks: 200

These can be overridden with env vars:

- `CODEMODE_SANDBOX_TIMEOUT_MS`
- `CODEMODE_SANDBOX_CALLBACK_TIMEOUT_MS`
- `CODEMODE_SANDBOX_MAX_LOG_BYTES`
- `CODEMODE_SANDBOX_MAX_RESULT_BYTES`
- `CODEMODE_SANDBOX_MAX_CALLBACKS`

## Production-style direction

This repo is local-first, but the intended shape for a production-like deployment is similar:

- a trusted gateway service owns Azure DevOps auth and REST execution
- generated code runs in an isolated sandbox tier
- only a narrow callback API crosses from sandbox to host
- sandbox egress stays disabled unless explicitly needed
- audit logging and policy checks sit at the gateway boundary

For a future AKS deployment, the local `runsc` setup can evolve into a remote sandbox tier backed by Kata Containers, while keeping the same logical split:

- OpenCode or another planner calls the gateway
- the gateway dispatches generated code to an isolated sandbox worker
- the gateway remains the only component allowed to talk to Azure DevOps with credentials
