/**
 * 解析线路（Line）可选值
 *
 * NOTE: 取自官网 DNS 管理页 <select name="line"> 的 option value —— 提交值是英文代码
 * 而不是中文标签（「电信」只是显示文案，实际提交 telecom），且 oversea 没有尾部的 s。
 * API 文档只把 line 描述为「解析线路（us.ci/cn.mt可用，其他域名自动忽略）」，从未列出
 * 合法取值，因此这份清单以官网表单为准。
 */
export const DNS_LINE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "default", label: "默认" },
  { value: "telecom", label: "电信" },
  { value: "unicom", label: "联通" },
  { value: "mobile", label: "移动" },
  { value: "oversea", label: "海外" },
  { value: "edu", label: "教育网" }
];

/**
 * 支持按线路解析的 NS 后缀默认名单
 *
 * NOTE: 根域的 NS 记录暴露了它实际托管在谁家 DNS 上，这是判断「是否支持按线路
 * （运营商/地域）解析」最有语义的信号 —— 阿里云 DNS 本身就提供运营商线路，
 * 而 DNSHE 自建 NS 不提供。实测九个根域名分成三组，与官网标注完全对得上：
 *   cn.mt / us.ci                  -> vip7/vip8.alidns.com    支持线路
 *   bbroot.com / bot.cd / ccwu.cc  -> a/b.nic.dnshe.org       不支持
 *   cc.cd / ddns.ge / de5.net/l.cd -> a/b.ns.dnshe.org        不支持
 * 名单可在设置页增删，厂商日后把根域迁到别家（或另接一家支持线路的 DNS）时
 * 不必改代码。
 */
export const DEFAULT_LINE_NS_SUFFIXES = ["alidns.com"];

/**
 * 线路支持判定的兜底信号：解析服务商账号 ID（domains_cache.provider_account_id）
 *
 * NOTE: 这是 NS 判定之前用的主信号，现已降级为兜底 —— 仅在拿不到根域 NS 时
 * （首次加载未完成、后端 DoH 出站失败）使用，因此不再提供设置页 UI。
 * 实测 us.ci / cn.mt 该值为 1，其余 7 个根域名为 7 或 8，两组无交集；但文档
 * 从未说明该字段语义，属实测相关性而非契约，详见 src/dnshe.ts 里的注释。
 */
export const DEFAULT_LINE_PROVIDERS = ["1"];
