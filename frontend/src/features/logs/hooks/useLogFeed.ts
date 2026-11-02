import { useEffect, useMemo, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ApiFetch } from "../../../api/client";
import type { AppLog } from "../../../types/log";
import { createLogFeed, mergeLogFeed } from "../../../lib/log-feed";

export function useLogFeed(apiFetch: ApiFetch, session: string | null, setLogs: Dispatch<SetStateAction<AppLog[]>>, setLoading: (value: boolean) => void) {
  const feed = useMemo(() => createLogFeed(apiFetch, session, { full: setLogs, delta: incoming => setLogs(current => mergeLogFeed(current, incoming)), loading: setLoading }), [apiFetch, session, setLogs, setLoading]);
  const current = useRef(feed); current.current = feed;
  useEffect(() => { feed.start(); setLogs([]); setLoading(false); return () => feed.stop(); }, [feed, setLogs, setLoading]);
  return current;
}
