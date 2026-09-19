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
        "DNSPod 的 SecretId 格式不正确（应以 AKID 开头，来自腾讯云「访问管理 → API 密钥管理」）；" +
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
  const existing = await db.prepare(
    "SELECT alias, api_key, api_secret, provider FROM accounts WHERE id = ?"
  ).bind(id).first();
  if (!existing) {
    throw new Error(`未找到 ID 为 ${id} 的账户`);
  }
  const existingRow = existing as { alias: string; api_key: string; api_secret: string; provider?: string };

  const finalAlias = (alias || "").trim() || existingRow.alias;
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

  try {
    await db.prepare(
      "UPDATE accounts SET alias = ?, api_key = ?, api_secret = ? WHERE id = ?"
    ).bind(finalAlias, finalApiKey, finalEncryptedSecret, id).run();
  } catch (e: unknown) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes("UNIQUE") || raw.toLowerCase().includes("unique constraint")) {
      throw new Error("该 API Key 已被其他账号绑定，请勿重复使用");
    }
    throw new Error(`账户更新失败: ${raw}`);
  }

  const result = await db.prepare(
    "SELECT id, alias, api_key, provider, website, created_at FROM accounts WHERE id = ?"
  ).bind(id).first<DBAccount>();

  await writeLog(db, "success", "operation", `账户 [${finalAlias}] 信息已更新`);
  return result as DBAccount;
}

/**
 * 删除账户
 */
export async function deleteAccount(db: D1Database, id: number): Promise<void> {
  const account = await db.prepare("SELECT alias FROM accounts WHERE id = ?").bind(id).first();
  const alias = account ? (account as { alias: string }).alias : `ID ${id}`;

  // 级联删除前清理 DNS 记录缓存
  try {
    await db.prepare(
      "DELETE FROM cache WHERE key IN (SELECT 'api_cache:dns:' || id FROM domains_cache WHERE account_id = ?)"
    ).bind(id).run();
  } catch (e) {
    console.error("Failed to purge dns cache for account:", e);
  }

  await db.prepare("DELETE FROM accounts WHERE id = ?").bind(id).run();
  await writeLog(db, "info", "operation", `解绑了账户 [${alias}]，其名下的域名缓存已被自动级联清理`);
}

/**
 * 根据 ID 获取解密后的 API 客户端
 *
 * NOTE: 这是全项目唯一的凭据出口。
 */
export async function getClientForAccount(
  db: D1Database,
  aesKey: string | undefined,
  id: number
): Promise<{ client: UpstreamClient; alias: string; provider: AccountProvider }> {
  const account = await db.prepare(
    "SELECT alias, api_key, api_secret, provider FROM accounts WHERE id = ?"
  ).bind(id).first();

  if (!account) {
    throw new Error(`未找到 ID 为 ${id} 的账户`);
  }

  const typedAccount = account as { alias: string; api_key: string; api_secret: string; provider?: string };
  const apiSecret = await decryptText(typedAccount.api_secret, aesKey);

  if (isLegacyHashedDualCredentialKey(typedAccount.api_key)) {
    throw new Error(
      `账号 [${typedAccount.alias}] 的凭据是旧版格式（早期版本误将 AccessKey 的哈希存入，真实 AccessKey 已不可恢复）。` +
        `请解绑该账号后重新绑定一次，新绑定的账号即可正常同步。`
    );
  }
  if (typedAccount.provider === "cloudflare") {
    return { client: new CloudflareClient(apiSecret), alias: typedAccount.alias, provider: "cloudflare" };
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
