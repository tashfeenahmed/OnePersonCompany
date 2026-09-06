import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_PALETTE, PALETTES, palette } from "./palettes";
import { useStore } from "./store";

/**
 * Light/dark, remembered per browser and otherwise following the OS.
 *
 * shadcn keys its dark tokens off a `.dark` class on <html>, so "system" is not
 * a third set of variables — it is a resolved choice we re-resolve whenever the
 * OS flips, for as long as nothing has been picked explicitly.
 *
 * THE PALETTE IS A SECOND AXIS AND IT NEVER MERGES WITH THIS ONE. `.dark` keeps
 * choosing between two blocks; a palette replaces the values INSIDE whichever
 * block won, by writing custom properties onto <html> where they beat both
 * `:root` and `.dark`. So mode × palette stay two independent choices: somebody
 * on Moss who moves into a dark room at six gets dark Moss, and the default
 * palette writes nothing at all, which is what makes it byte-for-byte the
 * stylesheet.
 *
 * THE TWO ARE STORED IN DIFFERENT PLACES, deliberately. The mode is in this
 * browser's localStorage, because it is a fact about the room — a phone in the
 * sun and a desktop at night want different answers, and syncing it would
 * fight the OS. The palette rides the workspace preferences (see StoreState),
 * because it is a fact about the product, and somebody who chose it chose it
 * for their dashboard rather than for one browser.
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

/* ------------------------------------------------------------- the palette */

/** Collected once from the palettes themselves, so a token added there is
 *  cleared here without a second list to remember. */
const ALL_TOKENS: string[] = [
  ...new Set(PALETTES.flatMap((p) => Object.keys(p.light ?? p.dark ?? {}))),
];

/**
 * WRITE ONE PALETTE'S TOKENS ONTO <html>, OR TAKE THEM ALL OFF AGAIN.
 *
 * An inline custom property on the root element beats every rule in the
 * stylesheet that could set the same one, which is exactly what is wanted: a
 * palette is a layer OVER the mode, not a competitor to it. The removal path
 * matters as much as the write — switching from Moss back to Paper has to
 * leave the element with no properties of ours at all, or the default would be
 * whatever the last palette happened not to define.
 *
 * `data-palette` is set alongside for anything that needs to key off the
 * choice in CSS (and for a screenshot to be able to say which one it is). The
 * default removes it rather than spelling its own name, so "no attribute" and
 * "the stylesheet" are the same state.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function applyPalette(id: string | null | undefined, mode: "light" | "dark") {
  const p = palette(id);
  const root = document.documentElement;
  const tokens = mode === "light" ? p.light : p.dark;

  /* Every token any palette can own, cleared first. Clearing only the ones the
     INCOMING palette defines would leave a token behind whenever two palettes
     covered different sets — they do not today, and a rule that depends on
     that staying true is a rule that breaks in six months. */
  for (const name of ALL_TOKENS) root.style.removeProperty(`--${name}`);

  if (!tokens) {
    delete root.dataset.palette;
    return;
  }
  for (const [name, value] of Object.entries(tokens))
    root.style.setProperty(`--${name}`, value);
  root.dataset.palette = p.id;
}

/**
 * THE COMPONENT THAT APPLIES IT, rendered once inside the store.
 *
 * It draws nothing. It exists because the palette lives in the workspace
 * preferences and `ThemeProvider` sits OUTSIDE the store — the mode has to be
 * resolved before anything renders, and the preferences arrive over the
 * network. So the mode is a provider and the palette is an effect, and this is
 * the one line of App.tsx that joins them.
 */
export function PaletteTokens() {
  const { resolved } = useTheme();
  const { state } = useStore();
  /* `?? DEFAULT_PALETTE` rather than passing undefined through: the settings
     page resolves the same way when it decides which tile is checked, and two
     places disagreeing about what "no choice" means is how a tick ends up
     beside a palette the page is not wearing. */
  const chosen = state.palette ?? DEFAULT_PALETTE;
  useEffect(() => {
    applyPalette(chosen, resolved);
  }, [chosen, resolved]);
  return null;
}
