import type { ReactNode } from "react";
import type { NavItem } from "./nav";
import { Chip } from "../components/Badge";
import { useUiConfig } from "../context";
import { useMeta } from "../meta/hooks";
import { Link } from "../router";
import { KeyboardShortcuts } from "./KeyboardShortcuts";
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
      <NavList items={nav} />
    </nav>
  );
}

/**
 * One level of the section nav. A parent entry (API docs) is current only on
 * its own page, so exactly one link carries `aria-current="page"`; its
 * children match their whole subtree.
 */
function NavList({
  items,
  nested = false,
}: {
  /** The entries at this level. */
  items: readonly NavItem[];
  /** Whether this list sits under a parent entry. */
  nested?: boolean;
}) {
  return (
    <ul className={nested ? "app-nav-sub" : undefined}>
      {items.map((item) => (
        <li key={item.id}>
          <Link
            to={item.to}
            activeMatch={item.children?.length ? "exact" : "prefix"}
            className="app-nav-link"
          >
            {item.label}
          </Link>
          {item.children?.length ? (
            <NavList
              items={item.children}
              nested
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The app frame: a skip link to the main landmark, the header (banner), the
 * section nav and the screen in `<main>`, plus the keyboard shortcuts (`/`
 * and `?`, see `shortcuts.ts`). Its root carries `data-testid="app-ready"`:
 * it renders only once the bootstrap loaded, and the E2E smoke waits on it.
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
        onClick={(event) => {
          // Focus the main landmark directly: a fragment navigation would
          // put `#main` in the app's URL, and not every browser moves focus.
          const main = document.getElementById("main");
          if (main) {
            event.preventDefault();
            main.focus();
          }
        }}
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
      <KeyboardShortcuts />
    </div>
  );
}
