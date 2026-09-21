import { useAppData } from "../../../state/AppDataContext";
import { useCustomProvidersState } from "./custom-providers/useCustomProvidersState";
import { useCustomProvidersData } from "./custom-providers/useCustomProvidersData";
import { useCustomProvidersActions } from "./custom-providers/useCustomProvidersActions";
export type { DomainWithDays, AccountWithDomains, CustomGroup } from "./custom-providers/types";

export interface UseCustomProvidersOptions {
  isPermanentExpiry: (v?: string | null) => boolean;
}

export function useCustomProviders({ isPermanentExpiry }: UseCustomProvidersOptions) {
  const { apiFetch, showToast, accounts, fetchAccounts } = useAppData();
  const state = useCustomProvidersState();
  const { customGroupList, groupedCustomDomains } = useCustomProvidersData({
    accounts,
    customAccounts: state.customAccounts,
    customDomains: state.customDomains,
    customGroupFilter: state.customGroupFilter,
  });
  const actions = useCustomProvidersActions({
    state, groupedCustomDomains, apiFetch, showToast, fetchAccounts, isPermanentExpiry,
  });

  return {
    customGroupFilter: state.customGroupFilter,
    setCustomGroupFilter: state.setCustomGroupFilter,
    customGroupList, customAccounts: state.customAccounts, customDomains: state.customDomains,
    loadingCustomDomains: state.loadingCustomDomains, groupedCustomDomains,
    customCollapsedGroups: state.customCollapsedGroups,
    fetchCustomDomains: actions.fetchCustomDomains,
    customToggleGroupCollapse: actions.customToggleGroupCollapse,
    customToggleAllGroups: actions.customToggleAllGroups,
    customNewGroupOpen: state.customNewGroupOpen, setCustomNewGroupOpen: state.setCustomNewGroupOpen,
    customNewGroupAlias: state.customNewGroupAlias, setCustomNewGroupAlias: state.setCustomNewGroupAlias,
    customNewGroupWebsite: state.customNewGroupWebsite, setCustomNewGroupWebsite: state.setCustomNewGroupWebsite,
    customNewGroupSaving: state.customNewGroupSaving, customNewGroupMode: state.customNewGroupMode, setCustomNewGroupMode: state.setCustomNewGroupMode,
    customBatchRows: state.customBatchRows, setCustomBatchRows: state.setCustomBatchRows, customBatchResults: state.customBatchResults, setCustomBatchResults: state.setCustomBatchResults,
    handleCreateCustomGroup: actions.handleCreateCustomGroup, handleBatchCreateCustomGroups: actions.handleBatchCreateCustomGroups,
    customAccountModalOpen: state.customAccountModalOpen, setCustomAccountModalOpen: state.setCustomAccountModalOpen,
    customAccountModalGroup: state.customAccountModalGroup, customAccountName: state.customAccountName, setCustomAccountName: state.setCustomAccountName,
    customAccountSaving: state.customAccountSaving, openCustomAccountModal: actions.openCustomAccountModal, handleSaveCustomAccount: actions.handleSaveCustomAccount,
    customDomainModalOpen: state.customDomainModalOpen, setCustomDomainModalOpen: state.setCustomDomainModalOpen,
    customDomainModalGroup: state.customDomainModalGroup, customDomainModalAccount: state.customDomainModalAccount, customDomainModalEditing: state.customDomainModalEditing,
    customDomainFull: state.customDomainFull, setCustomDomainFull: state.setCustomDomainFull, customDomainRegistered: state.customDomainRegistered, setCustomDomainRegistered: state.setCustomDomainRegistered,
    customDomainExpiry: state.customDomainExpiry, setCustomDomainExpiry: state.setCustomDomainExpiry, customDomainRemark: state.customDomainRemark, setCustomDomainRemark: state.setCustomDomainRemark,
    customDomainSaving: state.customDomainSaving, openCustomDomainModal: actions.openCustomDomainModal, handleSaveCustomDomain: actions.handleSaveCustomDomain,
    customDeleteGroup: state.customDeleteGroup, setCustomDeleteGroup: state.setCustomDeleteGroup, customDeleteAccount: state.customDeleteAccount, setCustomDeleteAccount: state.setCustomDeleteAccount,
    customDeleteDomain: state.customDeleteDomain, setCustomDeleteDomain: state.setCustomDeleteDomain,
    handleDeleteCustomAccount: actions.handleDeleteCustomAccount, handleDeleteCustomDomain: actions.handleDeleteCustomDomain, handleDeleteCustomGroup: actions.handleDeleteCustomGroup,
  };
}
