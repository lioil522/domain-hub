import { useEffect, useRef, useState } from "react";
import {
  applyThemeAttribute,
  readStoredTheme,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  type ThemeId,
} from "../../theme";

/** Global UI-only state for the application shell/controller.
 *
 * Keeping transient presentation state here prevents the application controller
 * from becoming the owner of unrelated interaction details.
 */
export function useAppUiState() {
  const [theme, setTheme] = useState<"light" | "dark">(
    () => (localStorage.getItem("DNSHE_THEME") as "light" | "dark") || "dark",
  );
  const [colorTheme, setColorTheme] = useState<ThemeId>(() =>
    typeof window === "undefined" ? DEFAULT_THEME : readStoredTheme(),
  );
  const [globalSearch, setGlobalSearch] = useState("");
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [dnsheMenuOpen, setDnsheMenuOpen] = useState(false);
  const [logCategory, setLogCategory] = useState<"all" | "auth" | "api" | "operation">("all");

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("DNSHE_THEME", theme);
  }, [theme]);

  useEffect(() => {
    applyThemeAttribute(colorTheme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, colorTheme);
    } catch {
      // Private browsing/storage-disabled environments are still usable.
    }
  }, [colorTheme]);

  useEffect(() => {
    if (!notifOpen) return;
    const onPointerDown = (event: Event) => {
      if (!notifRef.current?.contains(event.target as Node)) setNotifOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNotifOpen(false);
    };
    const onScroll = (event: Event) => {
      if (!notifRef.current?.contains(event.target as Node)) setNotifOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [notifOpen]);

  return {
    theme,
    setTheme,
    colorTheme,
    setColorTheme,
    globalSearch,
    setGlobalSearch,
    notifOpen,
    setNotifOpen,
    notifRef,
    searchFocused,
    setSearchFocused,
    dnsheMenuOpen,
    setDnsheMenuOpen,
    logCategory,
    setLogCategory,
  };
}
