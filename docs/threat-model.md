# Threat model

## Protected assets

- Azure DevOps credentials held by the local MCP server
- repository and work item data returned from Azure DevOps
- the host machine running OpenCode and the gateway
- the host machine running OpenCode and `ado-codemode-mcp`

## Main threats

- generated code attempting to exfiltrate credentials
- generated code attempting arbitrary outbound network access
- generated code invoking mutating Azure DevOps tools without review
- oversized outputs or callback storms consuming host resources

## Current controls

- credentials stay in the trusted Azure DevOps MCP process only
- the sandbox executor defaults to `runsc` and `--network=none`
- generated code only reaches Azure DevOps through the gateway's narrow helper API
- callback count, timeout, log size, and result size are capped per run
- each execution gets a fresh workspace and callback directory
- the public MCP surface can be limited to `search` and `execute`, with debug tools disabled by default

## Known gaps for follow-up

- no approval gate for mutation tools yet
- no structured audit sink beyond process logs yet
- no attestation that `runsc` is installed before the first execution
- no remote sandbox control plane yet for production-style execution on AKS/Kata
- no policy engine yet for restricting which Azure DevOps mutations are allowed by environment
