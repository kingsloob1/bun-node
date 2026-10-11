<script lang="ts">
  import { onMount } from "svelte";
  let { title, start, evil }: { title: string; start: number; evil: string } = $props();
  let count = $state(start);
  let hydrated = $state(false);
  onMount(() => { hydrated = true; });
</script>
<svelte:head><title>{title}</title></svelte:head>
<main data-hydrated={hydrated ? "yes" : "no"}>
  <p id="evil">{evil}</p>
  <button type="button" onclick={() => count++}>count {count}</button>
</main>
