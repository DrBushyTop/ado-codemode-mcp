# ado-codemode-mcp

This repo contains a local Azure DevOps MCP gateway using [Cloudflare's Codemode](https://github.com/cloudflare/agents/tree/main/packages/codemode).
This is mainly an exploratory project on how to wrap MCPs with Codemode.

The main app is [`apps/ado-codemode-mcp`](apps/ado-codemode-mcp), which:

- exposes a small MCP surface
- keeps Azure DevOps credentials outside the sandbox
- runs generated JavaScript through `@cloudflare/codemode`
- forwards Azure DevOps calls through a trusted local bridge

## Public MCP surface

By default, the server exposes only:

- `search`
- `execute`

Debug tools such as `health` and `list_capabilities` are only exposed when:

```bash
export ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS=1
```

## Repo layout

- [`apps/ado-codemode-mcp`](apps/ado-codemode-mcp) - MCP server entrypoint and README
- [`packages/azdo-mcp-client`](packages/azdo-mcp-client) - trusted stdio bridge to Azure DevOps MCP
- [`packages/sandbox-executor`](packages/sandbox-executor) - sandbox launcher and callback handling
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

Type-check the repo:

```bash
bun run typecheck
```

## Recommended usage pattern

When OpenCode uses this MCP server:

- use `search` to discover tool names or capability shape
- use one combined `execute` call per task when possible
- do lightweight filtering and aggregation inside that single execute program

## Production-style direction

The current implementation is local-first and uses a sandbox executor with Podman or Docker plus `runsc`.

The intended future direction is a production-style deployment where:

- `ado-codemode-mcp` remains the trusted control plane
- Azure DevOps MCP still starts behind that trusted boundary
- generated code runs in a separate isolated sandbox tier
- a future AKS deployment could swap the local sandbox for Kata Containers while keeping the same callback-based trust model

See [`apps/ado-codemode-mcp/README.md`](apps/ado-codemode-mcp/README.md) and [`docs/architecture.md`](docs/architecture.md) for the detailed flow.
