import { useEffect, useState } from "react";
import type { OperationEvent } from "../../../lib/operation-activity";

export function useOperationActivity(session: string | null) {
  const [activity, setActivity] = useState({ active: false, completed: 0 });
  useEffect(() => {
    setActivity({ active: false, completed: 0 });
    if (!session) return;
    const pending = new Set<string>();
    const operation = (event: Event) => {
      const detail = (event as CustomEvent<OperationEvent>).detail;
      if (detail.session !== session) return;
      if (detail.phase === "start") {
        pending.add(detail.id);
        setActivity(current => ({ ...current, active: true }));
      } else if (pending.delete(detail.id)) {
        const active = pending.size > 0;
        setActivity(current => ({ active, completed: current.completed + 1 }));
      }
    };
    window.addEventListener("domain-hub:operation", operation);
    return () => window.removeEventListener("domain-hub:operation", operation);
  }, [session]);
  return activity;
}
