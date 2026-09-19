// 层叠校验 —— 从编译产物解析每个「主题 × 明暗」组合下各令牌的【真实生效值】。
//
// WHY 需要这个脚本（这是一次真实事故的产物）：
//   对比度校验（contrast-check.mjs）用的是一张手工维护的色值表，它只能验证
//   「这些色值搭配起来够不够对比」。但令牌是走 CSS 层叠生效的 —— 选择器写错、
//   特异性不够、源码顺序不对，都会让某个令牌在某个组合下拿到【另一个块的值】。
//   这种情况对比度脚本完全看不出来（表里的值是对的，只是没生效）。
//
//   真实事故：`[data-theme="inkjade"]` 这个「墨玉亮色中性色」块漏写 :not(.dark)，
//   于是暗色下它也命中，且排在 .dark 之后，把 --text-primary 覆盖成亮色的
//   深墨绿 #14211f。深墨绿字压近黑底 #080f0e → 对比度 1.17:1，界面文字
//   几乎不可见。contrast-check.mjs 当时 72 项全绿，因为它查的不是生效值。
//
// 本脚本的职责：模拟浏览器层叠（特异性 → 源码顺序），算出真实生效值，
// 然后 ① 断言关键令牌符合该组合的预期，② 顺手算一遍对比度作为兜底。
//
// 用法：node cascade-check.mjs   （需先 vite build）
//      npm run check:cascade
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const distAssets = join(here, "frontend", "dist", "assets");

// ─────────────────────────── 颜色工具 ───────────────────────────
function hexToRgb(h) {
  const s = h.replace("#", "");
  const n = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}
function lin(c) { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
function lum(rgb) { const [r, g, b] = rgb; return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b); }
function over(fg, a, base) { return fg.map((c, i) => Math.round(c * a + base[i] * (1 - a))); }
function parse(s) {
  if (!s) return null;
  if (s.startsWith("#")) return { rgb: hexToRgb(s), a: 1 };
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
  }
  return null;
}
function ratio(fg, bg, page) {
  const pg = page ? parse(page)?.rgb : [255, 255, 255];
  const bp = parse(bg); if (!bp) return NaN;
  const b = bp.a < 1 ? over(bp.rgb, bp.a, pg) : bp.rgb;
  const fp = parse(fg); if (!fp) return NaN;
  const f = fp.a < 1 ? over(fp.rgb, fp.a, b) : fp.rgb;
  const L1 = lum(f), L2 = lum(b);
  const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (hi + 0.05) / (lo + 0.05);
}

// ─────────────────────────── 读取编译产物 ───────────────────────────
let cssFile;
try {
  cssFile = readdirSync(distAssets).find((f) => f.endsWith(".css"));
} catch {
  console.error(`✗ 找不到 ${distAssets}\n  请先执行 npm run build（在 frontend/ 下）`);
  process.exit(2);
}
if (!cssFile) {
  console.error("✗ dist/assets 下没有 CSS 文件，请先构建");
  process.exit(2);
}
const css = readFileSync(join(distAssets, cssFile), "utf8");

// 抽出所有声明了 CSS 变量的规则块
const blocks = [];
const blockRe = /([^{}]+)\{([^{}]*)\}/g;
let m;
while ((m = blockRe.exec(css)) !== null) {
  const body = m[2];
  if (!body.includes("--")) continue;
  const vars = {};
  const varRe = /(--[\w-]+)\s*:\s*([^;}]+)/g;
  let v;
  while ((v = varRe.exec(body)) !== null) vars[v[1]] = v[2].trim();
  if (Object.keys(vars).length) blocks.push({ at: m.index, sel: m[1].trim(), vars });
}
if (!blocks.length) {
  console.error("✗ 未能从产物中解析出任何令牌块 —— CSS 结构可能已变，请检查本脚本的解析逻辑");
  process.exit(2);
}

/** 选择器特异性 [id, class+attr+pseudo, element]（:not 参数权重并入） */
function specificity(sel) {
  const s = sel.replace(/:not\(([^)]*)\)/g, (_, i) => i);
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const cls = (s.match(/\.[\w-]+/g) || []).length;
  const attr = (s.match(/\[[^\]]+\]/g) || []).length;
  const pse = (s.match(/:(?!not\()[\w-]+/g) || []).length;
  const el = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) || []).length;
  return [ids, cls + attr + pse, el];
}
const cmpSpec = (x, y) => (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2]);

/** 模拟浏览器层叠，返回该组合下的生效令牌 */
function resolve(themeId, isDark) {
  const hits = [];
  for (const b of blocks) {
    for (const raw of b.sel.split(",")) {
      const s = raw.trim();
      if (!s) continue;
      const norm = s.replace(/["']/g, "");
      const nots = [];
      const base = norm.replace(/:not\(([^)]*)\)/g, (_, inner) => { nots.push(inner.trim()); return ""; });

      let blocked = false;
      for (const n of nots) {
        if (n === ".dark" && isDark) blocked = true;
        if (n === `[data-theme=${themeId}]`) blocked = true;
      }
      if (blocked) continue;

      let ok = false;
      if (base === ":root") ok = true;
      else if (base === ".dark") ok = isDark;
      else if (base === `[data-theme=${themeId}]`) ok = true;
      else if (base === `[data-theme=${themeId}].dark`) ok = isDark;
      if (!ok) continue;

      // 只保留真正声明了该变量的块；同名变量按规则后者覆盖
      hits.push({ at: b.at, sel: s, spec: specificity(norm), vars: b.vars });
    }
  }
  hits.sort((a, b) => { const c = cmpSpec(a.spec, b.spec); return c !== 0 ? c : a.at - b.at; });
  const out = {};
  for (const h of hits) Object.assign(out, h.vars);
  return { out, hits };
}

// ─────────────────────── 预期值（该组合的正确答案）───────────────────────
// NOTE: 这里是「设计意图」的声明。若某令牌在某个组合下没拿到预期值，
// 说明选择器/顺序有问题 —— 这正是本脚本要抓的东西。
const EXPECT = {
  "indigo": {
    light: {
      "--bg-base": "#f1f5f9", "--bg-surface": "#ffffff", "--bg-elevated": "#f8fafc",
      "--text-primary": "#0f172a", "--text-secondary": "#334155", "--text-muted": "#627188",
      "--accent": "#5d60e3", "--accent-contrast": "#ffffff",
    },
    dark: {
      "--bg-base": "#090d14", "--bg-surface": "#0f151f", "--bg-elevated": "#1a2433",
      "--text-primary": "#ffffff", "--text-secondary": "#cbd5e1", "--text-muted": "#94a3b8",
      "--accent": "#7c7ff5", "--accent-contrast": "#0b0a26",
    },
  },
  "inkjade": {
    light: {
      "--bg-base": "#eef1ee", "--bg-surface": "#ffffff", "--bg-elevated": "#f6f8f6",
      "--text-primary": "#14211f", "--text-secondary": "#3c4f4b", "--text-muted": "#5c726d",
      "--accent": "#1f7a68", "--accent-contrast": "#ffffff",
    },
    dark: {
      "--bg-base": "#080f0e", "--bg-surface": "#0d1615", "--bg-elevated": "#172523",
      "--text-primary": "#ffffff", "--text-secondary": "#cbd5e1", "--text-muted": "#94a3b8",
      "--accent": "#4ec9ac", "--accent-contrast": "#05201a",
    },
  },
  "liquidglass": {
    light: {
      "--bg-base": "#ebebeb", "--bg-surface": "#ffffff", "--bg-elevated": "#f4f6f6",
      "--text-primary": "#0d1a18", "--text-secondary": "#3c4949", "--text-muted": "#5c6a6a",
      "--accent": "#1c6e66", "--accent-contrast": "#ffffff",
    },
    dark: {
      "--bg-base": "#09100f", "--bg-surface": "#0f1a19", "--bg-elevated": "#172625",
      "--text-primary": "#ffffff", "--text-secondary": "#cbd5e1", "--text-muted": "#94a3b8",
      "--accent": "#8ee1d9", "--accent-contrast": "#04201c",
    },
  },
};

// 一组「不可能对」的组合，用来验证解析器本身在工作（自检）
const SANITY = { "--bg-base": "#f1f5f9" };

let problems = 0;
const fail = (s) => { problems++; console.log(s); };

console.log(`产物: ${cssFile}   解析出 ${blocks.length} 个令牌块\n`);

// ── 自检：解析器必须能区分亮/暗 ──
{
  const L = resolve("inkjade", false).out["--bg-base"];
  const D = resolve("inkjade", true).out["--bg-base"];
  if (L === D) {
    fail(`✗ 自检失败: 墨玉亮/暗的 --bg-base 都是 ${L} —— 层叠解析没生效，本脚本结果不可信`);
  } else {
    console.log(`✓ 自检通过: 墨玉亮 ${L} ≠ 墨玉暗 ${D}\n`);
  }
}
void SANITY;

// ── 逐组合校验 ──
const LABEL = {
  "indigo": { light: "靛蓝 · 石板 × 亮色", dark: "靛蓝 · 石板 × 暗色" },
  "inkjade": { light: "墨玉 · 深青绿 × 亮色", dark: "墨玉 · 深青绿 × 暗色" },
  "liquidglass": { light: "流玻 · 液态玻璃 × 亮色", dark: "流玻 · 液态玻璃 × 暗色" },
};

for (const themeId of ["indigo", "inkjade", "liquidglass"]) {
  for (const isDark of [false, true]) {
    const mode = isDark ? "dark" : "light";
    const { out: T, hits } = resolve(themeId, isDark);
    console.log("═".repeat(60));
    console.log(`  ${LABEL[themeId][mode]}`);
    console.log("═".repeat(60));
    console.log("  生效的令牌块（低特异性在前，同特异性按源码顺序）:");
    for (const h of hits) console.log(`    · @${h.at} [${h.spec.join(",")}] ${h.sel}`);

    console.log("\n  令牌期望值核对:");
    const exp = EXPECT[themeId][mode];
    for (const [k, want] of Object.entries(exp)) {
      const got = T[k] || "(未声明)";
      const ok = got === want;
      if (!ok) fail(`    ✗ ${k.padEnd(20)} 期望 ${want}  实得 ${got}`);
      else console.log(`    ✓ ${k.padEnd(20)} ${got}`);
    }

    console.log("\n  对比度兜底:");
    const g = (k) => T[k] || "";
    const pairs = [
      ["text-primary / bg-base", g("--text-primary"), g("--bg-base"), null],
      ["text-primary / bg-surface", g("--text-primary"), g("--bg-surface"), null],
      ["text-secondary / bg-surface", g("--text-secondary"), g("--bg-surface"), null],
      ["text-muted / bg-surface", g("--text-muted"), g("--bg-surface"), null],
      ["text-muted / bg-base", g("--text-muted"), g("--bg-base"), null],
      ["accent-contrast / accent", g("--accent-contrast"), g("--accent"), null],
      ["accent / bg-surface", g("--accent"), g("--bg-surface"), null],
      ["accent / bg-base", g("--accent"), g("--bg-base"), null],
      ["accent / bg-elevated", g("--accent"), g("--bg-elevated"), null],
    ];
    for (const [label, fg, bg, page] of pairs) {
      const r = ratio(fg, bg, page);
      const ok = r >= 4.5;
      if (!ok) fail(`    **FAIL** ${r.toFixed(2)}:1  ${label}   [${fg} on ${bg}]`);
      else console.log(`    PASS     ${r.toFixed(2)}:1  ${label}`);
    }
    console.log("");
  }
}

console.log("═".repeat(60));
if (problems === 0) {
  console.log("✓ 全部通过：6 个组合的令牌生效值正确，对比度均 ≥4.5:1");
  process.exit(0);
} else {
  console.log(`✗ 发现 ${problems} 个问题（令牌未按预期生效，或对比度不足）`);
  process.exit(1);
}
