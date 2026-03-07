import {
  AzureCliCredential,
  ChainedTokenCredential,
  DefaultAzureCredential,
  type TokenCredential
} from "@azure/identity";
import type { AccountInfo, AuthenticationResult } from "@azure/msal-node";
import { PublicClientApplication } from "@azure/msal-node";
import open from "open";
import type { AzureDevOpsDirectConfig } from "./config.js";
import { getOrgTenant } from "./org-tenant.js";

const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/.default"];

export interface AzureDevOpsAuthProvider {
  getAuthorizationHeader(): Promise<string>;
}

class OAuthAuthenticator {
  static clientId = "0d50963b-7bb9-4fe7-94c7-a99af00b5136";
  static defaultAuthority = "https://login.microsoftonline.com/common";
  static zeroTenantId = "00000000-0000-0000-0000-000000000000";

  private account: AccountInfo | null = null;
  private readonly app: PublicClientApplication;

  constructor(tenantId?: string) {
    const authority =
      tenantId && tenantId !== OAuthAuthenticator.zeroTenantId
        ? `https://login.microsoftonline.com/${tenantId}`
        : OAuthAuthenticator.defaultAuthority;

    this.app = new PublicClientApplication({
      auth: {
        clientId: OAuthAuthenticator.clientId,
        authority
      }
    });
  }

  async getAccessToken(): Promise<string> {
    let result: AuthenticationResult | null = null;

    if (this.account) {
      try {
        result = await this.app.acquireTokenSilent({
          scopes,
          account: this.account
        });
      } catch {
        result = null;
      }
    }

    if (!result) {
      result = await this.app.acquireTokenInteractive({
        scopes,
        openBrowser: async (url: string) => {
          await open(url);
        }
      });
      this.account = result.account;
    }

    if (!result.accessToken) {
      throw new Error("Failed to obtain Azure DevOps OAuth token.");
    }

    return result.accessToken;
  }
}

function createPersonalAccessTokenProvider(): AzureDevOpsAuthProvider {
  return {
    async getAuthorizationHeader(): Promise<string> {
      const token = process.env.ADO_MCP_AUTH_TOKEN;
      if (!token) {
        throw new Error(
          "Environment variable ADO_MCP_AUTH_TOKEN is not set or empty."
        );
      }

      return `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;
    }
  };
}

function createCredentialProvider(tenantId: string | undefined): AzureDevOpsAuthProvider {
  if (!process.env.AZURE_TOKEN_CREDENTIALS) {
    process.env.AZURE_TOKEN_CREDENTIALS = "dev";
  }

  let credential: TokenCredential = new DefaultAzureCredential();
  if (tenantId) {
    credential = new ChainedTokenCredential(
      new AzureCliCredential({ tenantId }),
      credential
    );
  }

  return {
    async getAuthorizationHeader(): Promise<string> {
      const result = await credential.getToken(scopes);
      if (!result?.token) {
        throw new Error(
          "Failed to obtain Azure DevOps token. Ensure credentials are available."
        );
      }

      return `Bearer ${result.token}`;
    }
  };
}

function createOAuthProvider(tenantIdProvider: () => Promise<string | undefined>): AzureDevOpsAuthProvider {
  let authenticator: OAuthAuthenticator | undefined;

  return {
    async getAuthorizationHeader(): Promise<string> {
      if (!authenticator) {
        authenticator = new OAuthAuthenticator(await tenantIdProvider());
      }

      return `Bearer ${await authenticator.getAccessToken()}`;
    }
  };
}

export function createAzureDevOpsAuthProvider(
  config: AzureDevOpsDirectConfig
): AzureDevOpsAuthProvider {
  const tenantProvider = async (): Promise<string | undefined> => {
    if (config.tenant) {
      return config.tenant;
    }

    return getOrgTenant(config.organization);
  };

  switch (config.authentication) {
    case "envvar":
      return createPersonalAccessTokenProvider();
    case "azcli":
    case "env":
      return {
        async getAuthorizationHeader(): Promise<string> {
          return createCredentialProvider(await tenantProvider()).getAuthorizationHeader();
        }
      };
    default: {
      return createOAuthProvider(tenantProvider);
    }
  }
}
