import { RefreshCw, Settings } from "lucide-react";
import type { ThemeId } from "../../../theme";
import type { UseSettingsReturn } from "../hooks/useSettings";
import { SettingsAppearance } from "./sections/SettingsAppearance";
import { SettingsBackend } from "./sections/SettingsBackend";
import { SettingsSecurity } from "./sections/SettingsSecurity";
import { SettingsRenewal } from "./sections/SettingsRenewal";
import { SettingsNotifications } from "./sections/SettingsNotifications";
import { SettingsDataBackup } from "./sections/SettingsDataBackup";

/**
 * SettingsPage —— 设置标签页（外观 / 后端地址 / 账户安全 / 自动续期 / 通知 / 数据备份）
 *
 * 页面只负责区域编排；每个设置域的表单与交互位于 sections/ 下。
 */
export interface SettingsPageProps {
  s: UseSettingsReturn;
  theme: "light" | "dark";
  setTheme: (updater: (t: "light" | "dark") => "light" | "dark") => void;
  colorTheme: ThemeId;
  setColorTheme: (id: ThemeId) => void;
  backendUrl: string;
  onOpenDataOp: (mode: "export" | "import") => void;
}

export function SettingsPage(props: SettingsPageProps) {
  const { s, theme, setTheme, colorTheme, setColorTheme, backendUrl, onOpenDataOp } = props;
  const {
    settings, setSettings, settingsConfigured, loadingSettings,
    backendUrlInput, setBackendUrlInput, backendUrlEditing, setBackendUrlEditing,
    pwOld, setPwOld, pwNew, setPwNew, pwNew2, setPwNew2, pwNewUsername, setPwNewUsername,
    twoFaSetup, setTwoFaSetup, twoFaEnableToken, setTwoFaEnableToken, twoFaDisableToken, setTwoFaDisableToken,
    handleSaveSettings, handleTestTelegram, handleTestWebhook, handleSaveBackendUrl, handleCancelBackendUrl,
    handleChangePassword, handleStart2faSetup, handleEnable2fa, handleDisable2fa, accountInfo, actionLoading,
  } = s;

  return (
    <div className="space-y-6 max-w-3xl pt-5 md:pt-6">
      <div>
        <h2 className="text-2xl font-black text-content-primary flex items-center gap-2">
          <Settings className="w-6 h-6 text-accent" /> 设置
        </h2>
        <p className="text-content-muted mt-1 text-sm">外观、系统配置、通知渠道与自动续期策略</p>
      </div>

      {loadingSettings ? (
        <div className="flex justify-center py-20"><RefreshCw className="w-6 h-6 animate-spin text-accent" /></div>
      ) : (
        <>
          <SettingsAppearance theme={theme} setTheme={setTheme} colorTheme={colorTheme} setColorTheme={setColorTheme} />
          <SettingsBackend
            backendUrl={backendUrl} backendUrlInput={backendUrlInput} setBackendUrlInput={setBackendUrlInput}
            backendUrlEditing={backendUrlEditing} setBackendUrlEditing={setBackendUrlEditing}
            handleSaveBackendUrl={handleSaveBackendUrl} handleCancelBackendUrl={handleCancelBackendUrl}
          />
          <SettingsSecurity
            accountInfo={accountInfo} pwOld={pwOld} setPwOld={setPwOld} pwNew={pwNew} setPwNew={setPwNew}
            pwNew2={pwNew2} setPwNew2={setPwNew2} pwNewUsername={pwNewUsername} setPwNewUsername={setPwNewUsername}
            twoFaSetup={twoFaSetup} setTwoFaSetup={setTwoFaSetup} twoFaEnableToken={twoFaEnableToken}
            setTwoFaEnableToken={setTwoFaEnableToken} twoFaDisableToken={twoFaDisableToken} setTwoFaDisableToken={setTwoFaDisableToken}
            handleChangePassword={handleChangePassword} handleStart2faSetup={handleStart2faSetup}
            handleEnable2fa={handleEnable2fa} handleDisable2fa={handleDisable2fa} actionLoading={actionLoading}
          />
          <SettingsRenewal settings={settings} setSettings={setSettings} />
          <SettingsNotifications settings={settings} setSettings={setSettings} settingsConfigured={settingsConfigured}
            handleTestTelegram={handleTestTelegram} handleTestWebhook={handleTestWebhook} actionLoading={actionLoading} />
          <SettingsDataBackup accountInfo={accountInfo} actionLoading={actionLoading} handleSaveSettings={handleSaveSettings} onOpenDataOp={onOpenDataOp} />
        </>
      )}
    </div>
  );
}
