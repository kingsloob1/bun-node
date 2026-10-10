<script setup lang="ts">
// An async setup: awaited by the server renderer inside <Suspense>.
const props = defineProps<{ promise: Promise<string[]> }>();
const list = await props.promise;
</script>
<template><aside id="recs"><ul><li v-for="n in list" :key="n">{{ n }}</li></ul></aside></template>
