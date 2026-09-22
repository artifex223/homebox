<script setup lang="ts">
  import { Check, ChevronsUpDown } from "lucide-vue-next";
  import fuzzysort from "fuzzysort";
  import { useI18n } from "vue-i18n";
  import { DialogID } from "@/components/ui/dialog-provider/utils";
  import { useDialog } from "@/components/ui/dialog-provider";
  import { toast } from "@/components/ui/sonner";
  import { Button } from "@/components/ui/button";
  import { Checkbox } from "@/components/ui/checkbox";
  import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "@/components/ui/dialog";
  import { Input } from "@/components/ui/input";
  import { Label } from "@/components/ui/label";
  import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
  import MdiLoading from "~icons/mdi/loading";
  import { cn } from "~/lib/utils";
  import { MDI_ICON_OPTIONS, hasIcon, normalizeIconSlug, resolveIcon } from "~~/lib/nelko/mdi-paths";
  import {
    buildLabelSvg,
    computeLabelLayout,
    createCanvasMeasurer,
    downloadBlob,
    encode1BitPng,
    renderLabelToCanvas,
    svgToBlob,
    type LabelEntityType,
    type LabelLayout,
    type LabelSpec,
  } from "~~/lib/nelko/label-renderer";
  import type { EntityOut, EntityPath, EntityUpdate } from "~~/lib/api/types/data-contracts";

  const props = defineProps<{
    /** Entity UUID, or the asset id when `type` is `asset`. */
    id: string;
    type: string;
  }>();

  const { t } = useI18n();
  const api = useUserApi();
  const { activeDialog, closeDialog } = useDialog();

  const isOpen = computed(() => activeDialog.value === DialogID.NelkoLabel);
  const labelType = computed<LabelEntityType>(() => {
    if (props.type === "location" || props.type === "asset" || props.type === "item") {
      return props.type;
    }
    return "entity";
  });

  const previewCanvas = ref<HTMLCanvasElement | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const loadError = ref<string | null>(null);

  const entity = ref<EntityOut | null>(null);
  const ancestors = ref<string[]>([]);
  /** UUID used for API writes; differs from `props.id` for asset labels. */
  const entityId = ref<string>("");

  const iconSlug = ref<string>("archive-outline");
  const customSlug = ref<string>("");
  const iconPickerOpen = ref(false);
  const iconSearch = ref("");
  const saveAsDefault = ref(false);

  const layout = ref<LabelLayout | null>(null);
  const svg = ref<string>("");
  const bitPlane = ref<Uint8Array | null>(null);

  const measure = createCanvasMeasurer();

  const filteredIcons = computed(() => {
    if (!iconSearch.value) return MDI_ICON_OPTIONS;
    return fuzzysort
      .go(iconSearch.value, MDI_ICON_OPTIONS, { keys: ["label", "slug", "group"], threshold: -10000 })
      .map(result => result.obj);
  });

  const selectedIconLabel = computed(
    () => MDI_ICON_OPTIONS.find(option => option.slug === iconSlug.value)?.label ?? iconSlug.value
  );

  const filename = computed(() => `label-${labelType.value}-${props.id}`);

  const spec = computed<LabelSpec | null>(() => {
    if (!entity.value) return null;
    return {
      title: entity.value.name,
      ancestors: ancestors.value,
      type: labelType.value,
      routeId: props.id,
      entityId: entityId.value,
      icon: iconSlug.value,
      description: entity.value.description,
    };
  });

  /** Resolves the entity behind the label, plus its ancestry trail. */
  async function hydrate() {
    loading.value = true;
    loadError.value = null;
    try {
      let targetId = props.id;

      if (labelType.value === "asset") {
        // An asset label is addressed by asset id; resolve it to the entity.
        const { data, error } = await api.assets.get(props.id, 1, 1);
        if (error || !data?.items?.length) throw new Error("asset-not-found");
        // The length check above guarantees a first element.
        targetId = data.items[0]!.id;
      }

      const { data, error } = await api.items.get(targetId);
      if (error || !data) throw new Error("entity-not-found");

      entity.value = data;
      entityId.value = data.id;

      const { data: path, error: pathError } = await api.items.fullpath(data.id);
      // The trail ends with the entity itself, which the title already carries.
      ancestors.value =
        !pathError && Array.isArray(path)
          ? (path as EntityPath[]).filter(part => part.id !== data.id).map(part => part.name)
          : [];

      iconSlug.value = resolveIcon(data.name, data.description ?? "", null, labelType.value === "location");
      customSlug.value = "";
      saveAsDefault.value = false;
    } catch {
      loadError.value = t("components.global.nelko_label.toast.load_failed");
      toast.error(t("components.global.nelko_label.toast.load_failed"));
    } finally {
      loading.value = false;
    }
  }

  /** Recomputes the layout, SVG and binarized canvas preview. */
  async function refreshPreview() {
    if (!spec.value) return;
    try {
      const nextLayout = computeLabelLayout(spec.value, measure);
      const nextSvg = buildLabelSvg(nextLayout);
      layout.value = nextLayout;
      svg.value = nextSvg;

      await nextTick();
      if (!previewCanvas.value) return;
      const { plane } = await renderLabelToCanvas(previewCanvas.value, nextSvg);
      bitPlane.value = plane;
    } catch (err) {
      console.error("Failed to render the Nelko label preview:", err);
      toast.error(t("components.global.nelko_label.toast.render_failed"));
    }
  }

  function selectIcon(slug: string) {
    iconSlug.value = slug;
    customSlug.value = "";
    iconPickerOpen.value = false;
  }

  function applyCustomSlug() {
    const normalized = normalizeIconSlug(customSlug.value);
    if (!normalized) return;
    if (!hasIcon(normalized)) {
      toast.error(t("components.global.nelko_label.toast.unknown_icon", { slug: normalized }));
      return;
    }
    iconSlug.value = normalized;
  }

  async function persistIconIfRequested() {
    if (!saveAsDefault.value || !entity.value) return;
    saving.value = true;
    try {
      const current = entity.value.description ?? "";
      const directive = `icon: mdi:${iconSlug.value}`;
      const description = /(?:^|\n)\s*icon:\s*(?:mdi:)?[a-z0-9-]+/i.test(current)
        ? current.replace(/(^|\n)\s*icon:\s*(?:mdi:)?[a-z0-9-]+/i, `$1${directive}`)
        : `${current.trimEnd()}${current.trim() ? "\n" : ""}${directive}`;

      // Mirrors the edit pages: spread the fetched entity, then flatten the
      // edge objects the update contract expects as ids.
      const payload: EntityUpdate = {
        ...entity.value,
        description,
        entityTypeId: entity.value.entityType?.id ?? "",
        parentId: entity.value.parent?.id ?? null,
        tagIds: entity.value.tags?.map(tag => tag.id) ?? [],
      };

      const { error } = await api.items.update(entity.value.id, payload);

      if (error) throw new Error("update-failed");
      entity.value = { ...entity.value, description };
      saveAsDefault.value = false;
      toast.success(t("components.global.nelko_label.toast.icon_saved"));
    } catch {
      toast.error(t("components.global.nelko_label.toast.icon_save_failed"));
    } finally {
      saving.value = false;
    }
  }

  async function downloadPng() {
    if (!bitPlane.value || !previewCanvas.value) {
      await refreshPreview();
    }
    if (!bitPlane.value) return;
    const png = await encode1BitPng(bitPlane.value, 400, 240);
    downloadBlob(new Blob([png as unknown as BlobPart], { type: "image/png" }), `${filename.value}.png`);
    await persistIconIfRequested();
  }

  async function downloadSvg() {
    if (!svg.value) return;
    downloadBlob(svgToBlob(svg.value), `${filename.value}.svg`);
    await persistIconIfRequested();
  }

  watch(isOpen, async open => {
    if (!open) return;
    await hydrate();
    await refreshPreview();
  });

  // Any control change re-renders the label, so the preview is always the artwork.
  watch([iconSlug, entity], () => {
    if (isOpen.value) void refreshPreview();
  });
</script>

<template>
  <Dialog :dialog-id="DialogID.NelkoLabel">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ $t("components.global.nelko_label.title") }}</DialogTitle>
        <DialogDescription>
          {{ $t("components.global.nelko_label.description") }}
        </DialogDescription>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <div class="flex flex-col items-center gap-2">
          <!-- 400 x 240 is the exact 50mm x 30mm raster at 203 DPI. -->
          <canvas
            ref="previewCanvas"
            width="400"
            height="240"
            class="h-auto w-full max-w-[400px] rounded border border-border bg-white"
            :aria-label="$t('components.global.nelko_label.preview_alt')"
          />
          <p v-if="loading" class="flex items-center gap-2 text-sm text-muted-foreground">
            <MdiLoading class="animate-spin" />
            {{ $t("components.global.nelko_label.loading") }}
          </p>
          <p v-else-if="loadError" class="text-sm text-destructive">{{ loadError }}</p>
          <p v-else-if="layout" class="text-center text-xs text-muted-foreground">
            {{ layout.url }}
          </p>
        </div>

        <div class="flex flex-col gap-1">
          <Label for="nelko-icon-picker" class="px-1">
            {{ $t("components.global.nelko_label.icon") }}
          </Label>
          <Popover v-model:open="iconPickerOpen">
            <PopoverTrigger as-child>
              <Button
                id="nelko-icon-picker"
                variant="outline"
                role="combobox"
                :aria-expanded="iconPickerOpen"
                class="w-full justify-between"
              >
                <span class="min-w-0 flex-auto truncate text-left">{{ selectedIconLabel }}</span>
                <ChevronsUpDown class="ml-2 size-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent class="w-[--reka-popper-anchor-width] p-0">
              <Command :ignore-filter="true">
                <CommandInput
                  v-model="iconSearch"
                  :placeholder="$t('components.global.nelko_label.icon_search')"
                  :display-value="_ => ''"
                />
                <CommandEmpty>{{ $t("components.global.nelko_label.icon_empty") }}</CommandEmpty>
                <CommandList>
                  <CommandGroup>
                    <CommandItem
                      v-for="option in filteredIcons"
                      :key="option.slug"
                      :value="option.slug"
                      @select="selectIcon(option.slug)"
                    >
                      <Check :class="cn('mr-2 h-4 w-4', iconSlug === option.slug ? 'opacity-100' : 'opacity-0')" />
                      <div>
                        <div class="flex w-full">{{ option.label }}</div>
                        <div class="mt-1 text-xs text-muted-foreground">{{ option.group }}</div>
                      </div>
                    </CommandItem>
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        <div class="flex flex-col gap-1">
          <Label for="nelko-custom-slug" class="px-1">
            {{ $t("components.global.nelko_label.custom_icon") }}
          </Label>
          <div class="flex gap-2">
            <Input
              id="nelko-custom-slug"
              v-model="customSlug"
              placeholder="mdi:screw-machine-flat-top"
              @keydown.enter.prevent="applyCustomSlug"
            />
            <Button variant="outline" :disabled="!customSlug" @click="applyCustomSlug">
              {{ $t("components.global.nelko_label.apply") }}
            </Button>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <Checkbox id="nelko-save-default" v-model="saveAsDefault" :disabled="!entity" />
          <Label for="nelko-save-default">
            {{ $t("components.global.nelko_label.save_default") }}
          </Label>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="!svg" @click="downloadSvg">
          {{ $t("components.global.nelko_label.download_svg") }}
        </Button>
        <Button :disabled="!layout || loading || saving" @click="downloadPng">
          <MdiLoading v-if="saving" class="animate-spin" />
          {{ $t("components.global.nelko_label.download_png") }}
        </Button>
        <Button variant="ghost" @click="closeDialog(DialogID.NelkoLabel)">
          {{ $t("global.close") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
