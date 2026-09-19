export type SearchResultType = "domain" | "account" | "dns" | "log";

export interface SearchResult {
  type: SearchResultType;
  id: string;
  title: string;
  subtitle?: string;
  provider?: string;
  route?: string;
  metadata?: Record<string, unknown>;
}
