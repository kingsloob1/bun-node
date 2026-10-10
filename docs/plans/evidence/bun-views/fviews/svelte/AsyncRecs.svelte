<script lang="ts">
  // `await` in markup: needs the compiler's experimental.async (Svelte 5.36+).
  let { promise }: { promise: Promise<string[]> } = $props();
</script>
<aside id="recs"><ul>{#each await promise as n (n)}<li>{n}</li>{/each}</ul></aside>
