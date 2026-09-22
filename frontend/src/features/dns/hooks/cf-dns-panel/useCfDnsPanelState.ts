import { useRef, useState } from "react";
import type { Domain } from "../../../../types/domain";
import type { DnsRecord } from "../../../../types/dns";

export function useCfDnsPanelState() {
  // CF DNS 记录面板（模态框结构同 DNSHE 的 DNS 面板，但没有「解析线路」概念、多了「代理」开关）
  const [cfDnsModalOpen, setCfDnsModalOpen] = useState(false);
  const [cfSelectedZone, setCfSelectedZone] = useState<Domain | null>(null);
  const [cfRecords, setCfRecords] = useState<DnsRecord[]>([]);
  const [loadingCfRecords, setLoadingCfRecords] = useState(false);
  // 记录列表加载失败的原因（区别于「确实没有记录」的空态，避免误导用户去添加）
  const [cfRecordsError, setCfRecordsError] = useState<string | null>(null);
  // CF 新建记录表单（TTL 取值 1 表示 Cloudflare 的「自动」，其余托管商走标准 300）
  const [cfFormOpen, setCfFormOpen] = useState(false);
  const [cfNewType, setCfNewType] = useState("A");
  const [cfNewLine, setCfNewLine] = useState("default");
  const [cfNewName, setCfNewName] = useState("");
  const [cfNewContent, setCfNewContent] = useState("");
  const [cfNewTtl, setCfNewTtl] = useState(300);
  const [cfNewPriority, setCfNewPriority] = useState<number>(10);
  const [cfNewProxied, setCfNewProxied] = useState(false);
  // CF 行内修改
  const [cfEditingKey, setCfEditingKey] = useState<string | null>(null);
  const [cfEditType, setCfEditType] = useState("A");
  const [cfEditLine, setCfEditLine] = useState("default");
  const [cfEditName, setCfEditName] = useState("");
  const [cfEditContent, setCfEditContent] = useState("");
  const [cfEditTtl, setCfEditTtl] = useState(300);
  const [cfEditPriority, setCfEditPriority] = useState<number>(10);
  const [cfEditProxied, setCfEditProxied] = useState(false);
  // CF 批量添加
  const [cfBatchOpen, setCfBatchOpen] = useState(false);
  const [cfBatchInput, setCfBatchInput] = useState("");
  const [cfBatchType, setCfBatchType] = useState("A");
  const [cfBatchLine, setCfBatchLine] = useState("default");
  const [cfBatchName, setCfBatchName] = useState("");
  const [cfBatchTtl, setCfBatchTtl] = useState(300);
  const [cfBatchPriority, setCfBatchPriority] = useState<number>(10);
  const [cfBatchProxied, setCfBatchProxied] = useState(false);
  const [cfBatchResults, setCfBatchResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);
  // CF 批量添加输入框引用（自绘拖拽调整高度用）
  const cfBatchTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // CF 批量修改面板（字段：主机记录 / 记录值 / TTL / 代理）
  const [cfSelectedKeys, setCfSelectedKeys] = useState<Set<string>>(new Set());
  const [cfEditPanelOpen, setCfEditPanelOpen] = useState(false);
  const [cfEditFields, setCfEditFields] = useState({
    name: false,
    content: false,
    ttl: false,
    proxied: false
  });
  const [cfBatchEditName, setCfBatchEditName] = useState("");
  const [cfBatchEditTtl, setCfBatchEditTtl] = useState(300);
  const [cfBatchEditProxied, setCfBatchEditProxied] = useState(false);
  const [cfBatchEditContents, setCfBatchEditContents] = useState<Record<string, string>>({});
  const [cfEditResults, setCfEditResults] = useState<Array<{ label: string; success: boolean; message: string }> | null>(null);
  return {
    cfDnsModalOpen, setCfDnsModalOpen, cfSelectedZone, setCfSelectedZone, cfRecords, setCfRecords,
    loadingCfRecords, setLoadingCfRecords, cfRecordsError, setCfRecordsError,
    cfFormOpen, setCfFormOpen, cfNewType, setCfNewType, cfNewLine, setCfNewLine, cfNewName, setCfNewName,
    cfNewContent, setCfNewContent, cfNewTtl, setCfNewTtl, cfNewPriority, setCfNewPriority, cfNewProxied, setCfNewProxied,
    cfEditingKey, setCfEditingKey, cfEditType, setCfEditType, cfEditLine, setCfEditLine, cfEditName, setCfEditName,
    cfEditContent, setCfEditContent, cfEditTtl, setCfEditTtl, cfEditPriority, setCfEditPriority, cfEditProxied, setCfEditProxied,
    cfBatchOpen, setCfBatchOpen, cfBatchInput, setCfBatchInput, cfBatchType, setCfBatchType, cfBatchLine, setCfBatchLine,
    cfBatchName, setCfBatchName, cfBatchTtl, setCfBatchTtl, cfBatchPriority, setCfBatchPriority, cfBatchProxied, setCfBatchProxied,
    cfBatchResults, setCfBatchResults, cfBatchTextareaRef,
    cfSelectedKeys, setCfSelectedKeys, cfEditPanelOpen, setCfEditPanelOpen, cfEditFields, setCfEditFields,
    cfBatchEditName, setCfBatchEditName,
    cfBatchEditTtl, setCfBatchEditTtl, cfBatchEditProxied, setCfBatchEditProxied, cfBatchEditContents, setCfBatchEditContents, cfEditResults, setCfEditResults,
  };
}

export type UseCfDnsPanelStateReturn = ReturnType<typeof useCfDnsPanelState>;
