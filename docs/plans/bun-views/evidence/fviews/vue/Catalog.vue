<script setup lang="ts">
import type { Item } from "../data";
import Card from "./Card.vue";
import Recs from "./Recs.vue";
defineProps<{ title: string; items: Item[]; recommendations?: Promise<string[]> }>();
</script>
<template>
  <Teleport to="head"><title>{{ title }}</title></Teleport>
  <div id="page">
    <header><h1>{{ title }}</h1><nav><ul><li v-for="i in 12" :key="i"><a :href="`/section/${i - 1}`">Section {{ i - 1 }}</a></li></ul></nav></header>
    <main><Card v-for="item in items" :key="item.id" :item="item" /></main>
    <Suspense v-if="recommendations">
      <Recs :promise="recommendations" />
      <template #fallback><p id="recs-loading">Loading recommendations…</p></template>
    </Suspense>
    <footer><p>© Example Shop</p></footer>
  </div>
</template>
