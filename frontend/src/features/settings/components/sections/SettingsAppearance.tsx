import { Palette } from "lucide-react";
import { ThemePicker } from "../../../../components/ThemePicker";
import { THEME_LABELS, type ThemeId } from "../../../../theme";

export interface SettingsAppearanceProps {
  theme: "light" | "dark";
  setTheme: (updater: (t: "light" | "dark") => "light" | "dark") => void;
  colorTheme: ThemeId;
  setColorTheme: (id: ThemeId) => void;
}

export function SettingsAppearance({ theme, setTheme, colorTheme, setColorTheme }: SettingsAppearanceProps) {
  return (
    <>
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <Palette className="w-4 h-4 text-accent" /> 外观
            </h3>

            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-3">
                <span className="text-sm font-semibold text-content-primary">配色主题</span>
                <span className="text-[11px] text-content-muted">与明暗模式独立，可自由组合</span>
              </div>

              <ThemePicker value={colorTheme} onChange={setColorTheme} />

              <p className="text-[11px] text-content-muted mt-3 leading-relaxed">
                当前为
                <b className="text-content-secondary">
                  {" "}{THEME_LABELS[colorTheme]}{" "}
                </b>
                ×
                <b className="text-content-secondary">
                  {" "}{theme === "dark" ? "暗色" : "亮色"}{" "}
                </b>
                组合。选择会保存在本机浏览器，下次打开直接生效。
              </p>
            </div>

            <div className="pt-3 border-t border-border-soft flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-content-primary">暗色模式</div>
                <div className="text-xs text-content-muted mt-0.5">
                  深色界面适合夜间与弱光环境；顶栏右上角也有快捷开关
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={theme === "dark"}
                aria-label="暗色模式"
                onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
                className={`w-12 h-6 rounded-full transition-all relative flex-shrink-0 ${
                  theme === "dark" ? "bg-accent" : "bg-elevated border border-border-base"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                    theme === "dark" ? "left-6" : "left-0.5"
                  }`}
                />
              </button>
            </div>
          </div>
          {/* NOTE: 这里原有一个「外观 / 主题模式」卡片，与顶栏的太阳/月亮切换按钮
              完全同源（都改 theme 这一个 state），属重复入口，已移除。
              主题切换保留在顶栏，任何页面都能直接点到，不必先进设置页。 */}
    </>
  );
}
