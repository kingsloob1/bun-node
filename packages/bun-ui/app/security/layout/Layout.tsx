/**
 * The app frame, the kit's (the user's rule: a UI never sets its own page
 * width), as the config's `chrome` asks (embedding.md §2, §12 item 7).
 * `"full"`: the header with the title, the scope picker, the live badge, the
 * break-glass session and the theme; the section nav (only the sections
 * the operator may use on the scope); the screen in `<main>`. `"tabs"`: the
 * kit's compact bar, the sections as tabs and the scope picker, break-glass
 * badge and live badge, above the screen. `"none"`: the screen under a thin
 * bar of the scope picker and the break-glass badge, so the operator can
 * change scope and always sees an elevated session.
 */
import type { ReactNode } from "react";
import type { Section } from "./nav";
import { useUiConfig } from "../context";
import { LiveStatus } from "../live/LiveStatus";
import { FrameBar } from "../../kit/components/FrameBar";
import { Link } from "../router";
import { ScopePicker } from "../scope/ScopePicker";
import { BreakGlassBadge } from "./BreakGlassBadge";
import { ThemeToggle } from "./ThemeToggle";

/** Props of {@link Layout}. */
export interface LayoutProps {
  /** The sections the operator may use. */
  nav: readonly Section[];
  /** The query every nav link keeps (`?scope=`). */
  query: string;
  /** The screen. */
  children: ReactNode;
}

/** The skip link to the main landmark. */
function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main"
      onClick={(event) => {
        const main = document.getElementById("main");
        if (main) {
          event.preventDefault();
          main.focus();
        }
      }}
    >
      Skip to content
    </a>
  );
}

/** The screen's landmark. */
function Main({ children }: { children: ReactNode }) {
  return (
    <main
      id="main"
      className="app-main"
      tabIndex={-1}
    >
      {children}
    </main>
  );
}

/** See the module's description. */
export function Layout({ nav, query, children }: LayoutProps) {
  const config = useUiConfig();
  if (config.chrome === "tabs" || config.chrome === "none") {
    return (
      <div
        className="app"
        data-chrome={config.chrome}
        data-testid="app-ready"
      >
        <SkipLink />
        <FrameBar
          tabs={
            config.chrome === "tabs"
              ? nav.map((section) => (
                  <li key={section.id}>
                    <Link
                      to={`${section.path}${query}`}
                      activeMatch={section.path === "/" ? "exact" : "prefix"}
                      className="app-tab"
                    >
                      {section.label}
                    </Link>
                  </li>
                ))
              : undefined
          }
          controls={
            <>
              <ScopePicker />
              <BreakGlassBadge />
              {config.chrome === "tabs" && <LiveStatus />}
            </>
          }
        />
        <Main>{children}</Main>
      </div>
    );
  }
  return (
    <div
      className="app"
      data-chrome="full"
      data-testid="app-ready"
    >
      <SkipLink />
      <header className="app-header">
        <Link
          to={`/${query}`}
          className="app-brand"
        >
          {config.title}
        </Link>
        <ScopePicker />
        <div className="app-header-end">
          <BreakGlassBadge />
          <LiveStatus />
          <ThemeToggle />
        </div>
      </header>
      <div className="app-body">
        <nav
          className="app-nav"
          aria-label="Sections"
          data-testid="nav"
        >
          <ul>
            {nav.map((section) => (
              <li key={section.id}>
                <Link
                  to={`${section.path}${query}`}
                  activeMatch={section.path === "/" ? "exact" : "prefix"}
                  className="app-nav-link"
                >
                  {section.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Main>{children}</Main>
      </div>
    </div>
  );
}
