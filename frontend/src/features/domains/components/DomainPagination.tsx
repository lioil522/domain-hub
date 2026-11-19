import type { DomainPageSource } from "../hooks/useDomainCatalog";
export function DomainPagination({ page }: { page: DomainPageSource }) {
  return (
    <section aria-label="域名分页" className="flex flex-wrap items-center gap-3 p-3 mt-4 border border-border-base rounded-xl bg-surface text-sm text-content-secondary">
      <span>{page.loading ? "正在读取本页…" : page.error ? "当前页读取失败，无法判断条数" : `共 ${page.total} 条 · 本页 ${page.domains.length + page.custom_domains.length} 条 · 每页最多 100 条`}</span>
      {page.focus && <span>正在定位「{page.focus}」</span>}
      <button type="button" onClick={() => void page.first()} disabled={page.loading} className="underline">返回首页</button>
      <button type="button" onClick={page.previous} disabled={page.loading || !page.history.length} className="disabled:opacity-40">上一页</button>
      <button type="button" onClick={page.next} disabled={page.loading || !page.next_cursor} className="disabled:opacity-40">下一页</button>
      {page.error && <p role="alert">{page.error} <button type="button" onClick={() => void page.first()} className="underline">重试</button></p>}
    </section>
  );
}
