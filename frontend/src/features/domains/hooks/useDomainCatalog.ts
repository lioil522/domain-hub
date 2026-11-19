import { useEffect, useRef, useState } from "react";
import { useAppData } from "../../../state/AppDataContext";
import { apiJson } from "../../../api/request";
import type { Domain } from "../../../types/domain";
import type { CustomDomain } from "../../../types/custom";
import { CATALOG_PROVIDERS, type CatalogPage, type CatalogProvider, type CatalogSummary, type CatalogSearch } from "../../../../../shared/domain-catalog";
import { isCatalogPageResponse, isCatalogSearchResponse, isCatalogSummaryResponse } from "../utils/catalog-response";

export interface DomainPageState extends CatalogPage<Domain, CustomDomain> {
  loading: boolean;
  error: string | null;
  filter: string;
  focus: string;
  cursor: string | null;
  history: Array<string | null>;
}
const empty = (): DomainPageState => ({
  domains: [], custom_domains: [], next_cursor: null, total: 0, account_counts: {}, hints: {},
  loading: false, error: null, filter: "all", focus: "", cursor: null, history: [],
});
export function catalogProviderForTab(tab: string): CatalogProvider | null {
  if (tab === "domains") return "dnshe";
  return (CATALOG_PROVIDERS as readonly string[]).includes(tab) ? tab as CatalogProvider : null;
}

/** All rows are per-source pages; summary and search never derive from these partial arrays. */
export function useDomainCatalog(activeTab: string, search: string) {
  const { apiFetch, sessionToken, backendUrl, accounts } = useAppData();
  const [pages, setPages] = useState<Record<CatalogProvider, DomainPageState>>(
    () => Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, empty()])) as Record<CatalogProvider, DomainPageState>);
  const [summary, setSummary] = useState<CatalogSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [result, setResult] = useState<CatalogSearch | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const current = useRef({ activeTab, search, sessionToken });
  current.current = { activeTab, search, sessionToken };
  const pageRef = useRef(pages);
  const controllers = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  pageRef.current = pages;

  const refreshSummary = async () => {
    if (!current.current.sessionToken) return;
    controllers.current.get("summary")?.abort();
    const controller = new AbortController(), identity = generation.current;
    controllers.current.set("summary", controller);
    try {
      const data = await apiJson<{ summary: CatalogSummary }>(apiFetch, `/api/domains/summary?timezone_offset=${new Date().getTimezoneOffset()}`, { signal: controller.signal });
      if (controller.signal.aborted || identity !== generation.current) return;
      if (!isCatalogSummaryResponse(data)) throw new Error("全量摘要响应格式不正确，请确认前后端版本一致");
      setSummary(data.summary); setSummaryError(null);
    } catch (error) {
      if (!controller.signal.aborted && identity === generation.current) setSummaryError(error instanceof Error ? error.message : "摘要读取失败");
    }
  };
  const load = async (provider: CatalogProvider, changes: Partial<DomainPageState> = {}) => {
    if (!current.current.sessionToken) return;
    controllers.current.get(provider)?.abort();
    const controller = new AbortController(), identity = generation.current;
    controllers.current.set(provider, controller);
    const state = { ...pageRef.current[provider], ...changes, loading: true, error: null };
    pageRef.current = { ...pageRef.current, [provider]: state };
    setPages(pageRef.current);
    const params = new URLSearchParams({ provider, limit: "100", search: current.current.search.trim() });
    if (state.filter !== "all") params.set("account_id", state.filter);
    if (state.cursor) params.set("cursor", state.cursor);
    else if (state.focus) params.set("focus", state.focus);
    try {
      const data = await apiJson<CatalogPage<Domain, CustomDomain>>(apiFetch, `/api/domains/page?${params}`, { signal: controller.signal });
      if (controller.signal.aborted || identity !== generation.current) return;
      if (!isCatalogPageResponse(data)) throw new Error("分页响应格式或条数上限不正确");
      pageRef.current = { ...pageRef.current, [provider]: { ...state, ...data, loading: false } };
      setPages(pageRef.current);
    } catch (error) {
      if (controller.signal.aborted || identity !== generation.current) return;
      pageRef.current = { ...pageRef.current, [provider]: { ...state, domains: [], custom_domains: [], next_cursor: null, loading: false, error: error instanceof Error ? error.message : "分页读取失败" } };
      setPages(pageRef.current);
    }
  };
  const refresh = async (provider: CatalogProvider, filter?: string) => {
    void refreshSummary();
    if (catalogProviderForTab(current.current.activeTab) === provider) {
      await load(provider, { cursor: null, history: [], focus: "", ...(filter === undefined ? {} : { filter }) });
    } else {
      controllers.current.get(provider)?.abort();
      pageRef.current = { ...pageRef.current, [provider]: { ...empty(), filter: filter || pageRef.current[provider].filter } };
      setPages(pageRef.current);
    }
  };
  const source = (provider: CatalogProvider) => ({
    ...pages[provider],
    refresh: (filter?: string) => refresh(provider, filter),
    next: () => {
      const page = pageRef.current[provider];
      if (!page.loading && page.next_cursor) void load(provider, { cursor: page.next_cursor, history: [...page.history, page.cursor] });
    },
    previous: () => {
      const page = pageRef.current[provider];
      if (!page.loading && page.history.length) void load(provider, { cursor: page.history[page.history.length - 1], history: page.history.slice(0, -1) });
    },
    first: () => load(provider, { cursor: null, history: [], focus: "" }),
  });
  useEffect(() => {
    generation.current++;
    for (const controller of controllers.current.values()) controller.abort();
    pageRef.current = Object.fromEntries(CATALOG_PROVIDERS.map(provider => [provider, empty()])) as typeof pages;
    setPages(pageRef.current); setSummary(null); setResult(null); setSummaryError(null); setSearchError(null);
    if (sessionToken) void refreshSummary();
    return () => { generation.current++; for (const controller of controllers.current.values()) controller.abort(); };
    // API identity is explicitly reset on session/backend changes.
  }, [sessionToken, backendUrl]);
  useEffect(() => { if (sessionToken) void refreshSummary(); }, [accounts]);
  useEffect(() => {
    const provider = catalogProviderForTab(activeTab);
    if (!sessionToken || !provider) return;
    const state = { ...pageRef.current[provider], domains: [], custom_domains: [], loading: true,
      total: 0, next_cursor: null, cursor: null, history: [], error: null,
      focus: search.trim() ? "" : pageRef.current[provider].focus };
    pageRef.current = { ...pageRef.current, [provider]: state }; setPages(pageRef.current);
    const timer = window.setTimeout(() => { void load(provider, { cursor: null, history: [] }); }, search.trim() ? 250 : 0);
    return () => { window.clearTimeout(timer); controllers.current.get(provider)?.abort(); };
  }, [activeTab, search, sessionToken, backendUrl]);
  useEffect(() => {
    setResult(null); setSearchError(null);
    if (!sessionToken || !search.trim()) return;
    const controller = new AbortController(), identity = generation.current;
    const timer = window.setTimeout(async () => {
      try {
        const data = await apiJson<{ result: CatalogSearch }>(apiFetch, `/api/domains/search?search=${encodeURIComponent(search.trim())}`, { signal: controller.signal });
        if (!isCatalogSearchResponse(data)) throw new Error("搜索响应格式不正确");
        if (!controller.signal.aborted && identity === generation.current) setResult(data.result);
      } catch (error) {
        if (!controller.signal.aborted && identity === generation.current) setSearchError(error instanceof Error ? error.message : "搜索失败");
      }
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [search, sessionToken, backendUrl]);
  return {
    source, pages, summary, summaryError, result, searchError, refreshSummary,
    locate: (provider: CatalogProvider, name: string) => {
      // The navigation effect will load this scope after the tab/search state settles.
      controllers.current.get(provider)?.abort();
      pageRef.current = { ...pageRef.current, [provider]: { ...empty(), filter: "all", focus: name } };
      setPages(pageRef.current);
      if (catalogProviderForTab(current.current.activeTab) === provider && !current.current.search) void load(provider);
    },
    invalidateAll: () => { void refreshSummary(); const provider = catalogProviderForTab(current.current.activeTab); if (provider) void refresh(provider); },
  };
}
export type DomainPageSource = ReturnType<ReturnType<typeof useDomainCatalog>["source"]>;
