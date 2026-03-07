import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

interface OrgTenantCacheEntry {
  tenantId: string;
  refreshedOn: number;
}

type OrgTenantCache = Record<string, OrgTenantCacheEntry>;

const cacheFile = join(homedir(), ".ado_orgs.cache");
const cacheTtlMs = 7 * 24 * 60 * 60 * 1000;

async function loadCache(): Promise<OrgTenantCache> {
  try {
    return JSON.parse(await readFile(cacheFile, "utf8")) as OrgTenantCache;
  } catch {
    return {};
  }
}

async function saveCache(cache: OrgTenantCache): Promise<void> {
  try {
    await writeFile(cacheFile, JSON.stringify(cache, null, 2), "utf8");
  } catch {
    // Best effort only.
  }
}

function isExpired(entry: OrgTenantCacheEntry): boolean {
  return Date.now() - entry.refreshedOn > cacheTtlMs;
}

async function fetchTenantFromApi(organization: string): Promise<string> {
  const response = await fetch(`https://vssps.dev.azure.com/${organization}`, {
    method: "HEAD"
  });

  if (response.status !== 404) {
    throw new Error(`Expected 404 while discovering tenant, got ${response.status}`);
  }

  const tenantId = response.headers.get("x-vss-resourcetenant");
  if (!tenantId) {
    throw new Error("x-vss-resourcetenant header missing from tenant discovery response");
  }

  return tenantId;
}

export async function getOrgTenant(
  organization: string
): Promise<string | undefined> {
  const cache = await loadCache();
  const cached = cache[organization];

  if (cached && !isExpired(cached)) {
    return cached.tenantId;
  }

  try {
    const tenantId = await fetchTenantFromApi(organization);
    cache[organization] = {
      tenantId,
      refreshedOn: Date.now()
    };
    await saveCache(cache);
    return tenantId;
  } catch {
    return cached?.tenantId;
  }
}
