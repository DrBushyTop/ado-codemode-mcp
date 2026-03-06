# Architecture decisions

## Azure DevOps auth stays outside the sandbox

The gateway never injects Azure DevOps tokens into sandbox environment variables or bind mounts. All auth remains in the host-side Azure DevOps MCP process launched by the gateway itself.

## The gateway owns Azure DevOps MCP startup

OpenCode starts only `ado-codemode-mcp`. The gateway derives the Azure DevOps MCP child-process command from its own environment variables and spawns that process itself. This removes hidden coupling to OpenCode MCP config entries and avoids duplicate MCP registrations.

That means Azure DevOps MCP is not registered as a separate OpenCode MCP server in the normal setup. It is an implementation detail owned by `ado-codemode-mcp`.

## OpenCode remains the code generator

The gateway does not make its own LLM calls. OpenCode generates JavaScript and sends it to the gateway's `execute` tool, and the gateway runs that code through `@cloudflare/codemode` with the custom sandbox executor.

## The sandbox starts with no general network

The executor launches containerized runs with `--network=none`. The only host interaction path is the callback request/response directory mounted into the run workspace.

## Podman is the primary local target

The executor defaults to `podman` with runtime `runsc`, matching the checklist's Colima-first macOS path.

## Docker remains equally supported

Set `CODEMODE_SANDBOX_ENGINE=docker` and the executor uses the same sandbox contract, limits, and runner image.

## JavaScript comes before TypeScript

The gateway prompts Code Mode to generate JavaScript only. That keeps the sandbox contract smaller while the end-to-end orchestration path is still being hardened.

## The public gateway surface stays tiny

The gateway should expose only `search` and `execute` in normal operation. Introspection endpoints such as `health` and `list_capabilities` are useful for development, but they should only be turned on behind `ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS=1`.

That keeps the `ado-codemode-mcp` contract small and production-like even when the internal implementation changes.

## One execute call per task is the preferred path

The most reliable way to use Code Mode here is to combine related Azure DevOps helper calls into one sandbox program. That reduces repeated top-level orchestration, lowers bridge churn, and gives the model a better place to aggregate and trim results.

## Mutation support lives behind the trusted gateway boundary

The bridge now exposes the Azure DevOps MCP surface rather than a read-only subset. The trust model therefore depends more heavily on the sandbox boundary, the narrow callback API, and future audit or approval controls for higher-risk operations.

## Warm containers are deferred

The implementation uses a fresh workspace and a fresh run per execution. Startup optimization can come later if local latency becomes a real problem.

## Local gVisor now, remote Kata later

The local implementation uses Podman plus `runsc` because it is practical on macOS development machines. A future production-like deployment can keep the same execution contract while swapping the local container launch for a remote sandbox tier on AKS backed by Kata Containers.
