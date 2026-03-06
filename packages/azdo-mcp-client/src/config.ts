import type { AzureDevOpsServerCommand } from "./index.js";

export interface AzureDevOpsGatewayConfig {
  organization: string;
  authentication: "interactive" | "azcli" | "env" | "envvar";
  tenant?: string;
  domains: string[];
  binary: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function parseDomains(input: string | undefined): string[] {
  if (!input) {
    return ["all"];
  }

  const domains = input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return domains.length > 0 ? domains : ["all"];
}

export function readGatewayAzdoConfig(): AzureDevOpsGatewayConfig {
  const authentication =
    (process.env.AZDO_AUTHENTICATION as
      | "interactive"
      | "azcli"
      | "env"
      | "envvar"
      | undefined) ?? "interactive";

  const config: AzureDevOpsGatewayConfig = {
    organization: requiredEnv("AZDO_ORGANIZATION"),
    authentication,
    domains: parseDomains(process.env.AZDO_DOMAINS),
    binary: process.env.AZDO_MCP_BINARY ?? "npx"
  };

  if (process.env.AZDO_TENANT) {
    config.tenant = process.env.AZDO_TENANT;
  }

  return config;
}

export function toAzureDevOpsServerCommand(
  config: AzureDevOpsGatewayConfig
): AzureDevOpsServerCommand {
  const args = [
    "-y",
    "@azure-devops/mcp",
    config.organization,
    "--authentication",
    config.authentication
  ];

  if (config.domains.length > 0) {
    args.push("--domains", ...config.domains);
  }

  if (config.tenant) {
    args.push("--tenant", config.tenant);
  }

  return {
    command: config.binary,
    args
  };
}
