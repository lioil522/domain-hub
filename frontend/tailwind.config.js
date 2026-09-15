/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        /*
         * 显式指定等宽字栈，不用 Tailwind 默认的那一套。
         *
         * NOTE: 默认栈是 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
         * "Liberation Mono", "Courier New", monospace —— 前四个在 Windows 上都不存在
         * （Chrome 也没实现 ui-monospace），所以命中 Consolas 才勉强正常；一旦机器缺
         * Consolas 就会掉到 Courier New，笔画又细又散，1x 屏上看着像被调淡了。这里把
         * Windows 自带的两款排在最前、并彻底移掉 Courier New，苹果 / 安卓端仍会按各自
         * 的名字命中系统等宽字（SF Mono / Roboto Mono），观感不变。
         * Cascadia Mono 而不是 Cascadia Code：后者带连字，不适合展示域名与解析记录。
         */
        mono: [
          "Consolas",
          '"Cascadia Mono"',
          "ui-monospace",
          "SFMono-Regular",
          '"SF Mono"',
          "Menlo",
          "Monaco",
          '"Roboto Mono"',
          '"Noto Sans Mono"',
          '"DejaVu Sans Mono"',
          '"Liberation Mono"',
          "monospace",
        ],
      },
      colors: {
        /*
         * 语义化配色 —— 映射到 index.css 中的 CSS 变量，随明暗主题自动切换。
         *
         * NOTE: 键名绝对不能和 Tailwind 内置 fontSize 的档位重名（xs / sm / base /
         * lg / xl / 2xl …）。调色板键 `k` 会生成 .text-k{color}，而字号档位 `k` 会
         * 生成 .text-k{font-size}，两条同名规则都会输出、各自生效，互不覆盖。
         *
         * 这个键原本叫 `base`，于是 .text-base 同时意味着「16px」和「color:
         * var(--bg-base)」—— 页面底色。凡是写了 text-base 的元素字色都会被刷成背景色，
         * 而响应式变体（sm:text-base）排在样式表末尾，能稳定压过 .text-content-primary，
         * 域名卡片标题因此在桌面端整行看不见；<640px 媒体查询不生效所以手机端正常；
         * hover 变体多一个伪类、特异性 (0,2,0) 更高没被波及，表现出来就是
         * 「只有鼠标放上去才能看见」。改名为 page，页面底色统一用 bg-page。
         */
        page: "var(--bg-base)",
        surface: "var(--bg-surface)",
        elevated: "var(--bg-elevated)",
        hovered: "var(--bg-hover)",
        "border-base": "var(--border-base)",
        "border-soft": "var(--border-soft)",
        "content-primary": "var(--text-primary)",
        "content-secondary": "var(--text-secondary)",
        "content-muted": "var(--text-muted)",
        accent: "var(--accent)",

        /*
         * 状态语义色 —— 组件层唯一入口，替代直接写 emerald/amber/red/slate/sky。
         *
         * NOTE: 键名统一为 ok / warn / danger / info / idle，每个带 bg / fg / border
         * 三个子键，所以用法是 `bg-state-ok-bg text-state-ok-fg border-state-ok-border`。
         * 这套值在 index.css 的 :root 与 .dark 各有一份，明暗自动切换。
         *
         * 为什么不沿用 Tailwind 内置色阶（如 bg-emerald-50 dark:bg-emerald-950/80）：
         * 1) 每处要写两遍、且暗色档位靠人工配，App.tsx 里已散落大量这种双写；
         * 2) 暗色档位写错时（如日志区写死 bg-red-950 却用在亮色主题）不会报错，
         *    只会静默显示成错误配色 —— 收敛到语义名后不可能写错主题。
         */
        state: {
          "ok-bg": "var(--state-ok-bg)",
          "ok-fg": "var(--state-ok-fg)",
          "ok-border": "var(--state-ok-border)",
          "warn-bg": "var(--state-warn-bg)",
          "warn-fg": "var(--state-warn-fg)",
          "warn-border": "var(--state-warn-border)",
          "danger-bg": "var(--state-danger-bg)",
          "danger-fg": "var(--state-danger-fg)",
          "danger-border": "var(--state-danger-border)",
          "info-bg": "var(--state-info-bg)",
          "info-fg": "var(--state-info-fg)",
          "info-border": "var(--state-info-border)",
          "idle-bg": "var(--state-idle-bg)",
          "idle-fg": "var(--state-idle-fg)",
          "idle-border": "var(--state-idle-border)"
        },

        /*
         * 服务商来源色 —— 跨源搜索分组、侧栏 badge、域名卡片来源带共用。
         * 让「这条数据来自哪个服务商」成为可扫读的视觉锚点。
         */
        source: {
          "dnshe-bg": "var(--source-dnshe-bg)",
          "dnshe-fg": "var(--source-dnshe-fg)",
          "cf-bg": "var(--source-cf-bg)",
          "cf-fg": "var(--source-cf-fg)",
          "dp-bg": "var(--source-dp-bg)",
          "dp-fg": "var(--source-dp-fg)",
          "custom-bg": "var(--source-custom-bg)",
          "custom-fg": "var(--source-custom-fg)"
        },

        // 自定义一些高端、质感更好的暗色系调色板（保留兼容）
        dark: {
          50: "#f6f6f9",
          100: "#eef1f6",
          200: "#dbe3ef",
          300: "#bdcbe0",
          400: "#96afce",
          500: "#698eb8",
          600: "#53749e",
          700: "#435d81",
          800: "#1a2433",
          850: "#131b28",
          900: "#0f151f",
          950: "#090d14",
        }
      },
      /*
       * 圆角令牌 —— 覆盖 Tailwind 默认档位，让 rounded-md / rounded-lg / rounded-xl
       * 全部指向 index.css 的 --radius-*，全站换圆角风格只改一处。
       *
       * NOTE: 这里只覆盖不新增，因为 App.tsx 里已有大量 rounded-lg / rounded-xl 调用，
       * 保持同名才能让存量代码自动吃到新令牌，而无需批量改写。
       */
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-lg)", // 收敛：2xl 归入 lg，避免弹窗圆角过大
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        accent: "var(--shadow-accent)",
      },
      transitionTimingFunction: {
        out: "var(--ease-out)",
        spring: "var(--ease-spring)",
      },
      transitionDuration: {
        fast: "var(--dur-fast)",
        base: "var(--dur-base)",
        slow: "var(--dur-slow)",
      }
    },
  },
  plugins: [],
}
