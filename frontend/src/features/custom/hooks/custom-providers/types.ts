import type { CustomAccount, CustomDomain } from "../../../../types/custom";
export type DomainWithDays = CustomDomain & { daysLeft: number };
export type AccountWithDomains = CustomAccount & { domains: DomainWithDays[] };
export interface CustomGroup {
  groupId: number;
  alias: string;
  website: string | null;
  unassignedDomains: DomainWithDays[];
  accounts: AccountWithDomains[];
  domainCount: number;
}
