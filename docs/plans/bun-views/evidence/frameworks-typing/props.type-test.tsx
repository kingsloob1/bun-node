// Can a handler's return type be checked against a view's props, per
// framework, from TypeScript alone (tsc, no vue-tsc or svelte-check)?
// Each @ts-expect-error is a negative control: if the line stops being an
// error, tsc fails with "Unused '@ts-expect-error' directive".
//
//   ../../../../../node_modules/.bin/tsc -p frameworks-typing   (from the evidence folder)
import type { ComponentType } from "react";
import type { Component as SvelteComponent } from "svelte";
import type { Component as SolidComponent } from "solid-js";
import type { FunctionComponent as PreactFC } from "preact";
import { defineComponent, h } from "vue";
import VueCounter from "../fviews/vue/Counter.vue";
import SvelteCounter from "../fviews/svelte/Counter.svelte";

/** What each adapter subpath would add to by declaration merging. */
interface ComponentPropsOf<C> {
  react: C extends ComponentType<infer P> ? P : never;
  vue: C extends new (...args: any[]) => { $props: infer P } ? P : never;
  svelte: C extends SvelteComponent<infer P> ? P : never;
  solid: C extends SolidComponent<infer P> ? P : never;
}
type PropsOf<C> = ComponentPropsOf<C>[keyof ComponentPropsOf<C>];

/** @RenderComponent's check, as a function: the handler's result against the view's props. */
declare function renderComponent<C>(component: C, props: PropsOf<C>): void;

interface PageProps { name: string; count: number }

// React: a function component.
declare const ReactPage: ComponentType<PageProps>;
renderComponent(ReactPage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type
renderComponent(ReactPage, { name: "a", count: "1" });
// @ts-expect-error missing prop
renderComponent(ReactPage, { name: "a" });

// Vue: a component defined in a .ts file (defineComponent with props).
const VuePage = defineComponent({
  props: { name: { type: String, required: true }, count: { type: Number, required: true } },
  setup: (props) => () => h("p", `${props.name} ${props.count}`),
});
renderComponent(VuePage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type
renderComponent(VuePage, { name: "a", count: "1" });
// @ts-expect-error missing prop
renderComponent(VuePage, { name: "a" });

// Svelte: a Component<Props> value (what svelte-check sees for a .svelte file).
declare const SveltePage: SvelteComponent<PageProps>;
renderComponent(SveltePage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type
renderComponent(SveltePage, { name: "a", count: "1" });

// Solid: a Component<Props>.
declare const SolidPage: SolidComponent<PageProps>;
renderComponent(SolidPage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type
renderComponent(SolidPage, { name: "a", count: "1" });

// THE HOLE: an SFC imported through the shims. Wrong props compile, because
// plain tsc sees DefineComponent<{}, {}, any> and Component<any>.
renderComponent(VueCounter, { nonsense: true });
renderComponent(SvelteCounter, { nonsense: true });

// Preact has no resolver above: React's does not claim a Preact component,
// so its props are `never` and every call is an error. An adapter that is
// not registered types nothing.
declare const PreactPage: PreactFC<PageProps>;
// @ts-expect-error props are never: no resolver matches a Preact component
renderComponent(PreactPage, { name: "a", count: 1 });

// With Preact's resolver merged in (as bun-views/preact would add it), the
// same component is checked, and no other framework's component changes.
interface ComponentPropsOf2<C> extends ComponentPropsOf<C> {
  preact: C extends PreactFC<infer P> ? P : never;
}
type PropsOf2<C> = ComponentPropsOf2<C>[keyof ComponentPropsOf2<C>];
declare function renderComponent2<C>(component: C, props: PropsOf2<C>): void;
renderComponent2(PreactPage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type
renderComponent2(PreactPage, { name: "a", count: "1" });
renderComponent2(ReactPage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type: React's component is still checked
renderComponent2(ReactPage, { name: "a", count: "1" });
renderComponent2(SolidPage, { name: "a", count: 1 });
// @ts-expect-error wrong prop type
renderComponent2(SolidPage, { name: "a", count: "1" });

export {};
