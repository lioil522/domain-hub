import { Card, ThemePicker } from "../../components";
import { THEMES, type ThemeId } from "../../theme";
import { Section, Swatch } from "../primitives";

export interface DesignSystemThemeProps {
  colorTheme: ThemeId;
  onColorThemeChange: (id: ThemeId) => void;
}

export function DesignSystemTheme({ colorTheme, onColorThemeChange }: DesignSystemThemeProps) {
  return (
    <>
        {/* ── 主题 ── */}
        <Section
          title="主题 · 配色身份 × 明暗"
          desc="两个正交维度：配色身份（data-theme）管色相，明暗（.dark 类）管明度。3 套主题 × 明暗共 6 个组合各自独立配平，切换任一维度都不影响另一个。"
        >
          <Card padding="lg">
            <div className="mb-4">
              <ThemePicker value={colorTheme} onChange={onColorThemeChange} />
            </div>

            {/* 四个组合的真实渲染 —— 不是示意图，是当前令牌下的实际效果。
                每个小卡强制带上对应组合的作用域，所以要在这里临时写死属性，
                不能靠祖先继承（页面本身只有一个组合生效）。 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {THEMES.map((t) =>
                ([false, true] as const).map((isDark) => (
                  <div
                    key={`${t.id}-${isDark}`}
                    data-theme={t.id}
                    className={isDark ? "dark" : undefined}
                  >
                    <div className="rounded-lg border border-border-base bg-page p-3">
                      <div className="text-[10px] font-mono text-content-muted mb-2">
                        {t.label} × {isDark ? "暗色" : "亮色"}
                      </div>
                      <div className="rounded-md border border-border-base bg-surface p-2.5 space-y-2">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-6 h-6 rounded-md flex items-center justify-center text-[11px] font-bold bg-accent-gradient"
                            aria-hidden="true"
                          >
                            A
                          </span>
                          <span className="text-xs font-semibold text-content-primary">
                            正文 Primary
                          </span>
                          <span className="text-[11px] text-accent font-semibold">accent</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-state-ok-bg text-state-ok-fg border-state-ok-border">
                            正常
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-state-warn-bg text-state-warn-fg border-state-warn-border">
                            将到期
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-state-danger-bg text-state-danger-fg border-state-danger-border">
                            已过期
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-source-dnshe-bg text-source-dnshe-fg">
                            DNSHE
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-source-cf-bg text-source-cf-fg">
                            Cloudflare
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-source-dp-bg text-source-dp-fg">
                            DigitalPlat
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <p className="text-[11px] text-content-muted mt-4 leading-relaxed">
              对比度由项目根的 <span className="font-mono">contrast-check.mjs</span> 脚本机械校验
              （WCAG 2.1 相对亮度公式，含半透明底色的合成），108 项配对全量跑一遍。
              三套主题 × 明暗共 6 个组合现已<b className="text-content-secondary">全部 ≥ 4.5:1</b>。
              靛蓝主题的 accent 系列原先不达标（于 bg-base 4.08:1、暗色 bg-elevated 上仅 3.50:1），
              修复时保持色相不变、只调明度与饱和度 —— 你看到的仍是同一个靛蓝。
            </p>
          </Card>
        </Section>

        {/* ── 令牌 ── */}
        <Section
          title="色彩令牌 · 状态语义"
          desc="组件不直接使用具体色阶，一律引用语义名。改品牌色只需动 index.css 一处。每对 bg/fg 组合的对比度均 ≥ 4.5:1。"
        >
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Swatch name="ok 正常" varName="--state-ok-*" className="bg-state-ok-bg border-state-ok-border" />
            <Swatch name="warn 警告" varName="--state-warn-*" className="bg-state-warn-bg border-state-warn-border" />
            <Swatch name="danger 危险" varName="--state-danger-*" className="bg-state-danger-bg border-state-danger-border" />
            <Swatch name="info 提示" varName="--state-info-*" className="bg-state-info-bg border-state-info-border" />
            <Swatch name="idle 中性" varName="--state-idle-*" className="bg-state-idle-bg border-state-idle-border" />
          </div>
        </Section>

        <Section
          title="色彩令牌 · 服务商来源"
          desc="跨源搜索、侧栏 badge、域名卡片共用同一套来源色，让「这条数据来自哪」成为可扫读的视觉锚点。"
        >
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Swatch name="DNSHE" varName="--source-dnshe-*" className="bg-source-dnshe-bg" />
            <Swatch name="Cloudflare" varName="--source-cf-*" className="bg-source-cf-bg" />
            <Swatch name="DigitalPlat" varName="--source-dp-*" className="bg-source-dp-bg" />
            <Swatch name="自定义" varName="--source-custom-*" className="bg-source-custom-bg" />
          </div>
        </Section>
    </>
  );
}
