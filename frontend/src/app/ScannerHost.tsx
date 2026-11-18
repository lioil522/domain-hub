import { lazyPage } from "../lib/lazy-page";
import { DeferredFeature } from "../components/DeferredFeature";
import type { ScannerFeatureProps } from "../features/scanner/ScannerFeature";

const ScannerFeature = lazyPage(() => import("../features/scanner/ScannerFeature"), "ScannerFeature");

/** Mount on demand, retain for navigation, reset with the session/backend key supplied by App. */
export function ScannerHost(props: ScannerFeatureProps) {
  return (
    <DeferredFeature active={props.active} label="域名注册与查重">
      <ScannerFeature {...props} />
    </DeferredFeature>
  );
}
