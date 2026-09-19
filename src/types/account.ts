import type { ProviderId } from "./provider";

export interface AccountModel {
  id: string;
  alias: string;
  provider: ProviderId;
  createdAt?: string;
}
