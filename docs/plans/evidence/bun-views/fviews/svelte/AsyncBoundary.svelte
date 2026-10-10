<script lang="ts">
  import AsyncRecs from "./AsyncRecs.svelte";
  let { title, promise }: { title: string; promise: Promise<string[]> } = $props();
</script>
<main><h1>{title}</h1>
  <svelte:boundary>
    <AsyncRecs {promise} />
    {#snippet pending()}<p id="recs-loading">Loading recommendations…</p>{/snippet}
  </svelte:boundary>
</main>
