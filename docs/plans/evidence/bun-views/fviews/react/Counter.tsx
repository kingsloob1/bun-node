import { useEffect, useState } from "react";
export interface CounterProps { title: string; start: number; evil: string }
export default function Counter({ title, start, evil }: CounterProps) {
  const [count, setCount] = useState(start);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <main data-hydrated={hydrated ? "yes" : "no"}>
      <title>{title}</title>
      <p id="evil">{evil}</p>
      <button type="button" onClick={() => setCount((n) => n + 1)}>count {count}</button>
    </main>
  );
}
