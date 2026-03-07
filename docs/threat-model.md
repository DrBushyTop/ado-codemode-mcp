# Threat model

## Protected assets

- Azure DevOps credentials held by the trusted host process
- repository and work item data returned from Azure DevOps
- the host machine running OpenCode and `ado-codemode-mcp`
- the local sandbox runtime and its callback channel

## Main threats

- generated code attempting to exfiltrate credentials
- generated code attempting arbitrary outbound network access
- generated code invoking mutating Azure DevOps operations without review
- oversized outputs or callback storms consuming host resources
- model fallback behavior escaping the intended Azure DevOps path

## Current controls

- credentials stay in the trusted Azure DevOps auth/request layer only
- the sandbox executor defaults to `runsc` and `--network=none`
- generated code only reaches Azure DevOps through the gateway's single request helper
- callback count, timeout, log size, and result size are capped per run
- each execution gets a fresh workspace and callback directory
- the public MCP surface can be limited to `search` and `execute`, with debug tools disabled by default
- the searchable API catalog hides server-bound context such as organization and default api-version

## Known gaps for follow-up

- no approval gate for mutating operations yet
- no structured audit sink beyond process logs yet
- no attestation that `runsc` is installed before the first execution
- no remote sandbox control plane yet for production-style execution on AKS/Kata
- no policy engine yet for restricting which Azure DevOps mutations are allowed by environment
