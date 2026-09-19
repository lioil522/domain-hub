/** 配额接口 */
export interface Quota {
  account_id: number;
  alias: string;
  used: number;
  base: number;
  invite_bonus: number;
  total: number;
  available: number;
  error?: string;
}
