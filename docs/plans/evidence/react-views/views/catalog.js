// The mid-size page every spike renders: a product catalogue of N cards with
// a header, a nav and a footer. Plain `createElement`, no JSX, so Node runs the
// very same file as Bun (Node strips no JSX). About 95 KB of HTML at N = 200.
import { createElement as h, Suspense, use } from "react";

/** Deterministic catalogue data: `count` items. */
export function makeItems(count = 200) {
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push({
      id: i,
      name: `Product ${i} <Deluxe & "Pro">`,
      price: (i * 7.31) % 500,
      description:
        "A sturdy, well-made thing that does exactly what it says on the tin, " +
        `and item ${i} does it with a little more style than the last one.`,
      tags: ["new", i % 2 ? "sale" : "classic", `group-${i % 7}`],
      rating: (i % 5) + 1,
    });
  }
  return items;
}

function Card({ item }) {
  return h(
    "article",
    { className: "card", "data-id": item.id },
    h("h2", { className: "card-title" }, item.name),
    h("p", { className: "price" }, `$${item.price.toFixed(2)}`),
    h("p", { className: "desc" }, item.description),
    h(
      "ul",
      { className: "tags" },
      item.tags.map((tag) => h("li", { key: tag }, tag)),
    ),
    h("span", { className: "rating", "aria-label": `${item.rating} stars` }, "★".repeat(item.rating)),
    h("button", { type: "button", className: "add" }, "Add to cart"),
  );
}

function Nav() {
  const links = [];
  for (let i = 0; i < 12; i++) {
    links.push(h("li", { key: i }, h("a", { href: `/section/${i}` }, `Section ${i}`)));
  }
  return h("nav", null, h("ul", null, links));
}

/** Resolves after `ms` with a list of recommendations; for the Suspense cases. */
export function slowRecommendations(ms) {
  return new Promise((resolve) =>
    setTimeout(() => resolve(["alpha", "beta", "gamma"]), ms),
  );
}

function Recommendations({ promise }) {
  const list = use(promise);
  return h(
    "aside",
    { id: "recs" },
    h("ul", null, list.map((name) => h("li", { key: name }, name))),
  );
}

/**
 * The page body. `recommendations`, when given, is a promise read with
 * `use()` inside a Suspense boundary: the shell can stream before it settles.
 */
export function CatalogBody({ title, items, recommendations }) {
  return h(
    "div",
    { id: "root" },
    h("header", null, h("h1", null, title), h(Nav)),
    h("main", null, items.map((item) => h(Card, { key: item.id, item }))),
    recommendations
      ? h(
          Suspense,
          { fallback: h("p", { id: "recs-loading" }, "Loading recommendations…") },
          h(Recommendations, { promise: recommendations }),
        )
      : null,
    h("footer", null, h("p", null, "© Example Shop")),
  );
}

/** The whole document: `<html>` at the root, `<title>` inside the body tree. */
export function CatalogDocument(props) {
  return h(
    "html",
    { lang: "en" },
    h("head", null, h("meta", { charSet: "utf-8" })),
    h(
      "body",
      null,
      h("title", null, props.title),
      h(CatalogBody, props),
    ),
  );
}
