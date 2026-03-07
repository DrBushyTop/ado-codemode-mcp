export interface AzureDevOpsDirectConfig {
  organization: string;
  authentication: "interactive" | "azcli" | "env" | "envvar";
  tenant?: string;
  specRepoOwner: string;
  specRepoName: string;
  specRepoRef: string;
  specAreas?: string[];
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }

  return value;
}

function parseOptionalList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : undefined;
}

export function readAzureDevOpsDirectConfig(): AzureDevOpsDirectConfig {
  const authentication =
    (process.env.AZDO_AUTHENTICATION as
      | "interactive"
      | "azcli"
      | "env"
      | "envvar"
      | undefined) ?? "interactive";

  const config: AzureDevOpsDirectConfig = {
    organization: requiredEnv("AZDO_ORGANIZATION"),
    authentication,
    specRepoOwner: process.env.AZDO_SPEC_REPO_OWNER ?? "MicrosoftDocs",
    specRepoName: process.env.AZDO_SPEC_REPO_NAME ?? "vsts-rest-api-specs",
    specRepoRef: process.env.AZDO_SPEC_REPO_REF ?? "master"
  };

  if (process.env.AZDO_TENANT) {
    config.tenant = process.env.AZDO_TENANT;
  }

  const areas = parseOptionalList(process.env.AZDO_SPEC_AREAS);
  if (areas) {
    config.specAreas = areas;
  }

  return config;
}
