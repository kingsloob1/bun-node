/** @jsxImportSource preact */
// Preact reads the JSX runtime from the pragma; Bun honours it per file.
import { Suspense, lazy } from "preact/compat";
import type { Item } from "../data";

function Card({ item }: { item: Item }) {
  return (
    <article class="card" data-id={item.id}>
      <h2 class="card-title">{item.name}</h2>
      <p class="price">${item.price.toFixed(2)}</p>
      <p class="desc">{item.description}</p>
      <ul class="tags">{item.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
      <span class="rating" aria-label={`${item.rating} stars`}>{"★".repeat(item.rating)}</span>
      <button type="button" class="add">Add to cart</button>
    </article>
  );
}

export interface CatalogProps { title: string; items: Item[]; recommendations?: Promise<string[]> }

export default function Catalog({ title, items, recommendations }: CatalogProps) {
  // preact/compat's lazy() suspends until the promise settles.
  const Recs = recommendations
    ? lazy(async () => {
        const list = await recommendations;
        return { default: () => <aside id="recs"><ul>{list.map((n) => <li key={n}>{n}</li>)}</ul></aside> };
      })
    : null;
  return (
    <div id="page">
      <header><h1>{title}</h1><nav><ul>{Array.from({ length: 12 }, (_, i) => <li key={i}><a href={`/section/${i}`}>Section {i}</a></li>)}</ul></nav></header>
      <main>{items.map((item) => <Card key={item.id} item={item} />)}</main>
      {Recs ? <Suspense fallback={<p id="recs-loading">Loading recommendations…</p>}><Recs /></Suspense> : null}
      <footer><p>© Example Shop</p></footer>
    </div>
  );
}
