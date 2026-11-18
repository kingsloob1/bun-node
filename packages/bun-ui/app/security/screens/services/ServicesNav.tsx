/** The services section's two screens: the services and the groups. */
import { Link } from "../../router";

/** Props of {@link ServicesNav}. */
export interface ServicesNavProps {
  /** The screen on show. */
  current: "services" | "groups";
}

/** See the module's description. */
export function ServicesNav({ current }: ServicesNavProps) {
  return (
    <nav
      className="services-nav"
      aria-label="Services and groups"
    >
      <Link
        to="/services"
        aria-current={current === "services" ? "page" : undefined}
      >
        Services
      </Link>
      <Link
        to="/groups"
        aria-current={current === "groups" ? "page" : undefined}
      >
        Groups
      </Link>
    </nav>
  );
}
