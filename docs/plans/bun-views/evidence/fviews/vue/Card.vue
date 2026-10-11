<script setup lang="ts">
import type { Item } from "../data";
defineProps<{ item: Item }>();
</script>
<template>
  <article class="card" :data-id="item.id">
    <h2 class="card-title">{{ item.name }}</h2>
    <p class="price">${{ item.price.toFixed(2) }}</p>
    <p class="desc">{{ item.description }}</p>
    <ul class="tags"><li v-for="tag in item.tags" :key="tag">{{ tag }}</li></ul>
    <span class="rating" :aria-label="`${item.rating} stars`">{{ "★".repeat(item.rating) }}</span>
    <button type="button" class="add">Add to cart</button>
  </article>
</template>
