import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { startLogPolling, shouldStreamLogs, type createLogFeed } from "../../../lib/log-feed";

export function useLiveLogs(feed: MutableRefObject<ReturnType<typeof createLogFeed>>, session: string | null, onLogPage: boolean, activity: boolean, completedOperations = 0) {
  const [visible, setVisible] = useState(() => typeof document !== "undefined" && document.visibilityState === "visible");
  const previouslyActive = useRef(false);
  const previousSession = useRef(session);
  const previousCompletions = useRef(completedOperations);
  const idleCompletion = activity ? 0 : completedOperations;
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    const active = shouldStreamLogs(session, onLogPage, visible, activity);
    // Completion edges also cover requests that start/end within one React batch.
    const ended = previousSession.current === session && !activity && (previouslyActive.current || completedOperations > previousCompletions.current);
    previousSession.current = session;
    previousCompletions.current = completedOperations;
    previouslyActive.current = active;
    if (active) return startLogPolling(signal => feed.current.tail(signal));
    if (ended && session && onLogPage && visible) {
      const controller = new AbortController();
      void feed.current.settle(controller.signal).catch(() => {});
      return () => controller.abort();
    }
  }, [feed, session, onLogPage, visible, activity, idleCompletion]);
  return shouldStreamLogs(session, onLogPage, visible, activity);
}
