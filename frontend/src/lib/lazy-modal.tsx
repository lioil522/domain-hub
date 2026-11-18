import type { ComponentProps, ComponentType } from "react";
import { LazyModalBoundary } from "../components/LazyBoundary";
import { lazyPage } from "./lazy-page";

/** Guard mounting, not just rendering inside the modal: a closed React.lazy still downloads. */
export function lazyModal<
  M extends Record<string, ComponentType<any>>,
  K extends keyof M & string,
>(
  loader: () => Promise<M>,
  name: K,
  label: string,
  isOpen: (props: ComponentProps<M[K]>) => boolean,
  close: (props: ComponentProps<M[K]>) => () => void,
): M[K] {
  const View = lazyPage(loader, name);
  return ((props: ComponentProps<M[K]>) => {
    if (!isOpen(props)) return null;
    return (
      <LazyModalBoundary label={label} onClose={close(props)}>
        <View {...props} />
      </LazyModalBoundary>
    );
  }) as M[K];
}
