import { createSignal, onMount } from "solid-js";
export interface CounterProps { title: string; start: number; evil: string }
export default function Counter(props: CounterProps) {
  const [count, setCount] = createSignal(props.start);
  const [hydrated, setHydrated] = createSignal(false);
  onMount(() => setHydrated(true));
  return (
    <main data-hydrated={hydrated() ? "yes" : "no"}>
      <p id="evil">{props.evil}</p>
      <button type="button" onClick={() => setCount((n) => n + 1)}>count {count()}</button>
    </main>
  );
}
