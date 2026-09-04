import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * Light/dark, remembered per browser and otherwise following the OS.
 *
 * shadcn keys its dark tokens off a `.dark` class on <html>, so "system" is not
 * a third set of variables — it is a resolved choice we re-resolve whenever the
 * OS flips, for as long as nothing has been picked explicitly.
 */

export type Theme = "light" | "dark" | "system";

const KEY = "opc-theme";

const ThemeContext = createContext<{
  theme: Theme;
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
  toggle: () => void;
}>({
  theme: "system",
  resolved: "light",
  setTheme: () => {},
  toggle: () => {},
});

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* private window or blocked storage — fall through to system */
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(read);
  const [systemDark, setSystemDark] = useState(prefersDark);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const resolved: "light" | "dark" =
    theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  function setTheme(t: Theme) {
    setThemeState(t);
    try {
      if (t === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, t);
    } catch {
      /* nothing to remember it with; the choice still holds for this session */
    }
  }

  return (
    <ThemeContext.Provider
      value={{
        theme,
        resolved,
        setTheme,
        toggle: () => setTheme(resolved === "dark" ? "light" : "dark"),
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export const useTheme = () => useContext(ThemeContext);
