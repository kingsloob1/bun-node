// The usual shims an application adds so plain tsc accepts the imports;
// vue-tsc and svelte-check replace them with the real types, tsc cannot.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<any>;
  export default component;
}
