// 在 React 挂载前根据 localStorage 提前写入主题属性与明暗类，避免刷新时闪白/闪色。
// 刻意做成外部脚本而非内联 <script>：CSP 的 script-src 已收紧为 'self'，
// 内联脚本会被浏览器拦截导致主题初始化失效。
//
// 两个正交维度：
//   明暗   → localStorage["DNSHE_THEME"]        → <html class="dark">
//   配色   → localStorage["DNSHE_COLOR_THEME"]  → <html data-theme="...">
//
// NOTE: 合法主题清单与前端 src/theme.ts 的 THEMES 必须保持一致。
// 这里不能 import —— 本文件在 React 打包链路之外，是原生脚本。
// 新增主题时两处都要改（theme.ts 里也有对应提示）。
(function () {
  var VALID_THEMES = ["indigo", "inkjade"];
  var DEFAULT_THEME = "indigo";

  try {
    var mode = localStorage.getItem("DNSHE_THEME") || "dark";
    if (mode === "dark") document.documentElement.classList.add("dark");

    var color = localStorage.getItem("DNSHE_COLOR_THEME");
    document.documentElement.setAttribute(
      "data-theme",
      VALID_THEMES.indexOf(color) !== -1 ? color : DEFAULT_THEME
    );
  } catch (e) {
    // localStorage 在隐私模式 / 禁用存储时会抛异常。
    // 此时仍按默认值渲染，不能让主题初始化把整个应用拦在门外。
    document.documentElement.classList.add("dark");
    document.documentElement.setAttribute("data-theme", DEFAULT_THEME);
  }
})();
