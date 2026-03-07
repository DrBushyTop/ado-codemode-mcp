# Architecture decisions

## Azure DevOps auth stays outside the sandbox

The gateway never injects Azure DevOps tokens into sandbox environment variables or bind mounts. All auth remains in the trusted host process.

## The gateway owns Azure DevOps REST execution

OpenCode starts only `ado-codemode-mcp`. The gateway itself loads the Azure DevOps REST contract, resolves the org tenant, acquires tokens, and performs Azure DevOps requests on behalf of sandboxed code.

That keeps Azure DevOps auth and transport details out of the OpenCode MCP registry.

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

The most reliable way to use Code Mode here is to combine related Azure DevOps API calls into one sandbox program. That reduces repeated top-level orchestration, lowers churn, and gives the model a better place to aggregate and trim results.

## Supporting execute calls can still happen

One execute call per task is the target, but an occasional second execute call is acceptable when the first narrowed search set misses one required supporting operation, such as project or team discovery. The important thing is to keep that bounded and avoid fallback churn.

## We switched away from wrapping Azure DevOps MCP

The earlier experiment wrapped the Azure DevOps MCP server and exposed its tool surface through Code Mode. That version is preserved on branch `feat/mcp-wrap`, but it did not work well enough as the main approach.

The direct REST catalog won because:

- official Swagger specs expose richer input and output schemas
- the search surface can be sanitized independently from execute
- the model can reason about response data flow more reliably inside one execute call

## Generic guidance beats action-specific recipes

The model behaves better when the system gives generic rules about how to use `search` and `execute` rather than task-specific WIQL or work-item playbooks. The catalog and schemas should carry most of the guidance load.

## Warm containers are deferred

The implementation uses a fresh workspace and a fresh run per execution. Startup optimization can come later if local latency becomes a real problem.

## Local gVisor now, remote Kata later

The local implementation uses Podman plus `runsc` because it is practical on macOS development machines. A future production-like deployment can keep the same execution contract while swapping the local container launch for a remote sandbox tier on AKS backed by Kata Containers.
