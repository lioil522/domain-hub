/**
 * DNS 解析记录面板 —— 类型契约
 *
 * 从原单文件 `DnsRecordPanel.tsx` 拆出（UI 优化方案 P1）。纯搬运：接口字段、
 * 注释与语义逐字保留。`DnsRecordPanelProps` 是 App / useCfDnsPanel 与本面板
 * 之间的唯一契约，拆分后仍从这里导出，调用方无需改动。
 */

import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { Domain } from "../types";
import type { DnsRecord } from "../types";

/** 面板头部/刷新按钮的文案与开关，由 App 按当前域名所属托管商算出 */
export interface DnsPanelMeta {
  /** 副标题（如「Cloudflare 托管 zone · 已激活」） */
  subtitle: string;
  /** 刷新按钮 title */
  refreshTitle: string;
  /** 是否 DigitalPlat（决定空态文案、优先级字段的呈现方式） */
  isDp: boolean;
  /** 是否 Cloudflare（决定代理开关、自动 TTL 是否出现） */
  isCloudflare: boolean;
  /** 当前域名所属托管商标识（如 cloudflare, dnspod, alidns 等） */
  provider?: string;
  /** 当前域名/服务商是否支持分线路解析 */
  supportsLine?: boolean;
  /**
   * 编辑记录时类型与主机名是否只读。
   *
   * WHY 需要它：只有 Cloudflare 的 PATCH 接口支持改类型与主机名，
   * 其余六家的上游都只接受「改记录值 / TTL」。
   */
  lockedIdentity: boolean;
}

export interface DnsRecordPanelProps {
  /** 面板是否可见 */
  open: boolean;
  /** 当前操作的域名（null 时面板不渲染） */
  zone: Domain | null;
  meta: DnsPanelMeta;
  onClose: () => void;

  // ===== 记录列表 =====
  records: DnsRecord[];
  loadingRecords: boolean;
  recordsError: string | null;
  /** 强制刷新（绕过后端缓存） */
  onReload: (force?: boolean) => void;

  // ===== 通用 loading 键（形如 "cf-create-dns"、"cf-update-dns-<key>"） =====
  actionLoading: string | null;

  // ===== 新建记录 =====
  formOpen: boolean;
  setFormOpen: Dispatch<SetStateAction<boolean>>;
  newType: string;
  setNewType: (v: string) => void;
  newName: string;
  setNewName: (v: string) => void;
  newContent: string;
  setNewContent: (v: string) => void;
  newTtl: number;
  setNewTtl: (v: number) => void;
  newPriority: number;
  setNewPriority: (v: number) => void;
  newLine?: string;
  setNewLine?: (v: string) => void;
  newProxied: boolean;
  setNewProxied: (v: boolean) => void;
  onCreateRecord: () => void;

  // ===== 批量添加 =====
  batchOpen: boolean;
  setBatchOpen: Dispatch<SetStateAction<boolean>>;
  batchInput: string;
  setBatchInput: (v: string) => void;
  batchType: string;
  setBatchType: (v: string) => void;
  batchName: string;
  setBatchName: (v: string) => void;
  batchTtl: number;
  setBatchTtl: (v: number) => void;
  batchPriority: number;
  setBatchPriority: (v: number) => void;
  batchLine?: string;
  setBatchLine?: (v: string) => void;
  batchProxied: boolean;
  setBatchProxied: (v: boolean) => void;
  /**
   * 批量输入框的 ref。
   *
   * NOTE: 类型必须是 `MutableRefObject<T | null>` 而非 `RefObject<T>` ——
   * App.tsx 里是 `useRef<HTMLTextAreaElement | null>(null)` 创建的，
   * 其 `.current` 可写，与 `RefObject`（只读 current）不兼容。
   */
  batchTextareaRef: MutableRefObject<HTMLTextAreaElement | null>;
  /** 已解析出的有效行（组件只用其 length 渲染「已识别 N 条」，故只约束数组本身，
   *  让调用方可以传自己领域内的行类型，例如 ParsedDnsLine[]） */
  validBatchLines: ReadonlyArray<unknown>;
  batchResults: Array<{ label: string; success: boolean; message: string }> | null;
  onBatchCreate: () => void;

  // ===== 单条行内编辑 =====
  editingKey: string | null;
  setEditingKey: Dispatch<SetStateAction<string | null>>;
  editType: string;
  setEditType: (v: string) => void;
  editName: string;
  setEditName: (v: string) => void;
  editContent: string;
  setEditContent: (v: string) => void;
  editTtl: number;
  setEditTtl: (v: number) => void;
  editPriority: number;
  setEditPriority: (v: number) => void;
  editLine?: string;
  setEditLine?: (v: string) => void;
  editProxied: boolean;
  setEditProxied: (v: boolean) => void;
  onStartEditRecord: (rec: DnsRecord) => void;
  onUpdateRecord: () => void;
  onDeleteRecord: (rec: DnsRecord) => void;

  // ===== 多选与批量修改 =====
  selectedKeys: Set<string>;
  setSelectedKeys: Dispatch<SetStateAction<Set<string>>>;
  onToggleAllSelection: () => void;
  editPanelOpen: boolean;
  setEditPanelOpen: Dispatch<SetStateAction<boolean>>;
  onOpenEditPanel: () => void;
  editFields: { content: boolean; ttl: boolean; proxied: boolean };
  setEditFields: Dispatch<SetStateAction<{ content: boolean; ttl: boolean; proxied: boolean }>>;
  batchEditTtl: number;
  setBatchEditTtl: (v: number) => void;
  batchEditProxied: boolean;
  setBatchEditProxied: (v: boolean) => void;
  batchEditContents: Record<string, string>;
  setBatchEditContents: Dispatch<SetStateAction<Record<string, string>>>;
  /** 勾选了「记录值」时，逐条编辑行所需的目标记录 */
  batchEditTargets: Array<{ record_id: string; label: string; origin_content?: string }>;
  /** 实际发生变化的修改（用于按钮计数与禁用判断） */
  batchEditChanged: Array<unknown>;
  editResults: Array<{ label: string; success: boolean; message: string }> | null;
  onBatchUpdateRecords: () => void;
  onBatchDeleteRecords: () => void;
}

/** 批量操作结果行（批量添加 / 批量修改共用同一形状） */
export type DnsBatchResult = { label: string; success: boolean; message: string };
