// Solid's JSX compiles to templates (babel-preset-solid), not to calls of a
// JSX runtime, so this file goes through the adapter's Babel plugin.
import { For, Show, Suspense, createResource } from "solid-js";
import type { Item } from "../data";

function Card(props: { item: Item }) {
  return (
    <article class="card" data-id={props.item.id}>
      <h2 class="card-title">{props.item.name}</h2>
      <p class="price">${props.item.price.toFixed(2)}</p>
      <p class="desc">{props.item.description}</p>
      <ul class="tags"><For each={props.item.tags}>{(tag) => <li>{tag}</li>}</For></ul>
      <span class="rating" aria-label={`${props.item.rating} stars`}>{"★".repeat(props.item.rating)}</span>
      <button type="button" class="add">Add to cart</button>
    </article>
  );
}

function Recs(props: { promise: Promise<string[]> }) {
  const [list] = createResource(() => props.promise);
  return <aside id="recs"><ul><For each={list()}>{(n) => <li>{n}</li>}</For></ul></aside>;
}

export interface CatalogProps { title: string; items: Item[]; recommendations?: Promise<string[]> }

export default function Catalog(props: CatalogProps) {
  return (
    <div id="page">
      <header><h1>{props.title}</h1><nav><ul><For each={Array.from({ length: 12 }, (_, i) => i)}>{(i) => <li><a href={`/section/${i}`}>Section {i}</a></li>}</For></ul></nav></header>
      <main><For each={props.items}>{(item) => <Card item={item} />}</For></main>
      <Show when={props.recommendations}>
        {(p) => <Suspense fallback={<p id="recs-loading">Loading recommendations…</p>}><Recs promise={p()} /></Suspense>}
      </Show>
      <footer><p>© Example Shop</p></footer>
    </div>
  );
}
