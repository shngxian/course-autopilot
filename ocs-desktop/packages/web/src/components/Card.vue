<template>
	<div class="text-start">
		<div class="rounded pt-1">
			<div
				v-if="title"
				class="mb-2 title fw-bold border-bottom d-flex justify-content-between align-items-center"
			>
				<span>{{ title }}</span>
				<slot name="extra" />
			</div>

			<slot />
		</div>
	</div>
</template>

<script setup lang="ts">
import { toRefs } from 'vue';
interface CardProps {
	title?: string;
	badge?: string;
}
const props = withDefaults(defineProps<CardProps>(), {
	title: '',
	badge: 'gray'
});
const { title } = toRefs(props);
</script>

<style scoped lang="less">
#app .ant-badge-status-dot {
	height: 16px;
	border-radius: 4px;
}

.title {
	font-size: 1rem;
}
</style>
