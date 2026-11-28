/**
 * 账号表数据访问（accounts 表的 CRUD + 凭据校验 + 客户端构建）
 *
 * NOTE: addAccount / updateAccount 包含上游 API 校验逻辑，因为这些校验
 * 与入库操作强耦合——校验通过才能入库，必须在同一事务边界内完成。
 */

import { DNSHEClient } from "../../dnshe";
import { CloudflareClient } from "../../cloudflare";
import { DigitalPlatClient } from "../../digitalplat";
import { DnspodClient, looksLikeTencentSecretId } from "../../dnspod";
import { AlidnsClient, looksLikeAliyunAccessKeyId } from "../../alidns";
import { HuaweiCloudClient, looksLikeHuaweiAccessKeyId } from "../../huaweicloud";
import { VercelClient } from "../../vercel";
import { encryptText, decryptText, sha256Hex } from "../crypto";
import { bindingFence, credentialFingerprint, type AccountClientRow } from "../account-binding";
import { ConflictError, NotFoundError } from "../../errors";
import { SyncWorkQueue } from "./sync-work-dao";
import { writeLog } from "./log-dao";
import type { DBAccount, AccountProvider, UpstreamClient } from "../types";
import {
  dualCredentialApiKey,
  accessKeyIdFromApiKey,
  isLegacyHashedDualCredentialKey,
  normalizeCfAlias,
} from "../types";

/**
 * 通过 keys/list 接口校验 API 密钥有效性，并尝试自动解析密钥名称作为别名
 */
export async function resolveAliasFromKey(client: DNSHEClient, apiKey: string): Promise<string | null> {
  try {
    const res = await client.listApiKeys();
    if (res && res.success && Array.isArray(res.keys)) {
      const match = res.keys.find((k) => k.api_key === apiKey);
      const keyName = match && match.key_name ? String(match.key_name).trim() : "";
      if (keyName) return keyName;
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "未知错误";
    throw new Error(`无法验证 API 密钥有效性: ${message}`);
  }
  return null;
}

/**
 * 添加 API 账户
 * alias 可留空，留空时自动通过 keys/list 接口解析密钥名称作为别名
 */
export async function addAccount(
  db: D1Database,
  aesKey: string | undefined,
  alias: string,
  apiKey: string,
  apiSecret: string,
  provider: AccountProvider = "dnshe",
  website?: string | null
): Promise<DBAccount> {
  let uniqueKey = apiKey;
  let credential = apiSecret;
  let finalAlias = (alias || "").trim();
  const finalWebsite = (website || "").trim() || null;

  if (provider === "custom") {
    if (!finalAlias) throw new Error("自定义服务商必须填写分组名称");
    uniqueKey = `custom:${await sha256Hex(`custom:${finalAlias}`)}`;
    credential = "";
  } else if (provider === "cloudflare") {
    const cfClient = new CloudflareClient(apiSecret);
    let verify: { token_id: string; status: string };
    try {
      verify = await cfClient.verifyToken();
    } catch (e: unknown) {
      throw new Error(`Cloudflare Token 校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
    if (verify.status && verify.status.toLowerCase() !== "active") {
      throw new Error(`Cloudflare Token 状态异常 (${verify.status})，请检查 Token 是否被禁用`);
    }

    let cfAccount: { id?: string; name?: string } | undefined;
    try {
      cfAccount = (await cfClient.listAccounts())[0];
    } catch {
      cfAccount = undefined;
    }
    if (!cfAccount) {
      try {
        cfAccount = (await cfClient.listZones({ maxPages: 1 })).zones.find((z) => z.account?.id)?.account;
      } catch {
        cfAccount = undefined;
      }
    }
    if (cfAccount?.id) {
      if (!finalAlias) finalAlias = normalizeCfAlias(cfAccount.name || "") || cfAccount.id;
      uniqueKey = `cf:${cfAccount.id}`;
    }
    if (!finalAlias) finalAlias = `Cloudflare ${String(verify.token_id).slice(0, 8)}`;
    if (uniqueKey === apiKey) uniqueKey = `cf:token:${verify.token_id}`;
  } else if (provider === "digitalplat") {
    const dpClient = new DigitalPlatClient(credential);
    try {
      await dpClient.listDomains();
    } catch (e: unknown) {
      throw new Error(`DigitalPlat API Key 校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
    if (!finalAlias) {
      finalAlias = `DigitalPlat ••••${credential.slice(-4)}`;
    }
    uniqueKey = `dp:${(await sha256Hex(credential)).slice(0, 32)}`;
  } else if (provider === "dnspod") {
    if (!looksLikeTencentSecretId(apiKey)) {
      throw new Error(
        "DNSPod 的 SecretId 格式不正确（应以 AKID 或 IKID 开头，来自腾讯云「访问管理 → API 密钥管理」）；" +
          "请注意 DNSPod 控制台里的「API Token」是另一套凭据，本面板使用腾讯云 API 密钥"
      );
    }
    const dnspodClient = new DnspodClient(apiKey, credential);
    try {
      await dnspodClient.listDomains();
    } catch (e: unknown) {
      throw new Error(`DNSPod 凭据校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
    if (!finalAlias) finalAlias = `DNSPod ••••${apiKey.slice(-6)}`;
    uniqueKey = dualCredentialApiKey("dnspod", apiKey);
  } else if (provider === "alidns") {
    if (!looksLikeAliyunAccessKeyId(apiKey)) {
      throw new Error(
        "阿里云 AccessKey ID 格式不正确（应以 LTAI 开头，来自阿里云控制台「访问控制 → 用户 → 创建 AccessKey」）"
      );
    }
    const alidnsClient = new AlidnsClient(apiKey, credential);
    try {
      await alidnsClient.listDomains();
    } catch (e: unknown) {
      throw new Error(`阿里云 DNS 凭据校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
    if (!finalAlias) finalAlias = `阿里云 DNS ••••${apiKey.slice(-6)}`;
    uniqueKey = dualCredentialApiKey("alidns", apiKey);
  } else if (provider === "huaweicloud") {
    const huaweiClient = new HuaweiCloudClient(apiKey, credential);
    try {
      await huaweiClient.listDomains();
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : "未知错误";
      const shapeHint = looksLikeHuaweiAccessKeyId(apiKey)
        ? ""
        : "（补充：该 AK 不是常见的 20 位大写字母数字形式，请确认没有误填成 Secret Access Key）";
      throw new Error(`华为云 DNS 凭据校验失败: ${detail}${shapeHint}`);
    }
    if (!finalAlias) finalAlias = `华为云 DNS ••••${apiKey.slice(-6)}`;
    uniqueKey = dualCredentialApiKey("huaweicloud", apiKey);
  } else if (provider === "vercel") {
    const vercelClient = new VercelClient(credential);
    let vercelUser: { id: string; username?: string; email?: string };
    try {
      vercelUser = await vercelClient.verifyToken();
    } catch (e: unknown) {
      throw new Error(`Vercel Token 校验失败: ${e instanceof Error ? e.message : "未知错误"}`);
    }
    if (!finalAlias) {
      finalAlias = vercelUser.username
        ? `Vercel · ${vercelUser.username}`
        : `Vercel ••••${credential.slice(-4)}`;
    }
    uniqueKey = vercelUser.id
      ? `vercel:${vercelUser.id}`
      : `vercel:${(await sha256Hex(credential)).slice(0, 32)}`;
  } else {
    // DNSHE
    const client = new DNSHEClient(apiKey, apiSecret);
    if (!finalAlias) {
      const resolved = await resolveAliasFromKey(client, apiKey);
      if (!resolved) {
        throw new Error("API 密钥有效但未能自动获取密钥名称作为别名，请手动填写别名");
      }
      finalAlias = resolved;
    } else {
      try {
        await client.getQuota();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "未知错误";
        throw new Error(`无法验证 API 密钥有效性: ${message}`);
      }
    }
  }

  const encryptedSecret = await encryptText(credential, aesKey);

  try {
    await db.prepare(
      "INSERT INTO accounts (alias, api_key, api_secret, provider, website) VALUES (?, ?, ?, ?, ?)"
    ).bind(finalAlias, uniqueKey, encryptedSecret, provider, finalWebsite).run();
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes("UNIQUE") || raw.toLowerCase().includes("unique constraint")) {
      throw new Error(
        provider === "cloudflare"
          ? "该 Cloudflare 账号已被绑定，请勿重复绑定（别名: " + finalAlias + "）"
          : `该 API Key 已被绑定，请勿重复绑定（别名: ${finalAlias}）`
      );
    }
    throw new Error(`账户入库失败: ${raw}`);
  }

  const result = await db.prepare(
    "SELECT id, alias, api_key, provider, website, created_at FROM accounts WHERE api_key = ?"
  ).bind(uniqueKey).first<DBAccount>();

  if (!aesKey) {
    await writeLog(db, "warning", "operation", `账户 [${finalAlias}] 已绑定，但由于未配置 AES_KEY，秘钥将以不安全的方式（弱 Base64 编码）存储在 D1 中！`);
  } else {
    await writeLog(db, "success", "operation", `账户 [${finalAlias}] 绑定成功，已启用 AES-GCM 安全加密`);
  }

  return result as DBAccount;
}

/**
 * 获取所有账户
 */
export async function getAccounts(db: D1Database, provider?: AccountProvider): Promise<DBAccount[]> {
  const query = provider
    ? "SELECT id, alias, api_key, provider, website, created_at FROM accounts WHERE provider = ? ORDER BY id ASC"
    : "SELECT id, alias, api_key, provider, website, created_at FROM accounts ORDER BY id ASC";
  const statement = db.prepare(query);
  const { results } = provider
    ? await statement.bind(provider).all<DBAccount>()
    : await statement.all<DBAccount>();
  return results || [];
}

/**
 * 更新 API 账户（可仅修改别名，或同时更换凭据）
 */
export async function updateAccount(
  db: D1Database,
  aesKey: string | undefined,
  id: number,
  alias: string,
  apiKey?: string,
  apiSecret?: string
): Promise<DBAccount> {
  const existingRow = await readClientRow(db, id);

  const newAlias = (alias || "").trim();
  let finalApiKey = existingRow.api_key;
  let finalEncryptedSecret = existingRow.api_secret;

  if (existingRow.provider === "cloudflare") {
    const newToken = (apiSecret || "").trim();
    if (newToken) {
      const cfClient = new CloudflareClient(newToken);
      try {
        const verify = await cfClient.verifyToken();
        if (verify.status && verify.status.toLowerCase() !== "active") {
          throw new Error(`Token 状态异常 (${verify.status})`);
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "未知错误";
        throw new Error(`无法验证新 Cloudflare Token: ${message}`);
      }
      finalEncryptedSecret = await encryptText(newToken, aesKey);
    }
  } else if (existingRow.provider === "vercel") {
    const token = (apiSecret || "").trim();
    if (token) {
      const user = await new VercelClient(token).verifyToken();
      finalApiKey = `vercel:${user.id || (await sha256Hex(token)).slice(0, 32)}`;
      finalEncryptedSecret = await encryptText(token, aesKey);
    }
  } else if (existingRow.provider === "digitalplat") {
    const newKey = (apiSecret || "").trim();
    if (newKey) {
      const dpClient = new DigitalPlatClient(newKey);
      try {
        await dpClient.listDomains();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "未知错误";
        throw new Error(`无法验证新 DigitalPlat API Key: ${message}`);
      }
      finalApiKey = `dp:${(await sha256Hex(newKey)).slice(0, 32)}`;
      finalEncryptedSecret = await encryptText(newKey, aesKey);
    }
  } else if (
    existingRow.provider === "dnspod" ||
    existingRow.provider === "alidns" ||
    existingRow.provider === "huaweicloud"
  ) {
    const provider = existingRow.provider as AccountProvider;
    const newKey = (apiKey || "").trim();
    const newSecret = (apiSecret || "").trim();
    if (newKey || newSecret) {
      if (!newKey || !newSecret) {
        throw new Error("更换凭据时，AccessKey ID 与 Secret 必须同时填写");
      }
      try {
        if (provider === "dnspod") await new DnspodClient(newKey, newSecret).listDomains();
        else if (provider === "alidns") await new AlidnsClient(newKey, newSecret).listDomains();
        else await new HuaweiCloudClient(newKey, newSecret).listDomains();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "未知错误";
        throw new Error(`无法验证新凭据有效性: ${message}`);
      }
      finalApiKey = dualCredentialApiKey(provider, newKey);
      finalEncryptedSecret = await encryptText(newSecret, aesKey);
    }
  } else {
    // DNSHE
    const newKey = (apiKey || "").trim();
    const newSecret = (apiSecret || "").trim();
    if (newKey || newSecret) {
      if (!newKey || !newSecret) {
        throw new Error("更换 API 密钥时，API Key 与 API Secret 必须同时填写");
      }
      const client = new DNSHEClient(newKey, newSecret);
      try {
        await client.getQuota();
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "未知错误";
        throw new Error(`无法验证新 API 密钥有效性: ${message}`);
      }
      finalApiKey = newKey;
      finalEncryptedSecret = await encryptText(newSecret, aesKey);
    }
  }

  const projection = "id, alias, api_key, provider, website, created_at";
  let result: DBAccount | null;
  try {
    if (finalApiKey === existingRow.api_key && finalEncryptedSecret === existingRow.api_secret) {
      // A rename must never write back credentials from an earlier read.
      result = await db.prepare(`UPDATE accounts SET alias=COALESCE(NULLIF(?,''),alias) WHERE id=? RETURNING ${projection}`)
        .bind(newAlias, id).first<DBAccount>();
    } else {
      const fence = bindingFence(id, existingRow);
      const writes = await db.batch<DBAccount>([
        ...invalidateAccountSync(db, id, fence),
        db.prepare(`UPDATE accounts SET alias=COALESCE(NULLIF(?,''),alias),api_key=?,api_secret=?
          WHERE id=? AND ${fence.sql} RETURNING ${projection}`).bind(newAlias, finalApiKey, finalEncryptedSecret, id, ...fence.bindings),
      ]);
      result = writes.at(-1)?.results[0] ?? null;
    }
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes("UNIQUE") || raw.toLowerCase().includes("unique constraint")) {
      throw new Error("该 API Key 已被其他账号绑定，请勿重复使用");
    }
    throw new Error("账户更新失败，请重试");
  }
  if (!result) throw new ConflictError("账户绑定已改变，请刷新后重试", "account_binding_changed");
  await writeLog(db, "success", "operation", `账户 [${result.alias}] 信息已更新`);
  return result;
}

function invalidateAccountSync(db: D1Database, id: number, fence: { sql: string; bindings: (number | string)[] }) {
  const active = "status IN ('queued','running','paused')";
  return [
    db.prepare(`UPDATE cache SET value=(SELECT json_group_array(json(value)) FROM json_each(cache.value)
      WHERE CAST(json_extract(value,'$.account_id') AS INTEGER) IS NOT ?)
      WHERE key='api_cache:quota' AND json_valid(value) AND json_type(value)='array'
      AND NOT EXISTS(SELECT 1 FROM json_each(cache.value) WHERE type<>'object') AND ${fence.sql}`)
      .bind(id, ...fence.bindings),
    db.prepare(`DELETE FROM cache WHERE key IN (SELECT 'api_cache:dns:' || id FROM domains_cache WHERE account_id=?
      UNION ALL SELECT 'api_cache:dns:' || r.domain_id FROM sync_work w JOIN sync_rows r ON r.job_id=w.id
      WHERE w.account_id=? AND w.${active} AND r.enriched=1 AND NOT EXISTS
        (SELECT 1 FROM domains_cache d WHERE d.id=r.domain_id AND d.account_id<>?)) AND ${fence.sql}`)
      .bind(id, id, id, ...fence.bindings),
    db.prepare(`UPDATE sync_work SET status='cancelled',lease_token=NULL,lease_until=0,updated_at=?,error='账号绑定已改变'
      WHERE account_id=? AND ${active} AND ${fence.sql}`).bind(Date.now(), id, ...fence.bindings),
    new SyncWorkQueue(db).actionRefresh({ sql: `actions.id IN(SELECT action_id FROM sync_work WHERE account_id=?) AND ${fence.sql}`,
      bindings: [id, ...fence.bindings] }),
    db.prepare(`DELETE FROM cf_sync_seen WHERE account_id=? AND ${fence.sql}`).bind(id, ...fence.bindings),
    db.prepare(`DELETE FROM cf_sync_state WHERE account_id=? AND ${fence.sql}`).bind(id, ...fence.bindings),
  ];
}

/**
 * 删除账户
 */
export async function deleteAccount(db: D1Database, id: number): Promise<void> {
  const row = await db.prepare("SELECT id,alias,provider,api_key,api_secret FROM accounts WHERE id=?").bind(id).first<AccountClientRow>();
  if (!row) return;
  const fence = bindingFence(id, row);
  const writes = await db.batch([...invalidateAccountSync(db, id, fence),
    db.prepare(`DELETE FROM accounts WHERE id=? AND ${fence.sql}`).bind(id, ...fence.bindings)]);
  if (!writes.at(-1)?.meta.changes) throw new ConflictError("账户绑定已改变，请刷新后重试", "account_binding_changed");
  await writeLog(db, "info", "operation", `解绑了账户 [${row.alias}]，其名下的域名缓存已被自动级联清理`);
}

export async function readClientRow(db: D1Database, id: number) {
  const row = await db.prepare("SELECT id,alias,api_key,api_secret,provider FROM accounts WHERE id=?").bind(id).first<AccountClientRow>();
  if (!row) throw new NotFoundError(`未找到 ID 为 ${id} 的账户`);
  return row;
}

/** Construct the client from the same stored row that authorized the slice. */
export async function getClientForAccount(
  db: D1Database,
  aesKey: string | undefined,
  id: number, snapshot?: AccountClientRow
): Promise<{ client: UpstreamClient; alias: string; provider: AccountProvider }> {
  const typedAccount = snapshot ?? await readClientRow(db, id);
  if (typedAccount.id !== id) throw new ConflictError("账号绑定不匹配");
  const apiSecret = await decryptText(typedAccount.api_secret, aesKey);

  if (isLegacyHashedDualCredentialKey(typedAccount.api_key)) {
    throw new Error(
      `账号 [${typedAccount.alias}] 的凭据是旧版格式（早期版本误将 AccessKey 的哈希存入，真实 AccessKey 已不可恢复）。` +
        `请解绑该账号后重新绑定一次，新绑定的账号即可正常同步。`
    );
  }
  if (typedAccount.provider === "cloudflare") {
    const client = new CloudflareClient(apiSecret);
    client.credentialFingerprint = await credentialFingerprint(typedAccount);
    return { client, alias: typedAccount.alias, provider: "cloudflare" };
  }
  if (typedAccount.provider === "digitalplat") {
    return { client: new DigitalPlatClient(apiSecret), alias: typedAccount.alias, provider: "digitalplat" };
  }
  if (typedAccount.provider === "dnspod") {
    return { client: new DnspodClient(accessKeyIdFromApiKey(typedAccount.api_key), apiSecret), alias: typedAccount.alias, provider: "dnspod" };
  }
  if (typedAccount.provider === "alidns") {
    return { client: new AlidnsClient(accessKeyIdFromApiKey(typedAccount.api_key), apiSecret), alias: typedAccount.alias, provider: "alidns" };
  }
  if (typedAccount.provider === "huaweicloud") {
    return { client: new HuaweiCloudClient(accessKeyIdFromApiKey(typedAccount.api_key), apiSecret), alias: typedAccount.alias, provider: "huaweicloud" };
  }
  if (typedAccount.provider === "vercel") {
    return { client: new VercelClient(apiSecret), alias: typedAccount.alias, provider: "vercel" };
  }
  if (typedAccount.provider === "custom") {
    return { client: new DNSHEClient("", ""), alias: typedAccount.alias, provider: "custom" };
  }
  return { client: new DNSHEClient(typedAccount.api_key, apiSecret), alias: typedAccount.alias, provider: "dnshe" };
}
