<script lang="ts">
  import type { Item } from "../data";
  import Card from "./Card.svelte";
  let { title, items, recommendations }: { title: string; items: Item[]; recommendations?: Promise<string[]> } = $props();
</script>
<svelte:head><title>{title}</title></svelte:head>
<div id="page">
  <header><h1>{title}</h1><nav><ul>{#each Array.from({ length: 12 }, (_, i) => i) as i (i)}<li><a href={`/section/${i}`}>Section {i}</a></li>{/each}</ul></nav></header>
  <main>{#each items as item (item.id)}<Card {item} />{/each}</main>
  {#if recommendations}
    {#await recommendations}
      <p id="recs-loading">Loading recommendations…</p>
    {:then list}
      <aside id="recs"><ul>{#each list as n (n)}<li>{n}</li>{/each}</ul></aside>
    {/await}
  {/if}
  <footer><p>© Example Shop</p></footer>
</div>
