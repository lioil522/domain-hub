import { useMemo } from "react";
import type { AccountWithDomains, CustomGroup, DomainWithDays } from "./types";
import type { Account } from "../../../../types/account";
import type { CustomAccount, CustomDomain } from "../../../../types/custom";

export interface UseCustomProvidersDataOptions {
  accounts: Account[];
  customAccounts: CustomAccount[];
  customDomains: CustomDomain[];
  customGroupFilter: string;
}

export function useCustomProvidersData({ accounts, customAccounts, customDomains, customGroupFilter }: UseCustomProvidersDataOptions) {
  const customGroupList = useMemo(() => accounts.filter((a) => a.provider === "custom"), [accounts]);
  const groupedCustomDomains = useMemo(() => {
    const groups: CustomGroup[] = [];
    const groupById = new Map<number, CustomGroup>();
    const accountById = new Map<number, AccountWithDomains>();
    const toDaysLeft = (d: CustomDomain): DomainWithDays => {
      const expiresTime = new Date(d.expires_at).getTime();
      const daysLeft = Number.isNaN(expiresTime) ? 0 : (expiresTime - Date.now()) / (1000 * 60 * 60 * 24);
      return { ...d, daysLeft };
    };
    customGroupList.forEach((g) => {
      if (customGroupFilter !== "all" && String(g.id) !== customGroupFilter) return;
      const group: CustomGroup = { groupId: g.id, alias: g.alias, website: g.website || null, unassignedDomains: [], accounts: [], domainCount: 0 };
      groupById.set(g.id, group); groups.push(group);
    });
    customAccounts.forEach((a) => {
      const group = groupById.get(a.group_id); if (!group) return;
      const acc: AccountWithDomains = { ...a, domains: [] }; accountById.set(a.id, acc); group.accounts.push(acc);
    });
    customDomains.forEach((d) => {
      if (d.account_id == null) {
        const group = groupById.get(d.group_id); if (!group) return;
        group.unassignedDomains.push(toDaysLeft(d)); group.domainCount++; return;
      }
      const acc = accountById.get(d.account_id); if (!acc) return;
      acc.domains.push(toDaysLeft(d)); const group = groupById.get(acc.group_id); if (group) group.domainCount++;
    });
    return groups;
  }, [customGroupList, customAccounts, customDomains, customGroupFilter]);
  return { customGroupList, groupedCustomDomains };
}
