/**
 * AES-GCM 加解密 / PBKDF2 密码哈希 / 恒定时间比较
 *
 * NOTE: 所有函数均为无状态的纯密码学操作，不依赖 DatabaseManager 实例。
 * 上层通过参数传入 aesKeyStr 即可。
 */

/**
 * 使用 SHA-256 将任意长度的密钥材料派生为 256 位 AES-GCM 密钥
 */
async function getCryptoKey(aesKeyStr: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(aesKeyStr);
  const hash = await crypto.subtle.digest("SHA-256", keyData);
  return await crypto.subtle.importKey(
    "raw",
    hash,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * AES-GCM 加密文本
 *
 * NOTE: 当 aesKeyStr 存在但加密失败时，抛出异常而非静默降级为 Base64。
 * 仅在 aesKeyStr 本身为空时允许使用 Base64 弱编码作为降级方案。
 */
export async function encryptText(text: string, aesKeyStr?: string): Promise<string> {
  if (!aesKeyStr) {
    return "plain:" + btoa(text);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await getCryptoKey(aesKeyStr);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    data
  );

  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  const encryptedHex = Array.from(new Uint8Array(encrypted)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `${ivHex}:${encryptedHex}`;
}

/**
 * AES-GCM 解密文本
 */
export async function decryptText(encryptedText: string, aesKeyStr?: string): Promise<string> {
  if (encryptedText.startsWith("plain:")) {
    return atob(encryptedText.substring(6));
  }
  if (!aesKeyStr) {
    throw new Error("Encrypted secret requires AES_KEY to decrypt");
  }

  const parts = encryptedText.split(":");
  if (parts.length !== 2) {
    throw new Error("Invalid cipher format");
  }
  const ivHex = parts[0];
  const encryptedHex = parts[1];

  const iv = new Uint8Array(ivHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));
  const encrypted = new Uint8Array(encryptedHex.match(/.{1,2}/g)!.map(byte => parseInt(byte, 16)));

  const cryptoKey = await getCryptoKey(aesKeyStr);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    cryptoKey,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}

/**
 * 使用 PBKDF2-HMAC-SHA256 派生密码哈希（10 万轮）
 *
 * NOTE: 返回十六进制的 32 字节派生密钥。盐值由调用方生成并单独存储，
 * 校验时使用相同盐值重新派生并做恒定时间比较，避免时序侧信道。
 */
export async function hashPassword(password: string, saltHex: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derived))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 生成 16 字节随机盐值的十六进制字符串
 */
export function generateSalt(): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(salt).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 恒定时间字符串比较，防止基于响应耗时的时序攻击
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * 计算 SHA-256 十六进制摘要
 *
 * NOTE: 会话 token 落库前先哈希再存 —— 即使 D1 被读出，
 *       攻击者也拿不到可用于重放在线会话的原始 token。
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
