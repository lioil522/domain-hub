/**
 * TOTP (RFC 6238) 工具函数 —— Base32 编解码、密钥生成、URI 构建、动态口令校验
 *
 * NOTE: 使用 Web Crypto API，兼容 Cloudflare Workers 运行时。
 */

/**
 * 标准 Base32 解码
 */
export function base32ToUint8Array(base32: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = base32.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const output = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let index = 0;

  for (let i = 0; i < clean.length; i++) {
    const idx = alphabet.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return output.slice(0, index);
}

/**
 * 生成随机 Base32 编码的 TOTP 密钥（默认 20 字节 = 160 位，符合 RFC 4226 建议）
 */
export function generateBase32Secret(byteLength = 20): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * 构建标准 otpauth:// URI，供前端生成二维码
 */
export function buildOtpAuthUri(secret: string, account: string, issuer = "Domain Hub"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * 校验 6 位 TOTP (2FA 动态口令) 是否有效
 * 自动识别 Base32 编码密钥，支持 ±30 秒 (±1 时间步长) 的系统时钟倾斜容差
 */
export async function verifyTOTP(token?: string, secretStr?: string): Promise<boolean> {
  if (!token || !secretStr) return false;

  const cleanToken = String(token).trim();
  if (!/^\d{6}$/.test(cleanToken)) return false;

  const cleanSecret = String(secretStr).trim();
  if (!cleanSecret) return false;

  // 构建两种秘钥尝试 (1: Base32 解码秘钥; 2: UTF-8 原始文本秘钥)
  const keyCandidates: Uint8Array[] = [];

  if (/^[A-Z2-7=]+$/i.test(cleanSecret)) {
    keyCandidates.push(base32ToUint8Array(cleanSecret));
  }
  keyCandidates.push(new TextEncoder().encode(cleanSecret));

  const nowSec = Math.floor(Date.now() / 1000);
  const timeStep = 30;
  const currentT = Math.floor(nowSec / timeStep);

  for (const keyData of keyCandidates) {
    if (keyData.length === 0) continue;
    try {
      const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
      );

      // 容忍 ±1 窗口 (±30秒)
      for (let i = -1; i <= 1; i++) {
        const t = currentT + i;
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer);
        view.setBigUint64(0, BigInt(t), false);

        const signature = await crypto.subtle.sign("HMAC", cryptoKey, buffer);
        const hmacBytes = new Uint8Array(signature);

        const offset = hmacBytes[hmacBytes.length - 1] & 0x0f;
        const binary =
          ((hmacBytes[offset] & 0x7f) << 24) |
          ((hmacBytes[offset + 1] & 0xff) << 16) |
          ((hmacBytes[offset + 2] & 0xff) << 8) |
          (hmacBytes[offset + 3] & 0xff);

        const otp = (binary % 1000000).toString().padStart(6, "0");
        if (otp === cleanToken) {
          return true;
        }
      }
    } catch (e) {
      console.error("TOTP verification attempt error:", e);
    }
  }

  return false;
}
