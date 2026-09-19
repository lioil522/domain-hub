/**
 * DNS 解析记录面板 —— 下拉选项与共享常量
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。纯搬运。
 */

import type { CustomSelectOption } from "../form/CustomSelect";

/** TTL 下拉的候选值（新建 / 编辑 / 批量三个面板共用同一份） */
export const TTL_OPTIONS = [60, 300, 600, 1800, 3600, 7200, 18000, 43200, 86400];

/** Cloudflare 支持代理的记录类型（其余类型即使开了代理也会被上游忽略） */
export const PROXIED_TYPES = ["A", "AAAA", "CNAME"];

/**
 * 构造 TTL 下拉选项。
 *
 * NOTE: Cloudflare 有「自动」档（值为 1），其余托管商没有 —— 用 `withAuto`
 * 控制是否在列表最前插入该项。原实现四处重复同一段展开表达式，收敛到这里。
 */
export function ttlSelectOptions(withAuto: boolean, labelSuffix = " 秒"): CustomSelectOption[] {
  return [
    ...(withAuto ? [{ value: "1", label: "自动" }] : []),
    ...TTL_OPTIONS.map((t) => ({ value: String(t), label: `${t}${labelSuffix}` })),
  ];
}
