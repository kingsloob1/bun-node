import type { ReactNode } from "react";
import type { NavItem } from "./nav";
import { Chip } from "../components/Badge";
import { useUiConfig } from "../context";
import { useMeta } from "../meta/hooks";
import { Link } from "../router";
import { LiveStatus } from "./LiveStatus";
import { ThemeToggle } from "./ThemeToggle";

/** Props of {@link Layout}. */
export interface LayoutProps {
  /** The entries the caller can use. */
  nav: readonly NavItem[];
  /** The current screen. */
  children: ReactNode;
}

/** The header: brand, namespace/driver/mode chips, live status, theme toggle. */
export function Header() {
  const config = useUiConfig();
  const meta = useMeta();
  return (
    <header className="app-header">
      <Link
        to="/"
        className="app-brand"
      >
        {config.title}
      </Link>
      <div
        className="app-chips"
        aria-label="API"
      >
        <Chip
          label="namespace"
          value={meta.namespace}
        />
        <Chip
          label="driver"
          value={meta.driver.name}
        />
        <Chip
          label="mode"
          value={meta.mode}
        />
        {meta.readOnly && (
          <Chip
            label="read-only"
            value="yes"
          />
        )}
      </div>
      <div className="app-header-end">
        <LiveStatus />
        <ThemeToggle />
      </div>
    </header>
  );
}

/** The section nav. */
export function Sidebar({ nav }: { nav: readonly NavItem[] }) {
  return (
    <nav
      className="app-nav"
      aria-label="Sections"
    >
      <ul>
        {nav.map((item) => (
          <li key={item.id}>
            <Link
              to={item.to}
              activeMatch="prefix"
              className="app-nav-link"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The app frame. Its root carries `data-testid="app-ready"`: it renders only
 * once the bootstrap loaded, and the E2E smoke waits on it.
 */
export function Layout({ nav, children }: LayoutProps) {
  return (
    <div
      className="app"
      data-testid="app-ready"
    >
      <a
        className="skip-link"
        href="#main"
      >
        Skip to content
      </a>
      <Header />
      <div className="app-body">
        <Sidebar nav={nav} />
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
