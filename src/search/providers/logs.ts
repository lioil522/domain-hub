import type { SearchResult } from "../types";
export function logSearchResult(log: { id: number; message: string; category: string }): SearchResult {
  return { type: "log", id: String(log.id), title: log.message, subtitle: log.category, route: "logs" };
}
