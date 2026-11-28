import { canonicalJson } from "../../shared/restore-wire";
import { sha256Hex } from "./crypto";

/** Stored representation, never a decrypted secret. Only bind it to SQL; do
 * not put it on a lease, job, client response or error. */
export interface AccountBinding { provider: string; api_key: string; api_secret: string }
export interface AccountClientRow extends AccountBinding { id: number; alias: string }
export const credentialFingerprint = (row: AccountBinding) =>
  sha256Hex(canonicalJson([row.provider || "dnshe", row.api_key, row.api_secret]));

export function bindingFence(id: number, row: AccountBinding) {
  return { sql: "EXISTS(SELECT 1 FROM accounts WHERE id=? AND provider=? AND api_key=? AND api_secret=?)",
    bindings: [id, row.provider, row.api_key, row.api_secret] };
}

/** Dispatch can cover up to 500 accounts; keep the SQL parameter count fixed. */
export function bindingSetFence(rows: (AccountBinding & { id: number })[]) {
  return { sql: `NOT EXISTS(SELECT 1 FROM json_each(?) b LEFT JOIN accounts a ON a.id=json_extract(b.value,'$[0]')
    WHERE a.provider IS NOT json_extract(b.value,'$[1]') OR a.api_key IS NOT json_extract(b.value,'$[2]')
       OR a.api_secret IS NOT json_extract(b.value,'$[3]'))`,
    binding: JSON.stringify(rows.map(a => [a.id, a.provider, a.api_key, a.api_secret])) };
}
