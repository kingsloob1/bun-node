/**
 * The app frame, the kit's (the user's rule: a UI never sets its own page
 * width): the header with the title, the scope picker, the live badge, the
 * break-glass session and the theme; the section nav (only the sections
 * the operator may use on the scope); the screen in `<main>`.
 */
import type { ReactNode } from "react";
import type { Section } from "./nav";
import { useUiConfig } from "../context";
import { LiveStatus } from "../live/LiveStatus";
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

/** See the module's description. */
export function Layout({ nav, query, children }: LayoutProps) {
  const config = useUiConfig();
  return (
    <div
      className="app"
      data-testid="app-ready"
    >
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
        <main
          id="main"
          className="app-main"
          tabIndex={-1}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
