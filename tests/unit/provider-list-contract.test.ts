import "../helpers/block-outbound";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { DnspodClient } from "../../src/dnspod";
import { AlidnsClient } from "../../src/alidns";
import { HuaweiCloudClient } from "../../src/huaweicloud";
import { VercelClient } from "../../src/vercel";
import { DigitalPlatClient } from "../../src/digitalplat";
import { ProviderApiError } from "../../src/errors/provider-api-error";
import { parseAlidnsResponse } from "../../src/providers/alidns-response";

type Kind = "domains" | "dns";
const providers = ["dnspod", "alidns", "huaweicloud", "vercel", "digitalplat"] as const;
type Provider = typeof providers[number];
function client(provider: Provider) {
  switch (provider) {
    case "dnspod": return new DnspodClient("fixture", "fixture");
    case "alidns": return new AlidnsClient("fixture", "fixture");
    case "huaweicloud": return new HuaweiCloudClient("fixture", "fixture", "dns.myhuaweicloud.com");
    case "vercel": return new VercelClient("fixture", "team-fixture");
    case "digitalplat": return new DigitalPlatClient("fixture");
  }
}
function row(provider: Provider, kind: Kind, id = 1): Record<string, unknown> {
  if (kind === "domains") {
    switch (provider) {
      case "dnspod": return { DomainId: id, Name: `d${id}.example.com` };
      case "alidns": return { DomainId: String(id), DomainName: `d${id}.example.com` };
      case "huaweicloud": return { id: String(id), name: `d${id}.example.com.` };
      case "vercel": return { id: String(id), name: `d${id}.example.com`, createdAt: 10000 - id };
      case "digitalplat": return { domain: `d${id}.example.com` };
    }
  }
  switch (provider) {
    case "dnspod": return { RecordId: id, Name: "@", Type: "TXT", Value: "", TTL: 600 };
    case "alidns": return { RecordId: String(id), RR: "@", Type: "TXT", Value: "", TTL: 600 };
    case "huaweicloud": return { id: String(id), name: "example.com.", type: "TXT", records: [""], ttl: 300 };
    case "vercel": return { id: String(id), name: "", type: "TXT", value: "", created: 10000 - id };
    case "digitalplat": return { id: String(id), name: "@", type: "TXT", values: [""], etag: "fixture" };
  }
}
function response(provider: Provider, kind: Kind, items: unknown, total = Array.isArray(items) ? items.length : 0, page = 1, next: number | null = null) {
  switch (provider) {
    case "dnspod": return { Response: kind === "domains" ? { DomainList: items, DomainCountInfo: { AllTotal: total } }
      : { RecordList: items, RecordCountInfo: { TotalCount: total, ListCount: Array.isArray(items) ? items.length : 0 } } };
    case "alidns": return { TotalCount: total, PageNumber: page, PageSize: 100,
      ...(kind === "domains" ? { Domains: { Domain: items } } : { DomainRecords: { Record: items } }) };
    case "huaweicloud": return { [kind === "domains" ? "zones" : "recordsets"]: items, metadata: { total_count: total } };
    case "vercel": return { [kind === "domains" ? "domains" : "records"]: items,
      pagination: { count: Array.isArray(items) ? items.length : 0, next, prev: null } };
    case "digitalplat": return { success: true, data: items };
  }
}
function mockFetch(t: TestContext, handler: (url: URL, init?: RequestInit) => unknown) {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (input, init) => {
    const value = handler(new URL(String(input)), init);
    return value instanceof Response ? value : Response.json(value);
  };
}
function incomplete(provider: Provider) {
  return (e: unknown) => e instanceof ProviderApiError && e.provider === provider && e.error_code === "incomplete_response";
}

for (const provider of providers) {
  for (const kind of ["domains", "dns"] as const) {
    test(`${provider} ${kind}: explicit empty is authoritative; missing, malformed and duplicate rows fail closed`, async t => {
      let body: unknown;
      mockFetch(t, () => body);
      const c = client(provider);
      const list = () => kind === "domains" ? c.listDomains() : c.listDnsRecords("example.com");
      for (const bad of [undefined, null, {}, [null], [{}], [row(provider, kind), row(provider, kind)]]) {
        body = response(provider, kind, bad);
        await assert.rejects(list(), incomplete(provider));
      }
      body = response(provider, kind, []);
      assert.deepEqual(kind === "domains" ? await list() : (await c.listDnsRecords("example.com")).records, []);
      body = response(provider, kind, [row(provider, kind)]);
      const valid = await list();
      if (Array.isArray(valid)) assert.equal(valid.length, 1);
      else {
        assert.equal(valid.complete, true);
        assert.equal(valid.records?.length, 1);
        assert.equal(valid.records?.[0].content, "");
      }
    });

    if (provider !== "digitalplat") {
      test(`${provider} ${kind}: pages must progress, finish explicitly, and respect the budget`, async t => {
        const pageLength = provider === "alidns" ? 100 : 1;
        let calls = 0;
        let mode: "valid" | "repeat" | "fail" | "budget" | "total-change" = "valid";
        mockFetch(t, (url, init) => {
          const page = ++calls;
          if (provider === "dnspod") {
            const params = JSON.parse(String(init?.body));
            assert.equal(params.Offset, (page - 1) * pageLength);
            if (kind === "domains") assert.equal(params.Type, "ALL");
          } else if (provider === "huaweicloud") assert.equal(url.searchParams.get("offset"), String((page - 1) * pageLength));
          else if (provider === "alidns") assert.equal(new URLSearchParams(String(init?.body)).get("PageNumber"), String(page));
          else {
            assert.equal(url.searchParams.has("since"), false);
            assert.equal(url.searchParams.get("until"), page === 1 ? null : String(10000 - page + 1));
            assert.equal(url.searchParams.get("teamId"), "team-fixture");
          }
          if (mode === "fail" && page === 2) return new Response("broken", { status: 503 });
          const rows = Array.from({ length: mode === "valid" && page === 2 ? 1 : pageLength }, (_, i) =>
            row(provider, kind, mode === "repeat" ? i + 1 : (page - 1) * pageLength + i + 1));
          const total = mode === "budget" ? 100000 : mode === "total-change" && page === 2 ? 1 : pageLength + 1;
          return response(provider, kind, rows, total, page, mode === "valid" && page === 2 ? null : 10000 - page);
        });
        const c = client(provider);
        const list = () => kind === "domains" ? c.listDomains() : c.listDnsRecords("example.com");
        const valid = await list();
        assert.equal(Array.isArray(valid) ? valid.length : valid.records?.length, pageLength + 1);
        assert.equal(calls, 2);
        for (const value of ["repeat", "fail", "budget", "total-change"] as const) {
          if (provider === "vercel" && value === "total-change") continue;
          calls = 0; mode = value;
          await assert.rejects(list(), value === "fail" ? undefined : incomplete(provider));
          if (value === "budget") assert.equal(calls, provider === "vercel" ? 20 : 50);
          else assert.equal(calls, 2);
        }
      });
    }
  }
}

test("counted providers reject absent/invalid totals and contradictory page metadata", async t => {
  let body: any;
  mockFetch(t, () => body);
  for (const p of ["dnspod", "alidns", "huaweicloud"] as const) {
    for (const total of [undefined, null, "0", -1, 0.5, 9007199254740992]) {
      body = response(p, "domains", [], total as number);
      // response's default parameter needs an explicit deletion for missing totals.
      if (total === undefined) {
        if (p === "dnspod") delete body.Response.DomainCountInfo;
        if (p === "alidns") delete body.TotalCount;
        if (p === "huaweicloud") delete body.metadata;
      }
      await assert.rejects(client(p).listDomains(), incomplete(p));
    }
  }
  body = response("dnspod", "dns", [row("dnspod", "dns")]);
  body.Response.RecordCountInfo.ListCount = 2;
  await assert.rejects(client("dnspod").listDnsRecords("example.com"), incomplete("dnspod"));
  body = response("alidns", "domains", [row("alidns", "domains")], 2);
  await assert.rejects(client("alidns").listDomains(), incomplete("alidns"));
  body = response("alidns", "domains", [], 0, 2);
  await assert.rejects(client("alidns").listDomains(), incomplete("alidns"));
  body = response("huaweicloud", "domains", [], 0);
  body.links = { next: "/v2/zones?offset=0" };
  await assert.rejects(client("huaweicloud").listDomains(), incomplete("huaweicloud"));
  body = response("huaweicloud", "domains", [row("huaweicloud", "domains")], 2);
  body.links = { next: "/v2/zones?offset=100" };
  await assert.rejects(client("huaweicloud").listDomains(), incomplete("huaweicloud"));
});

test("Vercel rejects unknown end conditions and non-decreasing cursors, never guesses from createdAt", async t => {
  let body: any;
  mockFetch(t, () => body);
  for (const pagination of [undefined, {}, { count: 0 }, { count: 1, next: null }, { count: 0, next: 1 }, { count: 0, next: "1" }]) {
    body = { domains: [], pagination };
    await assert.rejects(client("vercel").listDomains(), incomplete("vercel"));
  }
  let calls = 0;
  globalThis.fetch = async () => responseToJson(response("vercel", "domains", [row("vercel", "domains", ++calls)], 2, calls, 100));
  await assert.rejects(client("vercel").listDomains(), incomplete("vercel"));
  assert.equal(calls, 2);
});
function responseToJson(value: unknown) { return Response.json(value); }

test("DigitalPlat keeps unknown metadata and fails closed rather than assuming Domain-OSS pagination", async t => {
  let body: any;
  mockFetch(t, () => body);
  for (const meta of [{ total: 0 }, { has_more: false }, { page: 1, per_page: 100 }, { request_id: "unverified" }, false]) {
    body = { success: true, data: [], meta };
    await assert.rejects(client("digitalplat").listDomains(), incomplete("digitalplat"));
    await assert.rejects(client("digitalplat").listDnsRecords("example.com"), incomplete("digitalplat"));
  }
  body = { success: "true", data: [] };
  await assert.rejects(client("digitalplat").listDomains(), incomplete("digitalplat"));
  body = { success: true, data: [{ ...row("digitalplat", "dns"), protected: "false" }] };
  await assert.rejects(client("digitalplat").listDnsRecords("example.com"), incomplete("digitalplat"));
});

test("AliDNS parses real JSON lists and JSON write IDs while preserving complete XML compatibility", async t => {
  let body: unknown = response("alidns", "domains", [{ DomainId: "1", DomainName: "example.com", DnsServers: { DnsServer: ["ns.example.com"] } }]);
  mockFetch(t, () => body);
  const c = client("alidns") as AlidnsClient;
  assert.equal((await c.listDomains())[0].DnsServers?.DnsServer[0], "ns.example.com");
  body = { DomainId: "42", DomainName: "new.example.com", DnsServers: { DnsServer: ["ns.example.com"] } };
  assert.equal((await c.createDomain("new.example.com")).DomainId, "42");
  body = { RecordId: "43" };
  assert.equal((await c.createDnsRecord({ domain: "example.com", name: "@", type: "TXT", content: "fixture" })).record?.id, "43");
  const xml = '<?xml version="1.0"?><DescribeDomainRecordsResponse><TotalCount>1</TotalCount><PageNumber>1</PageNumber><PageSize>100</PageSize><DomainRecords><Record><RecordId>1</RecordId><RR>@</RR><Type>TXT</Type><TTL>600</TTL><Value><![CDATA[a & <b>]]>&amp; &#x1F600;</Value></Record></DomainRecords></DescribeDomainRecordsResponse>';
  body = new Response(xml);
  assert.equal((await c.listDnsRecords("example.com")).records?.[0].content, "a & <b>& 😀");
  body = new Response('<DescribeDomainsResponse><TotalCount>0</TotalCount><PageNumber>1</PageNumber><PageSize>100</PageSize><Domains/></DescribeDomainsResponse>');
  assert.deepEqual(await c.listDomains(), []);
  for (const bad of [xml.slice(0, -1), xml.replace("</Record>", "</Wrong>"), xml.replace("<DomainRecords>", "<DomainRecords><Unknown/>"), "<html></html>", '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///fixture">]><DescribeDomainsResponse/>']) {
    assert.throws(() => parseAlidnsResponse(bad, "DescribeDomainRecords"), incomplete("alidns"));
  }
  body = { Code: "InvalidAccessKeyId.NotFound", Message: "fixture" };
  await assert.rejects(c.listDomains(), e => e instanceof ProviderApiError && e.error_code === "InvalidAccessKeyId.NotFound");
});

test("RRset writes stop before mutations when their prerequisite list is incomplete", async t => {
  let writes = 0;
  mockFetch(t, (_url, init) => {
    if (init?.method !== "GET") writes++;
    return init?.method === "GET" ? { success: true, data: undefined, metadata: { total_count: 0 } } : {};
  });
  const dp = client("digitalplat") as DigitalPlatClient;
  await assert.rejects(dp.createDnsRecord({ domain: "example.com", name: "@", type: "A", content: "192.0.2.1" }), incomplete("digitalplat"));
  const hw = client("huaweicloud") as HuaweiCloudClient;
  const batch = await hw.batchCreateDnsRecords({ zoneId: "zone", zoneName: "example.com", items: [{ name: "@", type: "A", content: "192.0.2.1" }] });
  assert.equal(batch.successCount, 0);
  assert.equal(batch.failCount, 1);
  await assert.rejects(hw.updateDnsRecord({ zoneId: "zone", zoneName: "example.com", record_id: "id#0", name: "@", type: "A", content: "192.0.2.1" }), incomplete("huaweicloud"));
  assert.equal(writes, 0);
});

test("DigitalPlat preserves empty TXT values and raw synthetic indexes through update/delete", async t => {
  let records = [{ id: "txt", name: "@", type: "TXT", values: ["", "second"], etag: "fixture" }];
  mockFetch(t, (url, init) => {
    if (init?.method === "GET") return { success: true, data: records };
    assert.equal(init?.method, "PATCH");
    assert.ok(url.pathname.endsWith("/txt"));
    assert.equal(new Headers(init?.headers).get("If-Match"), "fixture");
    records[0].values = JSON.parse(String(init?.body)).values;
    return { success: true };
  });
  const c = new DigitalPlatClient("fixture");
  assert.deepEqual((await c.listDnsRecords("example.com")).records?.map(r => [r.id, r.content]), [["txt#0", ""], ["txt#1", "second"]]);
  await c.updateDnsRecord({ domain: "example.com", record_id: "txt#1", content: "changed" });
  assert.deepEqual(records[0].values, ["", "changed"]);
  await c.deleteDnsRecord("example.com", "txt#1");
  assert.deepEqual(records[0].values, [""]);
  assert.deepEqual((await c.listDnsRecords("example.com")).records?.map(r => [r.id, r.content]), [["txt", ""]]);
});

test("DigitalPlat batch merge retains scalar empty TXT and still hides protected records", async t => {
  let values: string[] | undefined;
  mockFetch(t, (_url, init) => {
    if (init?.method === "GET") return { success: true, data: [
      { id: "txt", name: "@", type: "TXT", value: "", etag: "fixture" },
      { id: "ns", name: "@", type: "NS", values: ["ns.example.com"], protected: true },
    ] };
    assert.equal(init?.method, "PATCH");
    values = JSON.parse(String(init?.body)).values;
    return { success: true };
  });
  const c = new DigitalPlatClient("fixture");
  assert.equal((await c.listDnsRecords("example.com")).records?.length, 1);
  const result = await c.batchCreateDnsRecords({ domain: "example.com", items: [{ name: "@", type: "TXT", content: "second" }] });
  assert.equal(result.successCount, 1);
  assert.deepEqual(values, ["", "second"]);
});
