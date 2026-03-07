import test from "node:test";
import assert from "node:assert/strict";
import { getOrgTenant } from "./org-tenant.js";

test("org tenant discovery resolves a tenant id from the response header", async () => {
  const originalFetch = globalThis.fetch;
  const organization = "example-org-for-test";
  const tenantId = "00000000-0000-0000-0000-000000000000";

  globalThis.fetch = async (input, init) => {
    assert.equal(input, `https://vssps.dev.azure.com/${organization}`);
    assert.equal(init?.method, "HEAD");

    return new Response(null, {
      status: 404,
      headers: { "x-vss-resourcetenant": tenantId }
    });
  };

  try {
    const resolvedTenantId = await getOrgTenant(organization);
    assert.equal(resolvedTenantId, tenantId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
