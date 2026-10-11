/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
export interface CounterProps { title: string; start: number; evil: string }
export default function Counter({ start, evil }: CounterProps) {
  const [count, setCount] = useState(start);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return (
    <main data-hydrated={hydrated ? "yes" : "no"}>
      <p id="evil">{evil}</p>
      <button type="button" onClick={() => setCount((n) => n + 1)}>count {count}</button>
    </main>
  );
}
