import type { UiTheme } from "../../shared/config.ts";
import { useState } from "react";
import { Button } from "../components/Button";
import { useUiConfig } from "../context";
import { applyTheme, initialTheme, nextTheme, storeTheme } from "../theme";

/** Labels of each theme, for the toggle. */
const THEME_LABELS: Readonly<Record<UiTheme, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** Cycles system → light → dark, remembering the choice in `localStorage`. */
export function ThemeToggle() {
  const config = useUiConfig();
  const [theme, setTheme] = useState<UiTheme>(() => initialTheme(config.theme));
  const next = nextTheme(theme);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="theme-toggle"
      aria-label={`Theme: ${THEME_LABELS[theme]}. Switch to ${THEME_LABELS[next]}.`}
      title={`Theme: ${THEME_LABELS[theme]}`}
      onClick={() => {
        setTheme(next);
        storeTheme(next);
        applyTheme(next);
      }}
    >
      <span aria-hidden="true">Theme:</span> {THEME_LABELS[theme]}
    </Button>
  );
}
