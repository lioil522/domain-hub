import { useAppControllerView } from "./useAppControllerView";

/**
 * Application composition boundary. All controller hooks/state live in the
 * dedicated controller hook so this file remains a thin React entry point.
 */
export default function AppController() {
  return useAppControllerView();
}
