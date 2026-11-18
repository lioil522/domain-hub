import { Component, Suspense, type ReactNode } from "react";
import { ModalOverlay } from "./ModalOverlay";

interface Props {
  children: ReactNode;
  label: string;
  onClose?: () => void;
  resetKey?: string;
  errorShell?: (children: ReactNode) => ReactNode;
}

/** A rejected lazy import needs an error boundary; Suspense only handles waiting. */
class LoadErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const content = (
      <div role="alert" className="space-y-3 p-6 text-content-primary">
        <p>{this.props.label}加载失败，请检查网络后重新加载。</p>
        <p className="text-sm text-content-muted">重新加载会丢失未保存的表单，请先保存其他页面的草稿。</p>
        <button type="button" className="btn-primary px-4 py-2 rounded-lg" onClick={() => window.location.reload()}>
          重新加载
        </button>
        {this.props.onClose && (
          <button type="button" className="ml-3 px-4 py-2 rounded-lg" onClick={this.props.onClose}>关闭</button>
        )}
      </div>
    );
    return this.props.errorShell ? this.props.errorShell(content) : content;
  }
}

function Pending({ label, onClose }: Omit<Props, "children">) {
  return (
    <div className="space-y-3 p-6 text-content-primary">
      <p role="status" aria-live="polite">正在加载{label}…</p>
      {onClose && <button type="button" className="px-4 py-2 rounded-lg" onClick={onClose}>取消</button>}
    </div>
  );
}

export function LazyBoundary({ children, label, onClose, resetKey }: Props) {
  return (
    <LoadErrorBoundary label={label} onClose={onClose} resetKey={resetKey}>
      <Suspense fallback={<Pending label={label} onClose={onClose} />}>{children}</Suspense>
    </LoadErrorBoundary>
  );
}

/** Only the pending/error state uses this shell; the loaded modal owns its focus trap. */
export function LazyModalBoundary(props: Props) {
  const fallbackShell = (children: ReactNode) => (
    <ModalOverlay>
      <div role="dialog" aria-label={props.label} className="bg-surface border border-border-base rounded-2xl max-w-md w-full">
        {children}
      </div>
    </ModalOverlay>
  );
  // Keep the error shell outside the loaded modal, avoiding nested overlays/focus traps.
  return (
    <LoadErrorBoundary {...props} errorShell={fallbackShell}>
      <Suspense fallback={fallbackShell(<Pending label={props.label} onClose={props.onClose} />)}>
        {props.children}
      </Suspense>
    </LoadErrorBoundary>
  );
}
