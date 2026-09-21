import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "./components";
import { isThemeId, type ThemeId, applyThemeAttribute } from "./theme";
import { DesignSystemTheme } from "./design-system/sections/DesignSystemTheme";
import { DesignSystemControls } from "./design-system/sections/DesignSystemControls";
import { DesignSystemInputs } from "./design-system/sections/DesignSystemInputs";
import { DesignSystemAdvanced } from "./design-system/sections/DesignSystemAdvanced";

/**
 * DesignSystem —— 设计系统展示页。
 *
 * 页面只负责演示状态与 section 编排，具体展示内容按设计域拆分，避免演示页重新成为大文件。
 */
export default function DesignSystem() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const [colorTheme, setColorTheme] = useState<ThemeId>(() => {
    const attr = document.documentElement.getAttribute("data-theme");
    return isThemeId(attr) ? attr : "indigo";
  });
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [formValue, setFormValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [providerDemo, setProviderDemo] = useState("dnshe");

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
  };

  const changeColorTheme = (id: ThemeId) => {
    setColorTheme(id);
    applyThemeAttribute(id);
  };

  const runLoadingDemo = () => {
    setLoadingDemo(true);
    window.setTimeout(() => setLoadingDemo(false), 1800);
  };

  const validateDemo = (v: string) => {
    setFormValue(v);
    setFormError(v.length > 0 && v.length < 3 ? "至少需要 3 个字符" : null);
  };

  return (
    <div className="min-h-screen bg-page p-4 sm:p-8">
      <div className="max-w-5xl mx-auto">
        <header className="mb-8 flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-lg font-bold text-content-primary">设计系统</h1>
            <p className="text-xs text-content-muted mt-1">Domain Hub 组件库 · 令牌 · 交互状态 · 无障碍基线</p>
          </div>
          <Button variant="secondary" size="sm" onClick={toggleTheme} icon={<RefreshCw className="w-3.5 h-3.5" />}>
            切换到{dark ? "亮色" : "暗色"}
          </Button>
        </header>

        <DesignSystemTheme colorTheme={colorTheme} onColorThemeChange={changeColorTheme} />
        <DesignSystemControls loadingDemo={loadingDemo} onRunLoadingDemo={runLoadingDemo} />
        <DesignSystemInputs formValue={formValue} formError={formError} onValidateDemo={validateDemo} providerDemo={providerDemo} setProviderDemo={setProviderDemo} />
        <DesignSystemAdvanced />

        <footer className="pt-6 border-t border-border-base text-[11px] text-content-muted">
          Domain Hub 设计系统 · 组件层建于既有语义变量之上，未改动任何业务逻辑
        </footer>
      </div>
    </div>
  );
}
