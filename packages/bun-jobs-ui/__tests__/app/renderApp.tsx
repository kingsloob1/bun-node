import type { FetchLike } from "../../app/api/client";
import type { LiveOptions } from "../../app/live";
import type { UiConfig } from "../../lib/shared/config.ts";
import type { MockHandler, MockReply } from "./mockFetch";
import { createApiClient } from "../../app/api/client";
import { App } from "../../app/App";
import { LiveOptionsContext } from "../../app/live";
import { AppProviders } from "../../app/providers";
import { createQueryClient } from "../../app/queryClient";
import { render } from "./dom";
import {
  metaFixture,
  overviewFixture,
  permissionsFixture,
  queueListFixture,
  throughputFixture,
  uiConfig,
  workersFixture,
} from "./fixtures";
import { mockFetch } from "./mockFetch";

/** Handlers answering every route milestone 1 reads, from the fixtures. */
export function defaultHandlers(): Record<string, MockHandler | MockReply> {
  return {
    "GET /meta": { body: metaFixture() },
    "GET /meta/permissions": { body: permissionsFixture() },
    "GET /overview": { body: overviewFixture() },
    "GET /queues": { body: queueListFixture() },
    "GET /queues/emails/throughput": { body: throughputFixture() },
    "GET /queues/reports/throughput": { body: throughputFixture() },
    "GET /workers": { body: workersFixture },
  };
}

/** Options of {@link renderApp}. */
export interface RenderAppOptions {
  /** Config overrides. */
  config?: Partial<UiConfig>;
  /** Route handlers, merged over {@link defaultHandlers}. */
  handlers?: Record<string, MockHandler | MockReply>;
  /** Use this `fetch` instead of the mock. */
  fetch?: FetchLike;
  /**
   * The live socket's options. Defaults to `{ disabled: true }`: there is no
   * server to connect to, so live updates stay off and screens poll. Pass
   * `{ WebSocket: FakeSocket }` (`live/fakes.ts`) to drive it.
   */
  live?: LiveOptions;
  /**
   * Retry failed reads with the app's real policy (`shouldRetry`). Defaults
   * to `false`, so a failure shows at once.
   */
  retry?: boolean;
}

/** Live updates off: the default for {@link renderApp}. */
const LIVE_OFF: LiveOptions = { disabled: true };

/** Renders the whole app (providers + `<App>`) against a mocked API. */
export function renderApp(options: RenderAppOptions = {}) {
  const config = uiConfig(options.config);
  const mock = mockFetch({ ...defaultHandlers(), ...options.handlers });
  const client = createApiClient(config, {
    fetch: options.fetch ?? mock.fetch,
  });
  const queryClient = createQueryClient({ retry: options.retry ?? false });
  const result = render(
    <LiveOptionsContext value={options.live ?? LIVE_OFF}>
      <AppProviders
        config={config}
        client={client}
        queryClient={queryClient}
      >
        <App />
      </AppProviders>
    </LiveOptionsContext>,
  );
  return { ...result, calls: mock.calls, config, client, queryClient };
}
