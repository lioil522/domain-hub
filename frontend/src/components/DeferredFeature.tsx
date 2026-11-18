import { useEffect, useState, type ReactNode } from "react";
import { LazyBoundary } from "./LazyBoundary";

/** First-visit mounting; navigation hides UI without destroying background work. */
export function DeferredFeature({ active, label, children }: {
  active: boolean;
  label: string;
  children: ReactNode;
}) {
  const [visited, setVisited] = useState(false);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  if (!active && !visited) return null;
  return (
    <div hidden={!active}>
      <LazyBoundary label={label}>{children}</LazyBoundary>
    </div>
  );
}
