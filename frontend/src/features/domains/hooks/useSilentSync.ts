import { useEffect, useRef, useState } from "react";
import type { ApiFetch } from "../../../api/client";
import { advancePlan, type SliceState } from "../../../lib/sliced-sync";

/** Browser lifecycle only schedules new slices; D1 is the cross-tab authority. */
export function useSilentSync(apiFetch: ApiFetch, session: string | null, enabled: boolean, onCompleted: (provider?: string) => void | Promise<unknown>) {
  const callback = useRef(onCompleted); callback.current = onCompleted;
  const [states, setStates] = useState<Record<number, SliceState>>({});
  useEffect(() => {
    setStates({});
    if (!session) return;
    let stopped = false, running = false;
    const controller = new AbortController();
    const run = async () => {
      if (stopped || running || document.visibilityState !== "visible") return;
      running = true;
      try {
        await advancePlan(apiFetch, { session, manual: false, localOnly: !enabled, stopped: () => stopped, signal: controller.signal,
          onState: state => { if (!stopped) setStates(prev => ({ ...prev, [state.accountId]: { ...state, advancing: Boolean(state.advancing) } })); },
          onError: () => {}, // Per-account errors are exposed by onState, not Toasts.
          onCompleted: async state => { if (!stopped) await callback.current(state.provider); },
        });
        if (!stopped) setStates(prev => { const next = { ...prev }; delete next[0]; return next; });
      } catch (error) {
        if (!stopped) setStates(prev => ({ ...prev, 0: { accountId: 0, status: "paused", client_error: error instanceof Error ? error.message : "读取同步状态失败，未确认完成" } }));
      }
      finally { running = false; }
    };
    const timer = setInterval(() => void run(), enabled ? 30000 : 60000);
    const visibility = () => { if (document.visibilityState === "visible") void run(); };
    const manualState = (event: Event) => {
      const { state, session: owner } = (event as CustomEvent<{ state: SliceState; session: string }>).detail;
      if (!stopped && owner === session) setStates(prev => ({ ...prev, [state.accountId]: state }));
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("domain-hub:sync-state", manualState);
    void run();
    return () => { stopped = true; controller.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", visibility); window.removeEventListener("domain-hub:sync-state", manualState); };
  }, [apiFetch, session, enabled]);
  return states;
}
