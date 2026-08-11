<script setup lang="ts">
  import { useI18n } from "vue-i18n";
  import { useTreeState } from "~~/components/Location/Tree/tree-state";
  import MdiExpandAllOutline from "~icons/mdi/expand-all-outline";
  import MdiPackageVariant from "~icons/mdi/package-variant";

  import { Button, ButtonGroup } from "@/components/ui/button";
  import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
  import BaseContainer from "@/components/Base/Container.vue";
  import BaseSectionHeader from "@/components/Base/SectionHeader.vue";
  import LocationTreeRoot from "~/components/Location/Tree/Root.vue";
  import LocationCard from "@/components/Location/Card.vue";
  import BaseCard from "@/components/Base/Card.vue";

  const { t } = useI18n();

  // TODO: eventually move to https://reka-ui.com/docs/components/tree#draggable-sortable-tree

  definePageMeta({
    middleware: ["auth"],
  });

  useHead({
    title: "HomeBox | " + t("menu.locations"),
  });

  const api = useUserApi();

  const { data: tree } = useAsyncData(async () => {
    const { data, error } = await api.items.getTree({
      withItems: true,
    });

    if (error) {
      return [];
    }

    return data;
  });

  const locationTreeId = "locationTree";
  const showItemsKey = "showItems";

  const treeState = useTreeState(locationTreeId);
  const showItems = ref(true);
  const viewMode = ref("tree");

  const route = useRouter();

  onMounted(() => {
    // set tree state from query params
    const query = route.currentRoute.value.query;

    if (query && query[locationTreeId]) {
      console.debug("setting tree state from query params");
      const data = JSON.parse(query[locationTreeId] as string);

      for (const key in data) {
        treeState.value[key] = data[key];
      }
    }

    if (query && query[showItemsKey] !== undefined) {
      showItems.value = query[showItemsKey] === "true";
    }

    if (query && query.view !== undefined) {
      viewMode.value = query.view as string;
    }
  });

  watch(
    [treeState, showItems, viewMode],
    () => {
      route.replace({
        query: {
          [locationTreeId]: JSON.stringify(treeState.value),
          [showItemsKey]: showItems.value.toString(),
          view: viewMode.value,
        },
      });
    },
    { deep: true }
  );

  // Compute root locations that are of type "location" from the tree
  const rootLocations = computed(() => {
    if (!tree.value) return [];
    // Return only top-level items that are locations, mapping them to look like EntitySummary
    return tree.value
      .filter(item => item.type === "location" && item.name !== "00 Inbox")
      .map(item => ({
        id: item.id,
        name: item.name,
        // Map tree children to count items vs sub-locations
        itemCount: item.children ? item.children.filter(c => c.type === "item").length : 0,
      }));
  });

  const filteredTree = computed(() => {
    if (!tree.value) return [];
    return tree.value.filter(item => item.name !== "00 Inbox");
  });
</script>

<template>
  <BaseContainer>
    <div class="mb-2 flex justify-between">
      <BaseSectionHeader> {{ $t("menu.locations") }} </BaseSectionHeader>
      <div>
        <TooltipProvider :delay-duration="0">
          <ButtonGroup>
            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="icon"
                  :variant="viewMode === 'tree' ? 'default' : 'outline'"
                  data-pos="start"
                  @click="viewMode = 'tree'"
                >
                  <MdiExpandAllOutline />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Tree View</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger>
                <Button
                  size="icon"
                  :variant="viewMode === 'grid' ? 'default' : 'outline'"
                  data-pos="middle"
                  @click="viewMode = 'grid'"
                >
                  <MdiPackageVariant />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Visual Grid View</p>
              </TooltipContent>
            </Tooltip>
          </ButtonGroup>
        </TooltipProvider>
      </div>
    </div>
    <div v-if="viewMode === 'grid'">
      <div v-if="rootLocations.length === 0" class="py-6 text-center text-sm text-muted-foreground">
        <p>No locations found.</p>
      </div>
      <div v-else class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <LocationCard v-for="loc in rootLocations" :key="loc.id" :location="loc" />
      </div>
    </div>
    <BaseCard v-else>
      <div class="p-2">
        <LocationTreeRoot
          v-if="filteredTree && filteredTree.length"
          :locs="filteredTree"
          :tree-id="locationTreeId"
          :show-items="showItems"
        />
      </div>
    </BaseCard>
  </BaseContainer>
</template>


