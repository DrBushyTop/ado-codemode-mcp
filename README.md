# ado-codemode-mcp

This repo contains a local Azure DevOps MCP server that uses [Cloudflare's Code Mode](https://github.com/cloudflare/agents/tree/main/packages/codemode) with a direct Azure DevOps REST API catalog.

The current implementation lives in [`apps/ado-codemode-mcp`](apps/ado-codemode-mcp) and follows the same basic shape as Cloudflare's API experiments:

- `search` lets the model inspect a static Azure DevOps REST operation catalog built from official Swagger specs
- `execute` lets the model run one JavaScript program that calls Azure DevOps by `operationId`
- Azure DevOps auth stays outside the sandbox
- generated code runs in an isolated local sandbox

The earlier MCP-wrapping experiment is preserved on branch `feat/mcp-wrap`. That version wrapped the Azure DevOps MCP server instead of using the direct REST contract, but it did not end up working well enough as the main approach.

## Public MCP surface

By default, the server exposes only:

- `search`
- `execute`

Debug tools such as `health` and `list_capabilities` are only exposed when:

```bash
export ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS=1
```

## Repo layout

- [`apps/ado-codemode-mcp`](apps/ado-codemode-mcp) - main MCP server and local tests
- [`packages/sandbox-executor`](packages/sandbox-executor) - sandbox launcher and callback handling
- [`packages/sandbox-protocol`](packages/sandbox-protocol) - sandbox callback protocol types
- [`docker/sandbox-runner`](docker/sandbox-runner) - minimal sandbox runtime image
- [`docs/architecture.md`](docs/architecture.md) - system architecture and flow charts
- [`docs/architecture-decisions.md`](docs/architecture-decisions.md) - key design decisions
- [`docs/local-setup-macos.md`](docs/local-setup-macos.md) - local setup and smoke-test steps
- [`docs/threat-model.md`](docs/threat-model.md) - security boundaries and follow-ups

## Quick start

Install dependencies:

```bash
bun install
```

Set the minimum Azure DevOps config:

```bash
export AZDO_ORGANIZATION=your-organization
```

Start the MCP server:

```bash
bun run dev:ado-codemode-mcp
```

Run tests and type-check:

```bash
bun run test:ado-codemode-mcp
bun run typecheck
```

## Recommended usage pattern

When OpenCode uses this MCP server:

- use `search` once to narrow the relevant Azure DevOps REST operations
- use one combined `execute` call per task whenever practical
- chain on `response.data` inside that single execute program
- stop and report a blocker instead of falling back to unrelated tools when the Azure DevOps path fails

## Why this approach won

The direct REST catalog works better than wrapping the Azure DevOps MCP surface because the model can see both input and output schemas from the API contract.

That gives Code Mode enough information to:

- search for the right operations
- understand expected request shapes
- reason about returned data for longer chains inside one execute call

See `feat/mcp-wrap` for the previous wrapping experiment and `docs/architecture-decisions.md` for the reasoning behind the switch.
