/**
 * DNS 解析记录面板 —— 模块入口（barrel）
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆分为同目录多文件后，这里统一对外导出，
 * 保证调用方的导入路径与符号名不变：
 *
 *   - `App.tsx`           → `import { DnsRecordPanel } from "./components/DnsRecordPanel"`
 *   - `useCfDnsPanel.ts`  → `import type { DnsRecordPanelProps } from ".../components/DnsRecordPanel"`
 *
 * 由于 tsconfig 为 `moduleResolution: "bundler"`，文件夹与文件同名时优先解析
 * 文件夹入口，故旧路径 `./components/DnsRecordPanel` 依然有效。
 */

export { DnsRecordPanel } from "./DnsRecordPanel";
export type { DnsRecordPanelProps, DnsPanelMeta, DnsBatchResult } from "./types";
