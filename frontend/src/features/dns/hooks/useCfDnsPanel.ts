import { useAppData } from "../../../state/AppDataContext";
import type { DnsRecordPanelProps } from "../../../components/DnsRecordPanel";
import { useCfDnsPanelState } from "./cf-dns-panel/useCfDnsPanelState";
import { useCfDnsPanelMeta } from "./cf-dns-panel/useCfDnsPanelMeta";
import { useCfDnsPanelActions } from "./cf-dns-panel/useCfDnsPanelActions";

export interface UseCfDnsPanelOptions {
  actionLoading: string | null;
  setActionLoading: (v: string | null) => void;
}
export type DnsPanelProps = DnsRecordPanelProps;

/**
 * 共用 DNS 解析面板控制器。
 * State / provider meta / mutations 分层，页面入口仍只消费 dnsPanelProps 与两个打开动作。
 */
export function useCfDnsPanel({ actionLoading, setActionLoading }: UseCfDnsPanelOptions) {
  const { apiFetch, showToast } = useAppData();
  const state = useCfDnsPanelState();
  const meta = useCfDnsPanelMeta(state.cfSelectedZone);
  const actions = useCfDnsPanelActions({ state, meta, apiFetch, showToast, setActionLoading });

  const { dnsPanelMeta } = meta;
  const {
    cfDnsModalOpen, cfSelectedZone, cfRecords, loadingCfRecords, cfRecordsError,
    cfFormOpen, setCfFormOpen, cfNewType, setCfNewType, cfNewLine, setCfNewLine, cfNewName, setCfNewName,
    cfNewContent, setCfNewContent, cfNewTtl, setCfNewTtl, cfNewPriority, setCfNewPriority, cfNewProxied, setCfNewProxied,
    cfBatchOpen, setCfBatchOpen, cfBatchInput, setCfBatchInput, cfBatchType, setCfBatchType, cfBatchLine, setCfBatchLine,
    cfBatchName, setCfBatchName, cfBatchTtl, setCfBatchTtl, cfBatchPriority, setCfBatchPriority, cfBatchProxied, setCfBatchProxied,
    cfBatchResults, cfBatchTextareaRef, cfEditingKey, setCfEditingKey, cfEditType, setCfEditType, cfEditLine, setCfEditLine,
    cfEditName, setCfEditName, cfEditContent, setCfEditContent, cfEditTtl, setCfEditTtl, cfEditPriority, setCfEditPriority,
    cfEditProxied, setCfEditProxied, cfEditPanelOpen, setCfEditPanelOpen, cfEditFields, setCfEditFields,
    cfBatchEditTtl, setCfBatchEditTtl, cfBatchEditProxied, setCfBatchEditProxied, cfBatchEditContents, setCfBatchEditContents, cfEditResults,
  } = state;
  const { cfValidBatchLines, handleCfBatchCreate, handleCfCreateRecord, handleCfOpenEditPanel, handleCfBatchUpdateRecords, handleCfBatchDeleteRecords,
    cfBatchEditTargets, cfBatchEditChanged } = actions;

  const dnsPanelProps: DnsPanelProps = {
    open: cfDnsModalOpen,
    zone: cfSelectedZone,
    meta: dnsPanelMeta,
    onClose: () => state.setCfDnsModalOpen(false),
    records: cfRecords,
    loadingRecords: loadingCfRecords,
    recordsError: cfRecordsError,
    onReload: (force?: boolean) => { if (cfSelectedZone) void actions.reloadCfRecords(cfSelectedZone, force); },
    actionLoading,
    formOpen: cfFormOpen,
    setFormOpen: setCfFormOpen,
    newType: cfNewType, setNewType: setCfNewType,
    newLine: cfNewLine, setNewLine: setCfNewLine,
    newName: cfNewName, setNewName: setCfNewName,
    newContent: cfNewContent, setNewContent: setCfNewContent,
    newTtl: cfNewTtl, setNewTtl: setCfNewTtl,
    newPriority: cfNewPriority, setNewPriority: setCfNewPriority,
    newProxied: cfNewProxied, setNewProxied: setCfNewProxied,
    onCreateRecord: handleCfCreateRecord,
    batchOpen: cfBatchOpen, setBatchOpen: setCfBatchOpen,
    batchInput: cfBatchInput, setBatchInput: setCfBatchInput,
    batchType: cfBatchType, setBatchType: setCfBatchType,
    batchLine: cfBatchLine, setBatchLine: setCfBatchLine,
    batchName: cfBatchName, setBatchName: setCfBatchName,
    batchTtl: cfBatchTtl, setBatchTtl: setCfBatchTtl,
    batchPriority: cfBatchPriority, setBatchPriority: setCfBatchPriority,
    batchProxied: cfBatchProxied, setBatchProxied: setCfBatchProxied,
    batchTextareaRef: cfBatchTextareaRef,
    validBatchLines: cfValidBatchLines,
    batchResults: cfBatchResults,
    onBatchCreate: handleCfBatchCreate,
    editingKey: cfEditingKey, setEditingKey: setCfEditingKey,
    editType: cfEditType, setEditType: setCfEditType,
    editLine: cfEditLine, setEditLine: setCfEditLine,
    editName: cfEditName, setEditName: setCfEditName,
    editContent: cfEditContent, setEditContent: setCfEditContent,
    editTtl: cfEditTtl, setEditTtl: setCfEditTtl,
    editPriority: cfEditPriority, setEditPriority: setCfEditPriority,
    editProxied: cfEditProxied, setEditProxied: setCfEditProxied,
    onUpdateRecord: actions.handleCfUpdateRecord,
    selectedKeys: state.cfSelectedKeys, setSelectedKeys: state.setCfSelectedKeys,
    onToggleAllSelection: actions.cfToggleAllSelection,
    editPanelOpen: cfEditPanelOpen, setEditPanelOpen: setCfEditPanelOpen,
    editFields: cfEditFields, setEditFields: setCfEditFields,
    batchEditTtl: cfBatchEditTtl, setBatchEditTtl: setCfBatchEditTtl,
    batchEditProxied: cfBatchEditProxied, setBatchEditProxied: setCfBatchEditProxied,
    batchEditContents: cfBatchEditContents, setBatchEditContents: setCfBatchEditContents,
    batchEditTargets: cfBatchEditTargets,
    batchEditChanged: cfBatchEditChanged,
    editResults: cfEditResults,
    onOpenEditPanel: handleCfOpenEditPanel,
    onBatchUpdateRecords: handleCfBatchUpdateRecords,
    onBatchDeleteRecords: handleCfBatchDeleteRecords,
    onDeleteRecord: actions.handleCfDeleteRecord,
    onStartEditRecord: actions.handleCfStartEditRecord,
  };

  return { dnsPanelProps, handleCfOpenDnsModal: actions.handleCfOpenDnsModal, handleDpOpenDnsModal: actions.handleDpOpenDnsModal };
}
