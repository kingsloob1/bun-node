// The catalogue page (views/catalog.js's markup) as a React view.
import { Suspense, use } from "react";
import type { Item } from "../data";

function Card({ item }: { item: Item }) {
  return (
    <article className="card" data-id={item.id}>
      <h2 className="card-title">{item.name}</h2>
      <p className="price">${item.price.toFixed(2)}</p>
      <p className="desc">{item.description}</p>
      <ul className="tags">{item.tags.map((tag) => <li key={tag}>{tag}</li>)}</ul>
      <span className="rating" aria-label={`${item.rating} stars`}>{"★".repeat(item.rating)}</span>
      <button type="button" className="add">Add to cart</button>
    </article>
  );
}

function Recs({ promise }: { promise: Promise<string[]> }) {
  const list = use(promise);
  return <aside id="recs"><ul>{list.map((n) => <li key={n}>{n}</li>)}</ul></aside>;
}

export interface CatalogProps { title: string; items: Item[]; recommendations?: Promise<string[]> }

export default function Catalog({ title, items, recommendations }: CatalogProps) {
  return (
    <div id="page">
      <title>{title}</title>
      <header><h1>{title}</h1><nav><ul>{Array.from({ length: 12 }, (_, i) => <li key={i}><a href={`/section/${i}`}>Section {i}</a></li>)}</ul></nav></header>
      <main>{items.map((item) => <Card key={item.id} item={item} />)}</main>
      {recommendations ? <Suspense fallback={<p id="recs-loading">Loading recommendations…</p>}><Recs promise={recommendations} /></Suspense> : null}
      <footer><p>© Example Shop</p></footer>
    </div>
  );
}
