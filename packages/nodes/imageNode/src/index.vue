<template>
  <nodeSkeleton
    v-bind="nodeProps"
    :topVisible="node.selected"
    topWidth="max-content"
    :downloadUrl="previewUrl"
    :downloadName="outputFile?.url.split(/[\\/]/).at(-1)"
    @fullscreen="previewVisible = true"
    :style="{ width: previewUrl && imageWidth ? `${imageWidth + 18}px` : undefined }">
    <template #topActions>
      <el-button
        :icon="IconTransfer"
        :loading="uploading"
        text
        title="替换图片"
        aria-label="替换图片"
        @click.stop="fileInput?.click()" />
    </template>
    <div class="imageContent nopan">
      <img
        v-if="previewUrl"
        class="imagePreview"
        :src="previewUrl"
        draggable="false"
        alt="节点图片"
        @load="resizeImage"
        @error="ElMessage.error('无法预览该图片')" />
      <input ref="fileInput" class="fileInput" type="file" accept="image/*" aria-label="选择图片" :disabled="uploading" @change="uploadImage" />
      <el-button
        v-if="!outputFile"
        class="uploadButton"
        text
        :loading="uploading"
        title="上传图片"
        aria-label="上传图片"
        @dblclick.stop
        @click="fileInput?.click()">
        <icon-upload v-if="!uploading" :size="48" stroke="1.5" />
      </el-button>
    </div>
  </nodeSkeleton>
  <el-image-viewer
    v-if="previewVisible && previewUrl"
    :urlList="[previewUrl]"
    teleported
    @close="previewVisible = false" />
</template>

<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { IconPhoto, IconUpload, IconTransfer } from "@tabler/icons-vue";
import { ElButton, ElImageViewer, ElMessage } from "element-plus";
import { nodeSkeleton, useNode } from "@toonflow/nodes-scaffold/runtime";

defineOptions({
  inheritAttrs: false,
  icon: IconPhoto,
});
const { node, nodeProps, outputs, execution, files, updateNodeInternals } = useNode({
  label: "图片",
});
const fileInput = ref<HTMLInputElement>();
const uploading = ref(false);
const previewVisible = ref(false);
const imageWidth = ref(0);

const outputFile = computed(() => outputs.value.image?.dataType === "IMAGE" ? outputs.value.image.value : undefined);
const previewUrl = files.useFileUrl(
  outputFile,
  (error) => showError(error, "图片读取失败")
);

async function resizeImage(event: Event) {
  const image = event.currentTarget as HTMLImageElement;
  if (!image.naturalWidth || !image.naturalHeight) return;
  imageWidth.value = 240 * image.naturalWidth / image.naturalHeight;
  await nextTick();
  updateNodeInternals();
}

async function uploadImage(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || uploading.value) return;
  if (!file.type.startsWith("image/")) return void ElMessage.error("请选择图片文件");
  if (!file.size || file.size > 100 * 1024 * 1024) return void ElMessage.error("图片不能为空且不能超过 100 MB");
  const stagedPath = `assets/uploads/${crypto.randomUUID()}`;
  uploading.value = true;
  try {
    const workspaceFiles = files.getWorkspaceFiles();
    for (const path of ["assets", "assets/uploads"]) {
      await workspaceFiles.mkdir(path).catch((error: { response?: { data?: { data?: { code?: string } } } }) => {
        if (error.response?.data?.data?.code !== "EEXIST") throw error;
      });
    }
    await workspaceFiles.write(stagedPath, file, true);
    await execution.call("uploadImage", { stagedPath, name: file.name, mimeType: file.type });
  } catch (error) {
    showError(error, "图片替换失败");
  } finally {
    uploading.value = false;
  }
}

function showError(error: unknown, fallback: string) {
  const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
  ElMessage.error(message || (error instanceof Error ? error.message : fallback));
}
</script>

<style scoped lang="scss">
.imageContent {
  min-height: 144px;

  .imagePreview {
    display: block;
    width: 100%;
    max-height: 240px;
    object-fit: contain;
    border-radius: var(--el-border-radius-base);
  }

  .fileInput {
    display: none;
  }

  .uploadButton {
    width: 100%;
    height: 144px;
    padding: 0;
    color: var(--el-text-color-placeholder);

    &:hover {
      color: var(--el-color-primary);
    }
  }
}
</style>
