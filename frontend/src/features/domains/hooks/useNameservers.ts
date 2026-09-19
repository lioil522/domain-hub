import { useState } from "react";
import type { Domain } from "../../../types/domain";

/**
 * NS 修改弹窗的开关状态（DNSHE + DigitalPlat）
 *
 * 从 `App.tsx` 抽出（Phase 4-K）。两套弹窗都是纯粹的「打开时置入目标域名、
 * 关闭时清空」状态机，弹窗本体（`NameserverModal` / `DpNameserverModal`）各自
 * 在内部取数、维护草稿与保存，因此这里只保留开关与目标域名。
 *
 * 纯搬运，零逻辑改动：两处 `openXxxNsModal` 的赋值顺序与状态初值逐字保留。
 *
 * NOTE: 之所以把 DP 的那一对也收进来：它同样是「NS 弹窗状态」，且与 DNSHE 的
 * 那对完全同构（同样只有 open/close + 目标域名）。若 Phase 6 重构 DigitalPlat
 * 页时希望把它并入 DP 专属 hook，可再迁出 —— 届时只是移动，不涉逻辑。
 */
export function useNameservers() {
  // NS 修改模态框状态（弹窗本体见 features/domains/components/NameserverModal）
  const [nsModalOpen, setNsModalOpen] = useState(false);
  const [nsModalDomain, setNsModalDomain] = useState<Domain | null>(null);
  const openNsModal = (domain: Domain) => {
    setNsModalDomain(domain);
    setNsModalOpen(true);
  };

  // DigitalPlat 域名「修改 NS」弹窗
  const [dpNsModalOpen, setDpNsModalOpen] = useState(false);
  const [dpNsModalDomain, setDpNsModalDomain] = useState<Domain | null>(null);
  // 打开 DP「修改 NS」弹窗（取数/草稿/保存见 DpNameserverModal 内部）
  const openDpNsModal = (domain: Domain) => {
    setDpNsModalDomain(domain);
    setDpNsModalOpen(true);
  };

  return {
    nsModalOpen,
    setNsModalOpen,
    nsModalDomain,
    openNsModal,
    dpNsModalOpen,
    setDpNsModalOpen,
    dpNsModalDomain,
    openDpNsModal,
  };
}
