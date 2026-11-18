import { lazyModal } from "../lib/lazy-modal";

export const BindAccountModal = lazyModal(() => import("../features/accounts/components/BindAccountModal"), "BindAccountModal",
  "绑定账号", p => p.open, p => p.onClose);
export const EditAccountModal = lazyModal(() => import("../features/accounts/components/EditAccountModal"), "EditAccountModal",
  "编辑账号", () => true, p => p.onClose);
export const CreateDomainModal = lazyModal(() => import("../features/domains/components/CreateDomainModal"), "CreateDomainModal",
  "添加域名", p => p.open, p => p.onClose);
export const DeleteDomainModal = lazyModal(() => import("../features/domains/components/DeleteDomainModal"), "DeleteDomainModal",
  "删除域名", () => true, p => p.onClose);
export const NameserverModal = lazyModal(() => import("../features/domains/components/NameserverModal"), "NameserverModal",
  "修改域名服务器", p => p.open, p => p.onClose);
export const DpNameserverModal = lazyModal(() => import("../features/domains/components/DpNameserverModal").then(m => ({ DpNameserverModal: m.DpNameserverModal })), "DpNameserverModal",
  "修改域名服务器", p => p.open, p => p.onClose);
export const DnsheDnsModal = lazyModal(() => import("../features/dns/components/DnsheDnsModal"), "DnsheDnsModal",
  "DNS 解析", p => p.open, p => p.onClose);
export const DnsRecordPanel = lazyModal(() => import("../components/DnsRecordPanel"), "DnsRecordPanel",
  "DNS 解析", p => p.open && !!p.zone, p => p.onClose);
export const CfEditModal = lazyModal(() => import("../features/cloudflare/components/CfEditModal"), "CfEditModal",
  "域名注册信息", p => p.open, p => p.onClose);
export const DataOpModal = lazyModal(() => import("../features/data/components/DataOpModal"), "DataOpModal",
  "数据导入导出", p => p.open, p => p.onClose);
export const CustomGroupModal = lazyModal(() => import("../features/custom/components/CustomModals"), "CustomGroupModal",
  "自定义分组", p => p.open, p => p.onClose);
export const CustomDomainModal = lazyModal(() => import("../features/custom/components/CustomModals"), "CustomDomainModal",
  "自定义域名", p => p.open, p => p.onClose);
export const CustomAccountModal = lazyModal(() => import("../features/custom/components/CustomModals"), "CustomAccountModal",
  "自定义账号", p => p.open, p => p.onClose);
export const CustomDeleteAccountModal = lazyModal(() => import("../features/custom/components/CustomModals"), "CustomDeleteAccountModal",
  "删除自定义账号", p => !!p.account, p => p.onCancel);
export const CustomDeleteGroupModal = lazyModal(() => import("../features/custom/components/CustomModals"), "CustomDeleteGroupModal",
  "删除自定义分组", p => !!p.group, p => p.onCancel);
export const CustomDeleteDomainModal = lazyModal(() => import("../features/custom/components/CustomModals"), "CustomDeleteDomainModal",
  "删除自定义域名", p => !!p.domain, p => p.onCancel);
