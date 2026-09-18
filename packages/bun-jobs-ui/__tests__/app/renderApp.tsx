import type { FetchLike } from "../../app/api/client";
import type { UiConfig } from "../../shared/config.ts";
import type { MockHandler, MockReply } from "./mockFetch";
import { createApiClient } from "../../app/api/client";
import { App } from "../../app/App";
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
}

/** Renders the whole app (providers + `<App>`) against a mocked API. */
export function renderApp(options: RenderAppOptions = {}) {
  const config = uiConfig(options.config);
  const mock = mockFetch({ ...defaultHandlers(), ...options.handlers });
  const client = createApiClient(config, {
    fetch: options.fetch ?? mock.fetch,
  });
  const queryClient = createQueryClient({ retry: false });
  const result = render(
    <AppProviders
      config={config}
      client={client}
      queryClient={queryClient}
    >
      <App />
    </AppProviders>,
  );
  return { ...result, calls: mock.calls, config, client, queryClient };
}
