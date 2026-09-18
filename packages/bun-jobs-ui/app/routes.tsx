import type { NavId, NavItem } from "./layout/nav";
import type { RouteDef } from "./routing";
import { EmptyState } from "./components/EmptyState";
import {
  QueuePermissionScope,
  RunnerPermissionScope,
} from "./meta/PermissionScope";
import { Navigate } from "./router";
import {
  JobScreen,
  QueueScreen,
  QueuesListScreen,
  RunnerScreen,
  RunnersListScreen,
} from "./screens/lazy";
import { OverviewScreen } from "./screens/Overview";
import { PlaceholderScreen } from "./screens/Placeholder";

/**
 * Route patterns of the sections still shown as placeholders; a section's
 * routes exist only when its entry does. Built sections register their own
 * routes in {@link buildRoutes}.
 */
const PLACEHOLDER_ROUTES: Readonly<
  Record<Exclude<NavId, "overview" | "queues" | "runners">, string[]>
> = {
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
    if (item.id === "queues") {
      // Most specific first: the router takes the first match.
      routes.push(
        {
          path: "/queues/:queue/jobs/:id",
          element: (
            <QueuePermissionScope>
              <JobScreen />
            </QueuePermissionScope>
          ),
        },
        {
          path: "/queues/:queue",
          element: (
            <QueuePermissionScope>
              <QueueScreen />
            </QueuePermissionScope>
          ),
        },
        { path: "/queues", element: <QueuesListScreen /> },
      );
      continue;
    }
    if (item.id === "runners") {
      routes.push(
        {
          path: "/runners/:runner",
          element: (
            <RunnerPermissionScope>
              <RunnerScreen />
            </RunnerPermissionScope>
          ),
        },
        { path: "/runners", element: <RunnersListScreen /> },
      );
      continue;
    }
    for (const path of PLACEHOLDER_ROUTES[item.id]) {
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
