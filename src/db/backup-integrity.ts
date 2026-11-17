import { ConflictError, ValidationError } from "../errors";
import { decryptText, encryptText, sha256Hex } from "./crypto";
import { canonicalJson, type BackupSnapshot, type NormalizedBackup } from "./backup-snapshot";
import { SCHEMA_VERSION } from "./schema-definition";

export const backupKeyId = (key?: string) => key ? sha256Hex(`domain-hub-backup-key-v1:${key}`) : Promise.resolve(null);
export function backupChecksum(snapshot: BackupSnapshot): Promise<string> {
  const { checksum: _checksum, ...metadata } = snapshot.metadata || {};
  return sha256Hex(canonicalJson({ version: snapshot.version, exported_at: snapshot.exported_at, counts: snapshot.counts, data: snapshot.data,
    metadata: snapshot.metadata ? metadata : undefined }));
}

export async function verifyBackupIntegrity(original: BackupSnapshot, normalized: NormalizedBackup, aesKey?: string): Promise<void> {
  if (original.metadata) {
    if (original.metadata.schema_version > SCHEMA_VERSION) throw new ValidationError("备份来自更高 schema 版本，请先升级目标应用");
    if (await backupChecksum(original) !== original.metadata.checksum) throw new ValidationError("备份校验和不匹配，文件可能损坏或被修改");
    if (original.metadata.key_id !== await backupKeyId(aesKey)) throw new ConflictError("备份与目标 AES_KEY 不匹配；请使用原密钥，不要重新生成", "backup_key_mismatch");
  }
  for (const row of normalized.data.accounts) {
    try {
      const cipher = String(row.api_secret);
      if (!cipher.startsWith("plain:") && !/^[a-f0-9]{24}:(?:[a-f0-9]{2}){16,}$/i.test(cipher)) throw new Error("Invalid cipher");
      const plaintext = await decryptText(cipher, aesKey);
      // Imported legacy weak values are upgraded; never create a new plain: credential.
      if (cipher.startsWith("plain:")) row.api_secret = await encryptText(plaintext, aesKey);
    } catch {
      throw new ConflictError(`备份账号 ${row.id} 的凭据无法用目标 AES_KEY 解密或安全保存，尚未写入任何业务数据`, "backup_key_mismatch");
    }
  }
}
