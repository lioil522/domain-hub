/**
 * 主题注册表 —— 「配色身份」维度的唯一事实来源
 *
 * 架构（与 index.css 的令牌层一一对应）：
 *   维度一 · 主题（配色身份）→ <html data-theme="indigo|inkjade">  ← 本文件管理
 *   维度二 · 明暗（明度模式）→ <html class="dark">                ← 由 DNSHE_THEME 管理
 *
 * WHY 需要这个文件：
 *   主题名在四处被消费 —— ① index.css 的属性选择器，② theme-init.js 的首帧
 *   写入，③ 设置页的选择器，④ 展示页的色卡。若各处各写一份字符串字面量，
 *   新增主题时漏改一处就会出现「选得中但样式不生效」这种最难查的 bug。
 *   这里集中定义，其余三处都从这份清单派生。
 *
 * NOTE: 不能 import 到 theme-init.js —— 那是 CSP 要求下的原生外部脚本，
 * 在 React 打包链路之外，无法 import 模块。所以那边保持了独立的一份
 * 常量数组，并有注释指向本文件。改动时两边都要动（已在两边互相标注）。
 */

export type ThemeId = "indigo" | "inkjade";

export interface ThemeDefinition {
  id: ThemeId;
  /** 显示名，用中文 · 风格描述 */
  label: string;
  /** 一句话设计意图，供选择器副标题与展示页使用 */
  description: string;
  /**
   * 预览用的强调色三元组（亮色主色 / 暗色主色 / 亮色底）。
   * NOTE: 刻意写死而非读 CSS 变量 —— 选择器需要在「未切换到该主题」时
   * 就展示它的配色，读当前变量只会读到已生效主题的值，预览就失真了。
   * 这三个值必须与 index.css 中对应主题块保持一致。
   */
  swatch: {
    light: string;
    dark: string;
    surface: string;
  };
}

export const THEMES: ThemeDefinition[] = [
  {
    id: "indigo",
    label: "靛蓝 · 石板",
    description: "标准后台配色，冷调中性灰，信息密度优先",
    swatch: {
      light: "#5d60e3",
      dark: "#7c7ff5",
      surface: "#f1f5f9"
    }
  },
  {
    id: "inkjade",
    label: "墨玉 · 深青绿",
    description: "低饱和青绿配暖玉灰，降低长时间盯盘的视觉压迫",
    swatch: {
      light: "#1f7a68",
      dark: "#4ec9ac",
      surface: "#eef1ee"
    }
  }
];

export const DEFAULT_THEME: ThemeId = "indigo";

/**
 * id → 显示名的查表。
 * NOTE: 单独导出而非让调用处 `THEMES.find(...)?.label` —— 后者返回
 * `string | undefined`，在 JSX 里要写 `?? ""` 兜底，散落各处很啰嗦。
 * 这里的对象字面量由 Record<ThemeId, string> 约束，漏一个主题编译器就报错。
 */
export const THEME_LABELS: Record<ThemeId, string> = {
  indigo: "靛蓝 · 石板",
  inkjade: "墨玉 · 深青绿"
};

/** localStorage 键名。沿用 DNSHE_ 前缀以与项目既有约定一致 */
export const THEME_STORAGE_KEY = "DNSHE_COLOR_THEME";

const THEME_IDS = THEMES.map((t) => t.id);

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEME_IDS as string[]).includes(value);
}

/** 读取持久化的主题，非法值（旧数据 / 手改 localStorage）回落到默认主题 */
export function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeId(raw) ? raw : DEFAULT_THEME;
  } catch {
    // localStorage 在隐私模式 / 禁用 Cookie 时会抛异常，不应因此白屏
    return DEFAULT_THEME;
  }
}

/**
 * 把主题写到 <html data-theme>。
 *
 * WHY 单独抽成函数而不是直接写在 useEffect 里：
 *   展示页、选择器、App 的同步 effect 都要写这一个属性，且必须写法一致
 *   （用 setAttribute 而非 classList —— 主题是属性维度，与 .dark 类正交）。
 *   集中一处可以保证「属性只增不减」的清理逻辑不会漏。
 */
export function applyThemeAttribute(id: ThemeId): void {
  document.documentElement.setAttribute("data-theme", id);
}
