<script lang="ts">
  import AsyncRecs from "./AsyncRecs.svelte";
  let { title, promise }: { title: string; promise: Promise<string[]> } = $props();
</script>
<svelte:head><title>{title}</title></svelte:head>
<main><h1>{title}</h1><AsyncRecs {promise} /></main>
