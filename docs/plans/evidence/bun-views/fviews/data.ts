// The catalogue data every framework's page renders (views/catalog.js's).
export interface Item { id: number; name: string; price: number; description: string; tags: string[]; rating: number }
export function makeItems(count = 200): Item[] {
  const items: Item[] = [];
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
export const slow = (ms: number) => new Promise<string[]>((r) => setTimeout(() => r(["alpha", "beta", "gamma"]), ms));
