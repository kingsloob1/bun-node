import type { NavId, NavItem } from "./layout/nav";
import type { RouteDef } from "./routing";
import { EmptyState } from "./components/EmptyState";
import { Navigate } from "./router";
import { OverviewScreen } from "./screens/Overview";
import { PlaceholderScreen } from "./screens/Placeholder";

/** Route patterns of each nav section; a section's routes exist only when its entry does. */
const SECTION_ROUTES: Readonly<Record<Exclude<NavId, "overview">, string[]>> = {
  queues: ["/queues", "/queues/:queue", "/queues/:queue/*"],
  runners: ["/runners", "/runners/:runner", "/runners/:runner/*"],
  events: ["/events"],
  docs: ["/docs", "/docs/*"],
};

/** The routes this caller can reach, from its nav entries. */
export function buildRoutes(nav: readonly NavItem[]): RouteDef[] {
  const routes: RouteDef[] = [];
  const first = nav[0];
  const overview = nav.find((item) => item.id === "overview");
  routes.push({
    path: "/",
    element: overview ? (
      <OverviewScreen />
    ) : first ? (
      <Navigate to={first.to} />
    ) : (
      <div className="screen">
        <EmptyState
          title="Nothing to show"
          description="This API offers you no screens. Ask for access, or check the mount's sections."
        />
      </div>
    ),
  });
  for (const item of nav) {
    if (item.id === "overview") {
      continue;
    }
    for (const path of SECTION_ROUTES[item.id]) {
      routes.push({
        path,
        element: (
          <PlaceholderScreen
            title={item.label}
            milestone={item.comingIn ?? 0}
          />
        ),
      });
    }
  }
  return routes;
}
