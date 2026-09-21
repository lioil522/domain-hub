import { CheckCircle2, Info, Pencil, Save, Server } from "lucide-react";
import { Input } from "../../../../components/form/Input";

export interface SettingsBackendProps {
  backendUrl: string;
  backendUrlInput: string;
  setBackendUrlInput: (value: string) => void;
  backendUrlEditing: boolean;
  setBackendUrlEditing: (value: boolean) => void;
  handleSaveBackendUrl: () => void;
  handleCancelBackendUrl: () => void;
}

export function SettingsBackend(props: SettingsBackendProps) {
  const { backendUrl, backendUrlInput, setBackendUrlInput, backendUrlEditing, setBackendUrlEditing, handleSaveBackendUrl, handleCancelBackendUrl } = props;
  return (
          <div className="bg-surface border border-border-base rounded-2xl p-4 sm:p-5 space-y-4">
            <h3 className="font-bold text-content-primary flex items-center gap-2">
              <Server className="w-4 h-4 text-accent" /> 后端地址
            </h3>

            {backendUrlEditing ? (
              <div>
                <label htmlFor="settingspage-fld1" className="text-sm font-semibold text-content-primary">后端 Worker 地址</label>
                <div className="flex gap-2 mt-2">
                  <Input id="settingspage-fld1" size="sm"
                    value={backendUrlInput}
                    onChange={(e) => setBackendUrlInput(e.target.value)}
                    placeholder="https://domain-hub.<子域>.workers.dev"
                    className="flex-1 text-content-primary placeholder:text-content-muted"
                  />
                  <button onClick={handleSaveBackendUrl} className="btn-primary px-4 py-2 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5">
                    <Save className="w-4 h-4" /> 保存
                  </button>
                  <button onClick={handleCancelBackendUrl} className="bg-elevated hover:bg-hovered text-content-muted border border-border-base px-4 py-2 rounded-lg text-sm">
                    取消
                  </button>
                </div>
                <p className="text-xs text-content-muted mt-2">保存后刷新页面生效；清空保存可恢复自动推演。</p>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm min-w-0">
                  {backendUrl ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      <span className="text-content-primary">已配置自定义后端地址</span>
                    </>
                  ) : (
                    <>
                      <Info className="w-4 h-4 text-content-muted flex-shrink-0" />
                      <span className="text-content-muted">未配置，使用自动推演</span>
                    </>
                  )}
                </div>
                <button
                  onClick={() => { setBackendUrlInput(localStorage.getItem("DOMAIN_HUB_BACKEND_URL") || ""); setBackendUrlEditing(true); }}
                  className="bg-elevated hover:bg-hovered text-content-secondary border border-border-base px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 flex-shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" /> {backendUrl ? "修改" : "配置"}
                </button>
              </div>
            )}
          </div>
  );
}
