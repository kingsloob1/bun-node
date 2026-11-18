/** Cycles the colour theme (system, light, dark) and remembers it. */
import type { UiTheme } from "../../../lib/security/browser/config.ts";
import { useState } from "react";
import { Button } from "../../kit/components/Button";
import { useUiConfig } from "../context";
import { applyTheme, initialTheme, nextTheme, storeTheme } from "../theme";
import { useUiRoot } from "../../kit/frame";

/** The themes' labels. */
const LABELS: Readonly<Record<UiTheme, string>> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/** See the module's description. */
export function ThemeToggle() {
  const config = useUiConfig();
  const root = useUiRoot();
  const [theme, setTheme] = useState<UiTheme>(() => initialTheme(config.theme));
  const next = nextTheme(theme);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="theme-toggle"
      aria-label={`Theme: ${LABELS[theme]}. Switch to ${LABELS[next]}.`}
      onClick={() => {
        setTheme(next);
        storeTheme(next);
        applyTheme(next, root);
      }}
    >
      <span aria-hidden="true">Theme:</span> {LABELS[theme]}
    </Button>
  );
}
