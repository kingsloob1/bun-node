/**
 * The app: the scope on screen, its permissions and live stream, the frame
 * and nav (only the sections the operator may use there), and the routes —
 * a section the operator may not use shows "No access".
 */
import type { ReactNode } from "react";
import { useCanFn } from "./meta/hooks";
import { LiveProvider } from "./live/LiveProvider";
import { Layout } from "./layout/Layout";
import { SECTIONS } from "./layout/nav";
import { Routes } from "./router";
import { useLocation } from "./routing";
import { ScopePermissions } from "./scope/ScopePermissions";
import { SCOPE_PARAM } from "./scope/scope";
import { useScope } from "./scope/useScope";
import { ApiReferenceScreen } from "./screens/lazy";
import { NoAccess } from "./screens/NoAccess";
import { NotFound } from "./screens/NotFound";
import { Overview } from "./screens/Overview";

/** The routes and nav for the scope on screen (inside its permissions). */
function Sections({ scope }: { scope: string | null }) {
  const can = useCanFn();
  const { search } = useLocation();
  const allowed = (needs: (typeof SECTIONS)[number]["needs"]) =>
    needs === null || (scope !== null && can(needs));
  const nav = SECTIONS.filter((section) => allowed(section.needs));
  const named = new URLSearchParams(search).get(SCOPE_PARAM);
  const query =
    named === null ? "" : `?${SCOPE_PARAM}=${encodeURIComponent(named)}`;
  const guard = (id: string, element: ReactNode) => {
    const section = SECTIONS.find((item) => item.id === id)!;
    return allowed(section.needs) ? (
      element
    ) : (
      <NoAccess
        section={section.label}
        scope={scope}
        needs={section.needs ?? ""}
      />
    );
  };
  return (
    <Layout
      nav={nav}
      query={query}
    >
      <Routes
        routes={[
          {
            path: "/",
            element: guard(
              "overview",
              scope === null ? null : <Overview scope={scope} />,
            ),
          },
          { path: "/api/*", element: guard("api", <ApiReferenceScreen />) },
          { path: "/api", element: guard("api", <ApiReferenceScreen />) },
        ]}
        notFound={<NotFound />}
      />
    </Layout>
  );
}

/** See the module's description. */
export function App() {
  const { scope } = useScope();
  const sections = <Sections scope={scope} />;
  return (
    <LiveProvider scope={scope}>
      {scope === null ? (
        sections
      ) : (
        <ScopePermissions scope={scope}>{sections}</ScopePermissions>
      )}
    </LiveProvider>
  );
}
