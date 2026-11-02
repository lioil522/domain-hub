export interface OperationEvent { id: string; phase: "start" | "end"; session: string | null; actionsChanged: boolean }

/** Local request activity only: no request body, credentials, URL, or extra I/O. */
export function operationNotification(url: string, method: string, session: string | null): ((phase: "start" | "end") => void) | undefined {
  const path = url.split("?")[0];
  if (typeof window === "undefined" || !session || !["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase()) || path === "/api/sync/plan") return;
  const id = crypto.randomUUID();
  const actionsChanged = path !== "/api/logs/clear" && !path.endsWith("/sync-step") && !path.startsWith("/api/auth/");
  return phase => window.dispatchEvent(new CustomEvent<OperationEvent>("domain-hub:operation", { detail: { id, phase, session, actionsChanged } }));
}
