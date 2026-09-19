/**
 * DNSHE 域名解析记录弹窗 —— 类型契约
 *
 * 从原单文件 `DnsheDnsModal.tsx` 拆出（UI 优化方案 P1）。纯搬运：接口字段、
 * 注释与语义逐字保留。`DnsheDnsModalProps` 是 App 与本弹窗之间的唯一契约，
 * 拆分后仍从这里导出，调用方无需改动。
 */

import type { Domain } from "../../../../types/domain";
import type { DnsRecord } from "../../../../types/dns";

export interface DnsheDnsModalProps {
  /** 弹窗开关（与 domain 同时为真才渲染） */
  open: boolean;
  /** 当前操作的域名 */
  domain: Domain | null;
  onClose: () => void;
  /** 操作忙碌键（create-dns / batch-create-dns / update-dns-<key> / ...），与父级共用 */
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
  /** 该域名是否支持按线路解析（父级三级判定：实测根域 > NS 后缀名单 > provider 兜底） */
  domainSupportsLine: (dom: Domain | null | undefined) => boolean;
  /** 从解析记录反推并记住「该根域支持线路」（有副作用：写 localStorage + toast） */
  learnLineRootFrom: (dom: Domain, records: DnsRecord[]) => void;
  /** 记录增删改成功后刷新域名列表（原 App.fetchDomains） */
  onDomainsChanged: () => void;
  /**
   * 删除单条解析记录（父级实现：confirm + DELETE + toast + 刷新域名列表）。
   *
   * NOTE: 与 NameserverModal 共用同一份实现（App 的 handleDeleteDnsRecord），
   * 故不在此组件内重复实现；删除成功且本面板正显示该域名时，父级会递增
   * refreshToken 触发列表重拉（等价于原 dnsModalOpen && selectedDomain?.id
   * === domain.id 时 reloadDnsRecords(domain)）。
   */
  onDeleteRecord: (recordId: string | number, domain?: Domain | null) => Promise<void>;
  /** 递增即重拉当前列表（等价于原 reloadDnsRecords(domain)，不重置弹窗内表单） */
  refreshToken: number;
}

/** 批量操作逐条回执行（批量添加 / 批量修改共用同一形状） */
export type DnsBatchResult = { label: string; success: boolean; message: string };
