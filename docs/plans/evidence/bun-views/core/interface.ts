// The framework adapter interface the bun-views plan proposes (§4 of
// ../../bun-views.md), as the spikes implement it. Five adapters implement
// it in ../adapters/; ../frameworks-ssr.ts drives all five through one core
// (./mini-core.ts) to show that the shape holds for more than React.
import type { BunPlugin } from "bun";

/** Which side a compile step is for: server imports, or the client bundle. */
export type ViewSide = "server" | "client";

/** What the core hands an adapter for one render. */
export interface RenderInput<C = unknown> {
  /** The view module's default export. */
  component: C;
  /** The whole view module, for adapter-specific named exports. */
  module: Record<string, unknown>;
  /** The props: merged locals without Express's plumbing keys. */
  props: Record<string, unknown>;
  /** A per-request CSP nonce for every inline script the framework emits. */
  nonce?: string;
  /** Aborts a render that outlives its deadline. */
  signal?: AbortSignal;
  /** Errors the framework reports without throwing (React's boundaries). */
  onError?: (error: unknown) => void;
  /**
   * For an adapter whose output is a whole document (React): the client
   * entry and the props script, which only it can place. A fragment
   * adapter ignores both; the core's shell places them.
   */
  bootstrap?: { src: string; integrity: string; propsScript: string };
}

/**
 * The rendered page: a whole document the adapter built (React renders
 * `<html>` itself, and hoists `<title>` into it), or a fragment and its head
 * tags, which the core's shell wraps.
 */
export type RenderOutput =
  | { kind: "document"; html: string }
  | { kind: "fragment"; head: string; body: string };

/** A streamed render. The promise resolves once the first part is ready. */
export type StreamOutput =
  | { kind: "document"; stream: ReadableStream<Uint8Array> }
  | { kind: "fragment"; head: string; body: ReadableStream<Uint8Array> };

/** What the core asks of a client entry. */
export interface ClientEntryInput {
  /** The view file, absolute. */
  viewPath: string;
  /** The global the core's props script assigns (`self.__BV_PROPS`). */
  propsGlobal: string;
  /** The element a fragment adapter hydrates into (`#bv-root`). */
  rootId: string;
}

/** One UI framework, as the core sees it. */
export interface ViewAdapter<C = unknown> {
  /** `"react"`, `"vue"`, … — in logs and errors. */
  readonly name: string;
  /** The view extensions this adapter renders, with the dot. */
  readonly extensions: readonly string[];
  /**
   * The compile step for files Bun cannot load (`.vue`, `.svelte`, Solid's
   * JSX): registered with `Bun.plugin` for server imports (`"server"`) and
   * passed to `Bun.build` for the client bundle (`"client"`). Absent when
   * Bun loads the views natively (React, Preact).
   */
  plugin?: (side: ViewSide) => BunPlugin;
  /** Renders to a whole string. Required. */
  render: (input: RenderInput<C>) => Promise<RenderOutput>;
  /** Renders to a stream. Optional: Svelte has none. */
  renderToStream?: (input: RenderInput<C>) => Promise<StreamOutput>;
  /**
   * The source of the hydration entry for one view (a module the core
   * bundles with `Bun.build`). Optional: an adapter without it renders
   * server-only pages.
   */
  clientEntry?: (input: ClientEntryInput) => string;
}
