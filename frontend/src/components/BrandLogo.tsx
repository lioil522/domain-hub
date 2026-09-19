/**
 * BrandLogo —— 服务商真实品牌图标（彩色）
 *
 * WHY 需要它：
 * 侧栏、来源徽章、账号卡片原先一律用 lucide 的通用线性图标（Globe / Cloud /
 * Server / Triangle）配「来源色」来区分服务商。问题是 Cloudflare 和华为云都可能
 * 是个「云朵」、DNSPod 和阿里云都是「服务器」—— 用户必须读文字才知道是哪家。
 * 服务商图标的首要职责是「一眼认得出」，通用图标做不到这件事。
 *
 * 设计约定：
 * 1. **形状取自各家官方 logo**（Alibaba Cloud / Huawei / Cloudflare / Vercel
 *    四个直接采用官方矢量路径，形状未经改动），不做艺术加工 ——
 *    认出来靠的是形状，不是颜色。
 * 2. 这些图形**不参与主题换色**：阿里云永远是橙、华为永远是红。
 *    这与主题令牌（--source-*-fg）是两套不同用途的东西：后者是给文字/徽章底色
 *    做的可访问性色，已经刻意调深以保证对比度；拿来做 logo 会让阿里云偏暗红、
 *    Vercel 偏灰，失去品牌辨识度。
 * 3. viewBox 统一 `0 0 24 24`，让它可以和 lucide 图标直接互换位置而不破版。
 * 4. `size` 走 width/height，默认 `1em` —— 放进文字流能跟随 font-size 自动缩放。
 * 5. `mono` 模式下全部渲染为 `currentColor`，供「选中态压在品牌渐变上」使用
 *    （彩色 logo 压在青绿/靛蓝渐变上会糊成一团，必须降为单色）。
 * 6. 组件默认 `aria-hidden` —— 调用处紧邻就有服务商名文字，读屏重复朗读是噪音。
 *    需要独立可访问名称时传 `label`。
 */

/** 与 TabKey / BadgeSource / NavSource 的来源部分对齐 */
export type BrandKey =
  | "dnshe"
  | "cloudflare"
  | "digitalplat"
  | "dnspod"
  | "alidns"
  | "huaweicloud"
  | "vercel"
  | "custom";

/*
 * 位图品牌图标 —— DNSHE 与 DNSPod 用官方/官方渠道发布的位图原图，而非矢量。
 *
 * WHY 不用矢量重绘：这两家的标识包含渐变与不规则曲线（DNSHE 是蓝底圆角方 +
 * 白绿弧形 + 字母 D；DNSPod 是蓝青渐变的云与环）。靠手写 path 复刻会失真 ——
 * 本项目上一轮已有前车之鉴：我当时凭印象画的阿里云/华为云标识渲染出来
 * 与官方毫无关系。既然拿得到权威原图，就没有理由再去猜。
 *
 * 资源放 public/brands/，由 Vite 原样拷进 dist 并按绝对路径引用，
 * 避免被打进 JS bundle（位图 base64 会让主包无谓膨胀）。
 *
 * NOTE: 这两张图**自带品牌底色**（DNSHE 是蓝底方块），因此：
 * - 不能叠加在任何色底上（会露出方角）→ 调用处统一给 --radius-sm 圆角裁切
 * - mono 模式下无法降为单色（位图没有 alpha-only 版本）→ 回退到矢量兜底图形
 */
const RASTER_BRANDS: Partial<Record<BrandKey, { src: string; alt: string }>> = {
  dnshe: { src: "/brands/dnshe.png", alt: "DNSHE" },
  dnspod: { src: "/brands/dnspod.webp", alt: "DNSPod" }
};

export interface BrandLogoProps {
  brand: BrandKey;
  /** 尺寸。数字按 px，字符串原样透传（默认 1em，随字号缩放） */
  size?: number | string;
  /** 降为单色（继承 currentColor），用于选中态/高对比场景 */
  mono?: boolean;
  className?: string;
  /** 提供独立可访问名称；不传则该图标对辅助技术隐藏 */
  label?: string;
  /** 位图图标的圆角裁切半径，默认取 --radius-sm */
  rounded?: string;
}

/*
 * 各家品牌原色 —— 取官方 logo 的标准色值。
 */
const BRAND_COLORS = {
  /** 腾讯云蓝 —— DNSPod 现属腾讯云 */
  dnspod: "#0052D9",
  /** 阿里云橙 —— 官方主色 */
  alidns: "#FF6A00",
  /** 华为 —— 官方主色 */
  huawei: "#C7000B",
  /** Cloudflare 橙 */
  cloudflare: "#F38020",
  /** DigitalPlat 绿（无官方视觉标识，沿用现有来源色） */
  digitalplat: "#059669",
  /** Vercel 黑（官方为纯单色品牌；暗色下需反转为白，见下） */
  vercel: "#000000",
  /** DNSHE 靛蓝（本项目自有品牌色） */
  dnshe: "#4F46E5",
  /** 自定义琥珀 */
  custom: "#B45309"
} as const;

/*
 * —— 官方矢量路径 ——
 * 取自 simple-icons（CC0），对应各家官方发布的标准标识形状，未做改动。
 */
const PATHS = {
  /** Alibaba Cloud 官方标识：左右两个方括号 + 中间横杠 */
  alibabacloud:
    "M3.996 4.517h5.291L8.01 6.324 4.153 7.506a1.668 1.668 0 0 0-1.165 1.601v5.786a1.668 1.668 0 0 0 1.165 1.6l3.857 1.183 1.277 1.807H3.996A3.996 3.996 0 0 1 0 15.487V8.513a3.996 3.996 0 0 1 3.996-3.996m16.008 0h-5.291l1.277 1.807 3.857 1.182c.715.227 1.17.889 1.165 1.601v5.786a1.668 1.668 0 0 1-1.165 1.6l-3.857 1.183-1.277 1.807h5.291A3.996 3.996 0 0 0 24 15.487V8.513a3.996 3.996 0 0 0-3.996-3.996m-4.007 8.345H8.002v-1.804h7.995Z",
  /** Huawei 官方标识：八瓣层叠花瓣 */
  huawei:
    "M3.67 6.14S1.82 7.91 1.72 9.78v.35c.08 1.51 1.22 2.4 1.22 2.4 1.83 1.79 6.26 4.04 7.3 4.55 0 0 .06.03.1-.01l.02-.04v-.04C7.52 10.8 3.67 6.14 3.67 6.14zM9.65 18.6c-.02-.08-.1-.08-.1-.08l-7.38.26c.8 1.43 2.15 2.53 3.56 2.2.96-.25 3.16-1.78 3.88-2.3.06-.05.04-.09.04-.09zm.08-.78C6.49 15.63.21 12.28.21 12.28c-.15.46-.2.9-.21 1.3v.07c0 1.07.4 1.82.4 1.82.8 1.69 2.34 2.2 2.34 2.2.7.3 1.4.31 1.4.31.12.02 4.4 0 5.54 0 .05 0 .08-.05.08-.05v-.06c0-.03-.03-.05-.03-.05zM9.06 3.19a3.42 3.42 0 00-2.57 3.15v.41c.03.6.16 1.05.16 1.05.66 2.9 3.86 7.65 4.55 8.65.05.05.1.03.1.03a.1.1 0 00.06-.1c1.06-10.6-1.11-13.42-1.11-13.42-.32.02-1.19.23-1.19.23zm8.299 2.27s-.49-1.8-2.44-2.28c0 0-.57-.14-1.17-.22 0 0-2.18 2.81-1.12 13.43.01.07.06.08.06.08.07.03.1-.03.1-.03.72-1.03 3.9-5.76 4.55-8.64 0 0 .36-1.4.02-2.34zm-2.92 13.07s-.07 0-.09.05c0 0-.01.07.03.1.7.51 2.85 2 3.88 2.3 0 0 .16.05.43.06h.14c.69-.02 1.9-.37 3-2.26l-7.4-.25zm7.83-8.41c.14-2.06-1.94-3.97-1.94-3.98 0 0-3.85 4.66-6.67 10.8 0 0-.03.08.02.13l.04.01h.06c1.06-.53 5.46-2.77 7.28-4.54 0 0 1.15-.93 1.21-2.42zm1.52 2.14s-6.28 3.37-9.52 5.55c0 0-.05.04-.03.11 0 0 .03.06.07.06 1.16 0 5.56 0 5.67-.02 0 0 .57-.02 1.27-.29 0 0 1.56-.5 2.37-2.27 0 0 .73-1.45.17-3.14z",
  /** Cloudflare 官方标识：双云带 + 日芒 */
  cloudflare:
    "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
  /** Vercel 官方标识：等腰三角形 */
  vercel: "m12 1.608 12 20.784H0Z"
} as const;

export function BrandLogo(props: BrandLogoProps) {
  const { brand, size = "1em", mono = false, className, label, rounded } = props;

  const dim = typeof size === "number" ? `${size}px` : size;
  const pick = (color: string) => (mono ? "currentColor" : color);

  /*
   * 位图品牌：非 mono 时优先渲染官方原图。
   *
   * NOTE: mono 必须回退到矢量 —— 位图没有 alpha-only 版本，强行用 CSS
   * filter 去色会得到一个灰方块，压在品牌渐变上比彩色还难看。
   * 选中态的诉求是「辨识」+「不糊」，此时矢量轮廓已经足够。
   */
  const raster = RASTER_BRANDS[brand];
  if (raster && !mono) {
    return (
      <img
        src={raster.src}
        alt={label ?? ""}
        width={dim}
        height={dim}
        /* 位图自带底色方块，必须圆角裁切，否则在圆角容器/渐变底上露出直角。
           NOTE: 默认 `50%`（圆形）而不是小圆角 —— 两张原图都是「圆形/圆角方
           主体 + 居中构图」，裁圆在任何底上都最干净，也不会切到图形本身。 */
        style={{
          flexShrink: 0,
          borderRadius: rounded ?? "50%",
          objectFit: "cover",
          display: "block"
        }}
        className={className}
        aria-hidden={label ? undefined : true}
        aria-label={label}
        draggable={false}
      />
    );
  }

  const common = {
    width: dim,
    height: dim,
    viewBox: "0 0 24 24",
    className,
    role: label ? ("img" as const) : undefined,
    "aria-hidden": label ? undefined : true,
    "aria-label": label,
    focusable: "false" as const,
    style: { flexShrink: 0 }
  };

  switch (brand) {
    /* ---------- Cloudflare：官方标识 ---------- */
    case "cloudflare":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path fill={pick(BRAND_COLORS.cloudflare)} d={PATHS.cloudflare} />
        </svg>
      );

    /* ---------- DNSPod ----------
     * 彩色走 public/brands/dnspod.webp（官方渠道原图，见 RASTER_BRANDS）。
     * 这里只负责 mono 兜底：simple-icons 未收录 DNSPod，故用腾讯云蓝的
     * 「云 + 环」轮廓呼应官方图形，配 DNS 记录意象。
     * NOTE: 刻意不硬凑一个「像腾讯云」的形状 —— 那会让人误认成腾讯云本体。 */
    case "dnspod":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path
            d="M6.2 15.2a4.2 4.2 0 0 1 .6-8.3 5.3 5.3 0 0 1 10.2 1.2 3.6 3.6 0 0 1-1 7.1"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M8.6 15.2h7.2M8.6 18.6h4.6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.1"
            strokeLinecap="round"
          />
        </svg>
      );

    /* ---------- 阿里云：官方标识 ---------- */
    case "alidns":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path fill={pick(BRAND_COLORS.alidns)} d={PATHS.alibabacloud} />
        </svg>
      );

    /* ---------- 华为云：官方标识 ---------- */
    case "huaweicloud":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path fill={pick(BRAND_COLORS.huawei)} d={PATHS.huawei} />
        </svg>
      );

    /* ---------- Vercel：官方标识 ----------
     * Vercel 是纯单色品牌（正黑/正白），没有人眼可辨的「品牌色」。
     * 因此这里不能用固定黑 —— 暗色主题下黑三角压深底等于隐形。
     *
     * NOTE: 这里刻意**不**用 Tailwind 的 `dark:fill-*` 类。原因是该类依赖祖先
     * 上存在 `.dark`，一旦这个组件出现在主题容器之外（弹窗 portal、独立预览页、
     * 未来的邮件模板），黑色三角就会在深底上彻底隐形 —— 而且是静默的。
     * 改用 CSS 变量 `--text-primary`：它由主题层保证「亮色为深、暗色为浅」，
     * 天然满足「单色品牌标识需要随明暗反转」的诉求，且不依赖祖先类。
     * 该变量未定义时回退到 `currentColor`，仍然安全。 */
    case "vercel":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path
            d={PATHS.vercel}
            fill={
              mono
                ? "currentColor"
                : "var(--text-primary, currentColor)"
            }
          />
        </svg>
      );

    /* ---------- DNSHE ----------
     * 彩色走 public/brands/dnshe.png（官网 favicon 原图，见 RASTER_BRANDS）。
     * 这里只负责 mono 兜底：按官方图形的构图还原「圆环 + 缺口 + D」。
     * 官方原图是蓝底圆角方 + 白/绿双色弧形 + 居中字母 D，mono 下用
     * 「开口圆环 + 弧段 + D」三笔表达同一构图，足够辨识。 */
    case "dnshe":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          {/* 主圆环（留右上缺口，呼应官方弧线的断口） */}
          <path
            d="M12 3.2a8.8 8.8 0 1 0 8.8 8.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          {/* 右上弧段（官方图形里那一抹独立的高光弧） */}
          <path
            d="M13.4 4.1a8.8 8.8 0 0 1 4.9 3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            opacity={mono ? 0.55 : 1}
          />
          {/* 居中字母 D */}
          <path
            d="M9.9 8.6h2.3a3.4 3.4 0 0 1 0 6.8H9.9V8.6Zm1.9 1.7v3.4h.4a1.7 1.7 0 0 0 0-3.4h-.4Z"
            fill="currentColor"
          />
        </svg>
      );

    /* ---------- DigitalPlat：无官方视觉标识 —— 双环 + 圆心 ---------- */
    case "digitalplat":
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path
            fill={pick(BRAND_COLORS.digitalplat)}
            d="M12 2.2c-5.4 0-9.8 4.4-9.8 9.8s4.4 9.8 9.8 9.8 9.8-4.4 9.8-9.8S17.4 2.2 12 2.2Zm0 3c3.8 0 6.8 3 6.8 6.8s-3 6.8-6.8 6.8-6.8-3-6.8-6.8 3-6.8 6.8-6.8Z"
          />
          <circle cx="12" cy="12" r="3.1" fill={mono ? "currentColor" : "#34D399"} />
        </svg>
      );

    /* ---------- 自定义：立方体（自有域名，无上游服务商） ---------- */
    case "custom":
    default:
      return (
        <svg {...common} xmlns="http://www.w3.org/2000/svg">
          {label && <title>{label}</title>}
          <path
            fill={pick(BRAND_COLORS.custom)}
            d="M12 2.4 21 7.3v9.4L12 21.6 3 16.7V7.3l9-4.9Zm0 3.2L6.1 8.8 12 12l5.9-3.2L12 5.6Zm-6.6 5.3v5l5.2 2.8v-5l-5.2-2.8Z"
          />
        </svg>
      );
  }
}

/**
 * 把后端/前端的各种「服务商字符串」归一为 BrandKey。
 *
 * WHY 需要它：同一个服务商在不同位置叫不同名字 ——
 * 后端 `account_provider` 用小写键（"cloudflare"）、域名列表用展示名（"Cloudflare"）、
 * 阿里云在侧栏叫「阿里云 DNS」但在 MULTI_PROVIDER_META 里是 "alidns"。
 * 收敛成一个函数，避免每个调用处各写一份 startsWith / includes。
 */
export function toBrandKey(raw?: string | null): BrandKey | null {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return null;

  if (s.includes("dnshe")) return "dnshe";
  if (s.includes("cloudflare") || s === "cf") return "cloudflare";
  if (s.includes("digitalplat") || s === "dp") return "digitalplat";
  if (s.includes("dnspod") || s.includes("腾讯")) return "dnspod";
  if (s.includes("ali") || s.includes("阿里")) return "alidns";
  if (s.includes("huawei") || s.includes("华为")) return "huaweicloud";
  if (s.includes("vercel")) return "vercel";
  if (s.includes("自定义") || s.includes("custom")) return "custom";
  return null;
}

export default BrandLogo;
