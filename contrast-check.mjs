// 对比度校验 —— 验证两套主题 × 明暗 共 4 个组合下的关键前景/背景配对。
// 公式：WCAG 2.1 相对亮度 + (L1+0.05)/(L2+0.05)
//
// ⚠ 使用前必读：本脚本的色值是【手工维护】的下表，与 index.css 是两份独立数据。
//   这意味着它只能验证「色值本身的对比度」，**无法发现 CSS 层叠/特异性错误**。
//   曾经因此漏掉一个真实事故：墨玉亮色修正块漏写 `:not(.dark)`，导致暗色下
//   --text-primary 被覆盖成深墨绿 #14211f 压近黑底 #080f0e（1.17:1），
//   整个界面文字几乎不可见 —— 而本脚本当时全绿，因为表里的值是对的。
//
//   所以：**改完令牌层后，必须先跑 _cascade 式的层叠检查确认生效值，
//   再跑本脚本确认对比度**。或者更直接的办法 —— 用 `npm run check:cascade`
//   解析编译产物得到真实生效值（见 cascade-check.mjs），两者配合才完整。

function hexToRgb(h) {
  const s = h.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

function lin(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function lum(rgb) {
  const [r, g, b] = rgb;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** 把 "rgba(r,g,b,a)" 叠加到实底 base 上，返回合成后的 rgb */
function over(fg, alpha, base) {
  return fg.map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha)));
}

/** 统一解析为 { rgb:[r,g,b], a:number } */
function parse(s) {
  if (s.startsWith("#")) return { rgb: hexToRgb(s), a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/);
  const parts = m[1].split(",").map((x) => parseFloat(x.trim()));
  return { rgb: parts.slice(0, 3), a: parts.length > 3 ? parts[3] : 1 };
}

/** ratio(fg, bg, page) —— fg/bg 支持 rgba，逐层叠加到 page 实底上 */
function ratio(fgStr, bgStr, pageStr) {
  // ① 先算背景的实色：半透明底要叠在页面底色上（浏览器就是这么渲的）
  const page = pageStr ? parse(pageStr).rgb : [255, 255, 255];
  const bgp = parse(bgStr);
  const bgRgb = bgp.a < 1 ? over(bgp.rgb, bgp.a, page) : bgp.rgb;

  // ② 再看前景：半透明前景叠在已合成的背景上
  const fgp = parse(fgStr);
  const fgRgb = fgp.a < 1 ? over(fgp.rgb, fgp.a, bgRgb) : fgp.rgb;

  const L1 = lum(fgRgb);
  const L2 = lum(bgRgb);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  "靛蓝·亮": {
    accent: "#5d60e3",
    accentContrast: "#ffffff",
    bgBase: "#f1f5f9",
    bgSurface: "#ffffff",
    bgElevated: "#f8fafc",
    textPrimary: "#0f172a",
    textSecondary: "#334155",
    textMuted: "#627188",
    okFg: "#047857", okBg: "#ecfdf5",
    warnFg: "#b45309", warnBg: "#fffbeb",
    dangerFg: "#b91c1c", dangerBg: "#fef2f2",
    infoFg: "#1d4ed8", infoBg: "#eff6ff",
    idleFg: "#475569", idleBg: "#f1f5f9",
    srcDnsheFg: "#4f46e5", srcDnsheBg: "#eef2ff",
    srcCfFg: "#c2410c", srcCfBg: "#fff7ed",
    srcDpFg: "#047857", srcDpBg: "#ecfdf5",
    srcCustomFg: "#b45309", srcCustomBg: "#fffbeb"
  },
  "靛蓝·暗": {
    accent: "#7c7ff5",
    accentContrast: "#0b0a26",
    bgBase: "#090d14",
    bgSurface: "#0f151f",
    bgElevated: "#1a2433",
    textPrimary: "#ffffff",
    textSecondary: "#cbd5e1",
    textMuted: "#94a3b8",
    okFg: "#34d399", okBg: "rgba(16,185,129,0.14)",
    warnFg: "#fbbf24", warnBg: "rgba(245,158,11,0.14)",
    dangerFg: "#f87171", dangerBg: "rgba(239,68,68,0.14)",
    infoFg: "#60a5fa", infoBg: "rgba(59,130,246,0.14)",
    idleFg: "#94a3b8", idleBg: "rgba(148,163,184,0.12)",
    srcDnsheFg: "#a5b4fc", srcDnsheBg: "rgba(99,102,241,0.16)",
    srcCfFg: "#fdba74", srcCfBg: "rgba(249,115,22,0.16)",
    srcDpFg: "#6ee7b7", srcDpBg: "rgba(16,185,129,0.16)",
    srcCustomFg: "#fcd34d", srcCustomBg: "rgba(245,158,11,0.16)"
  },
  "墨玉·亮": {
    accent: "#1f7a68",
    accentContrast: "#ffffff",
    bgBase: "#eef1ee",
    bgSurface: "#ffffff",
    bgElevated: "#f6f8f6",
    textPrimary: "#14211f",
    textSecondary: "#3c4f4b",
    textMuted: "#5c726d",
    okFg: "#047857", okBg: "#ecfdf5",
    warnFg: "#b45309", warnBg: "#fffbeb",
    dangerFg: "#b91c1c", dangerBg: "#fef2f2",
    infoFg: "#1d4ed8", infoBg: "#eff6ff",
    idleFg: "#475569", idleBg: "#f1f5f9",
    srcDnsheFg: "#1c6d5d", srcDnsheBg: "#e4f1ee",
    srcCfFg: "#9c4d1c", srcCfBg: "#fbeee2",
    srcDpFg: "#476a35", srcDpBg: "#e8f0e4",
    srcCustomFg: "#83600f", srcCustomBg: "#f8eed4"
  },
  "墨玉·暗": {
    accent: "#4ec9ac",
    accentContrast: "#05201a",
    bgBase: "#080f0e",
    bgSurface: "#0d1615",
    bgElevated: "#172523",
    textPrimary: "#ffffff",
    textSecondary: "#cbd5e1",
    textMuted: "#94a3b8",
    okFg: "#34d399", okBg: "rgba(16,185,129,0.14)",
    warnFg: "#fbbf24", warnBg: "rgba(245,158,11,0.14)",
    dangerFg: "#f87171", dangerBg: "rgba(239,68,68,0.14)",
    infoFg: "#60a5fa", infoBg: "rgba(59,130,246,0.14)",
    idleFg: "#94a3b8", idleBg: "rgba(148,163,184,0.12)",
    srcDnsheFg: "#7fdcc5", srcDnsheBg: "rgba(78,201,172,0.16)",
    srcCfFg: "#e8b183", srcCfBg: "rgba(207,127,60,0.16)",
    srcDpFg: "#a8cf95", srcDpBg: "rgba(132,181,110,0.16)",
    srcCustomFg: "#e5c77e", srcCustomBg: "rgba(214,172,72,0.16)"
  },
  "流玻·亮": {
    accent: "#1c6e66",
    accentContrast: "#ffffff",
    bgBase: "#ebebeb",
    bgSurface: "#ffffff",
    bgElevated: "#f4f6f6",
    textPrimary: "#0d1a18",
    textSecondary: "#3c4949",
    textMuted: "#5c6a6a",
    okFg: "#047857", okBg: "#ecfdf5",
    warnFg: "#b45309", warnBg: "#fffbeb",
    dangerFg: "#b91c1c", dangerBg: "#fef2f2",
    infoFg: "#1d4ed8", infoBg: "#eff6ff",
    idleFg: "#475569", idleBg: "#f1f5f9",
    srcDnsheFg: "#1c6e66", srcDnsheBg: "#e0f0ed",
    srcCfFg: "#9c4a1a", srcCfBg: "#f8ece2",
    srcDpFg: "#3f6b3f", srcDpBg: "#e6f0e6",
    srcCustomFg: "#7e6009", srcCustomBg: "#f6eed6"
  },
  "流玻·暗": {
    accent: "#8ee1d9",
    accentContrast: "#04201c",
    bgBase: "#09100f",
    bgSurface: "#0f1a19",
    bgElevated: "#172625",
    textPrimary: "#ffffff",
    textSecondary: "#cbd5e1",
    textMuted: "#94a3b8",
    okFg: "#34d399", okBg: "rgba(16,185,129,0.14)",
    warnFg: "#fbbf24", warnBg: "rgba(245,158,11,0.14)",
    dangerFg: "#f87171", dangerBg: "rgba(239,68,68,0.14)",
    infoFg: "#60a5fa", infoBg: "rgba(59,130,246,0.14)",
    idleFg: "#94a3b8", idleBg: "rgba(148,163,184,0.12)",
    srcDnsheFg: "#9fe6de", srcDnsheBg: "rgba(142,225,217,0.16)",
    srcCfFg: "#e8b183", srcCfBg: "rgba(214,138,76,0.16)",
    srcDpFg: "#a8cf95", srcDpBg: "rgba(132,181,110,0.16)",
    srcCustomFg: "#e5c77e", srcCustomBg: "rgba(214,180,72,0.16)"
  }
};

let failures = 0;
let checks = 0;

function check(label, fg, bg, min, page) {
  checks++;
  const r = ratio(fg, bg, page);
  const pass = r >= min;
  if (!pass) failures++;
  const mark = pass ? "PASS" : "**FAIL**";
  console.log(
    `  ${mark}  ${r.toFixed(2)}:1 (min ${min})  ${label}   [${fg} on ${bg}]`
  );
  return r;
}

for (const [name, t] of Object.entries(themes)) {
  console.log(`\n════ ${name} ════`);

  console.log(" [正文 4.5:1]");
  check("text-primary / bg-base", t.textPrimary, t.bgBase, 4.5);
  check("text-primary / bg-surface", t.textPrimary, t.bgSurface, 4.5);
  check("text-secondary / bg-surface", t.textSecondary, t.bgSurface, 4.5);
  check("text-muted / bg-surface", t.textMuted, t.bgSurface, 4.5);
  check("text-muted / bg-base", t.textMuted, t.bgBase, 4.5);

  console.log(" [品牌实底上的前景 4.5:1]   ← 按钮/侧栏选中态");
  check("accent-contrast / accent", t.accentContrast, t.accent, 4.5);

  console.log(" [强调色作为文字 4.5:1]     ← 图标、链接、选中标签");
  check("accent / bg-surface", t.accent, t.bgSurface, 4.5);
  check("accent / bg-base", t.accent, t.bgBase, 4.5);
  check("accent / bg-elevated", t.accent, t.bgElevated, 4.5);

  console.log(" [状态徽章 4.5:1]  ← 半透明底先叠到 bg-surface 上");
  for (const k of ["ok", "warn", "danger", "info", "idle"]) {
    check(`${k}`, t[k + "Fg"], t[k + "Bg"], 4.5, t.bgSurface);
  }

  console.log(" [来源徽章 4.5:1]");
  check("dnshe", t.srcDnsheFg, t.srcDnsheBg, 4.5, t.bgSurface);
  check("cloudflare", t.srcCfFg, t.srcCfBg, 4.5, t.bgSurface);
  check("digitalplat", t.srcDpFg, t.srcDpBg, 4.5, t.bgSurface);
  check("custom", t.srcCustomFg, t.srcCustomBg, 4.5, t.bgSurface);
}

console.log(`\n${"═".repeat(52)}`);
console.log(`总计 ${checks} 项检查，失败 ${failures} 项`);
process.exit(failures > 0 ? 1 : 0);
