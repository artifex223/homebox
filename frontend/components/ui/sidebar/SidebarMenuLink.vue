<script setup lang="ts">
  import { computed } from "vue";
  import { useSidebar } from "./utils";
  import SidebarMenuButton from "./SidebarMenuButton.vue";

  const { setOpenMobile } = useSidebar();

  const props = defineProps<{
    href: string;
  }>();

  const isExternal = computed(() => props.href.startsWith("/capture") || props.href.startsWith("http"));
</script>

<template>
  <SidebarMenuButton as-child>
    <NuxtLink :to="props.href" :external="isExternal" @click="setOpenMobile(false)">
      <slot />
    </NuxtLink>
  </SidebarMenuButton>
</template>

