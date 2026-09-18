import { Layout } from "./layout/Layout";
import { useNav } from "./layout/useNav";
import { Routes } from "./router";
import { buildRoutes } from "./routes";
import { NotFoundScreen } from "./screens/NotFound";

/** The app, below the providers: layout, nav, and the matched screen. */
export function App() {
  const nav = useNav();
  return (
    <Layout nav={nav}>
      <Routes
        routes={buildRoutes(nav)}
        notFound={<NotFoundScreen />}
      />
    </Layout>
  );
}
