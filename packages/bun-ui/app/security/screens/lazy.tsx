/** The screens loaded on demand (the kit's `onDemand`): the first load carries the shell and the Overview. */
import { onDemand } from "../../kit/onDemand";

/** `/api`, on demand: the reference viewer is the largest part of the app. */
export const ApiReferenceScreen = onDemand(
  async () => (await import("./ApiReference")).ApiReference,
  "Loading the API reference",
);

/** Props of a screen of a scope. */
interface ScopeProps {
  /** The scope on screen. */
  scope: string;
}

/** `/bans`, on demand. */
export const BansScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/BansScreen")).BansScreen,
  "Loading the bans",
);

/** `/bans/new`, on demand. */
export const BanNewScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/BanNew")).BanNew,
  "Loading the ban form",
);

/** `/bans/:id`, on demand. */
export const BanDetailScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/BanDetail")).BanDetail,
  "Loading the ban",
);

/** `/bans/auto`, on demand. */
export const AutoBansScreen = onDemand<ScopeProps>(
  async () => (await import("./bans/AutoBans")).AutoBans,
  "Loading the automatic bans",
);

/** `/lists`, on demand. */
export const ListsScreen = onDemand<ScopeProps>(
  async () => (await import("./lists/ListsScreen")).ListsScreen,
  "Loading the lists",
);

/** `/lists/new`, on demand. */
export const ListEntryNewScreen = onDemand<ScopeProps>(
  async () => (await import("./lists/ListEntryNew")).ListEntryNew,
  "Loading the list-entry form",
);

/** `/events` and `/events/:id`, on demand. */
export const EventsScreen = onDemand<ScopeProps>(
  async () => (await import("./events/EventsScreen")).EventsScreen,
  "Loading the events",
);
