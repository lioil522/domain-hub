import assert from "node:assert/strict";
import { test } from "node:test";
import { PROVIDER_IDS, getProviderDefinition, normalizeProvider } from "../../src/providers/registry";

test("provider registry contains all supported providers", () => {
  for (const id of ["dnshe", "cloudflare", "digitalplat", "dnspod", "alidns", "huaweicloud", "vercel", "custom"] as const) {
    assert.ok(PROVIDER_IDS.includes(id));
    assert.equal(getProviderDefinition(id).id, id);
  }
  assert.equal(normalizeProvider("HUAWEICLOUD"), "huaweicloud");
  assert.equal(normalizeProvider("unknown"), "dnshe");
});
