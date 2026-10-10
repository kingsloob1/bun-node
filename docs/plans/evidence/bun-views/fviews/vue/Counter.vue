<script setup lang="ts">
import { onMounted, ref } from "vue";
const props = defineProps<{ title: string; start: number; evil: string }>();
const count = ref(props.start);
const hydrated = ref(false);
onMounted(() => { hydrated.value = true; });
</script>
<template>
  <main :data-hydrated="hydrated ? 'yes' : 'no'">
    <p id="evil">{{ evil }}</p>
    <button type="button" @click="count++">count {{ count }}</button>
  </main>
</template>
