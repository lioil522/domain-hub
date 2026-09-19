import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Density = "compact" | "comfortable" | "spacious";
export const DENSITY_STORAGE_KEY = "DOMAIN_HUB_DENSITY";

interface DensityContextValue {
  density: Density;
  setDensity: (density: Density) => void;
}

const DensityContext = createContext<DensityContextValue | null>(null);

function readDensity(): Density {
  try {
    const value = localStorage.getItem(DENSITY_STORAGE_KEY);
    return value === "compact" || value === "spacious" ? value : "comfortable";
  } catch {
    return "comfortable";
  }
}

export function DensityProvider({ children }: { children: ReactNode }) {
  const [density, setDensityState] = useState<Density>(readDensity);

  const setDensity = (next: Density) => {
    setDensityState(next);
    try { localStorage.setItem(DENSITY_STORAGE_KEY, next); } catch { /* private mode */ }
  };

  useEffect(() => {
    document.documentElement.dataset.density = density;
  }, [density]);

  return <DensityContext.Provider value={{ density, setDensity }}>{children}</DensityContext.Provider>;
}

export function useDensity(): DensityContextValue {
  const context = useContext(DensityContext);
  if (!context) throw new Error("useDensity 必须在 <DensityProvider> 内使用");
  return context;
}
