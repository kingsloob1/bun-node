<script lang="ts">
  import type { Item } from "../data";
  let { item }: { item: Item } = $props();
</script>
<article class="card" data-id={item.id}>
  <h2 class="card-title">{item.name}</h2>
  <p class="price">${item.price.toFixed(2)}</p>
  <p class="desc">{item.description}</p>
  <ul class="tags">{#each item.tags as tag (tag)}<li>{tag}</li>{/each}</ul>
  <span class="rating" aria-label={`${item.rating} stars`}>{"★".repeat(item.rating)}</span>
  <button type="button" class="add">Add to cart</button>
</article>
