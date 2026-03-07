# Local setup on macOS

## 1. Install local runtime dependencies

```bash
brew install colima podman docker
colima start --cpu 4 --memory 8 --disk 60
```

Verify the host tools:

```bash
podman version
podman system connection list
docker version
colima status
```

## 2. Install `runsc` inside the Colima VM

SSH into the VM and follow the gVisor runtime installation steps there:

```bash
colima ssh
```

Then verify `runsc` is available and register it with Podman or Docker inside the VM.

## 3. Build the sandbox runner image

From this repo root:

```bash
podman build -t codemode-sandbox-runner:local docker/sandbox-runner
```

Docker works the same way:

```bash
docker build -t codemode-sandbox-runner:local docker/sandbox-runner
```

## 4. Install dependencies

```bash
bun install
```

## 5. Configure Azure DevOps access

Export at least:

```bash
export AZDO_ORGANIZATION=your-organization
```

Optional auth tuning:

```bash
export AZDO_AUTHENTICATION=interactive
```

Supported auth modes are:

- `interactive`
- `azcli`
- `env`
- `envvar`

If you need an explicit tenant:

```bash
export AZDO_TENANT=00000000-0000-0000-0000-000000000000
```

If you want to use a PAT from the environment:

```bash
export AZDO_AUTHENTICATION=envvar
export ADO_MCP_AUTH_TOKEN=your-pat
```

Optional spec tuning:

```bash
export AZDO_SPEC_REPO_OWNER=MicrosoftDocs
export AZDO_SPEC_REPO_NAME=vsts-rest-api-specs
export AZDO_SPEC_REPO_REF=master
export AZDO_SPEC_AREAS=core,wit
```

Optional sandbox tuning:

```bash
export CODEMODE_SANDBOX_ENGINE=podman
export CODEMODE_SANDBOX_RUNTIME=runsc
export CODEMODE_SANDBOX_IMAGE=codemode-sandbox-runner:local
export CODEMODE_SANDBOX_TIMEOUT_MS=120000
export CODEMODE_SANDBOX_CALLBACK_TIMEOUT_MS=30000
export CODEMODE_SANDBOX_MAX_LOG_BYTES=128000
export CODEMODE_SANDBOX_MAX_RESULT_BYTES=256000
export CODEMODE_SANDBOX_MAX_CALLBACKS=200
```

Debug-only gateway tools can be enabled locally with:

```bash
export ADO_CODEMODE_MCP_EXPOSE_DEBUG_TOOLS=1
```

Leave that unset in normal usage so only `search` and `execute` are exposed.

For smoke testing without containers, an explicit insecure fallback exists:

```bash
export CODEMODE_SANDBOX_ENGINE=process
```

Use that only for local debugging. It is not a sandbox.

## 6. Start `ado-codemode-mcp`

```bash
bun run dev:ado-codemode-mcp
```

At startup, `apps/ado-codemode-mcp/src/index.ts` reads `AZDO_*` and `CODEMODE_*` env vars, loads the Azure DevOps Swagger catalog, and prepares the trusted REST caller.

OpenCode remains the planner and code generator. The gateway only exposes API discovery plus sandboxed execution.

## 7. Useful checks

Type-check the repo:

```bash
bun run typecheck
```

Run the focused test suite:

```bash
bun run test:ado-codemode-mcp
```

Execute a quick OpenCode smoke test:

```bash
opencode run --print-logs --log-level DEBUG "Use the ado-codemode-mcp MCP server. Call its search tool to find Azure DevOps operations for listing projects, then summarize the returned operationIds."
```
