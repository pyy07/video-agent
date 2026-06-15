/** 视频画幅预设（client-safe，生成与导出共用） */

export interface VideoSize {
  width: number;
  height: number;
  /** 展示用标签，如「1920×1080 横屏」 */
  label: string;
}

export const VIDEO_SIZE_PRESETS: VideoSize[] = [
  { width: 1920, height: 1080, label: "1920×1080 横屏（电脑）" },
  { width: 1280, height: 720, label: "1280×720 横屏" },
  { width: 1080, height: 1920, label: "1080×1920 竖屏（手机）" },
  { width: 720, height: 1280, label: "720×1280 竖屏" },
];

export const DEFAULT_VIDEO_SIZE = VIDEO_SIZE_PRESETS[0];

/** @deprecated 使用 VideoSize */
export type ExportVideoSize = VideoSize;
/** @deprecated 使用 VIDEO_SIZE_PRESETS */
export const EXPORT_VIDEO_PRESETS = VIDEO_SIZE_PRESETS;
/** @deprecated 使用 DEFAULT_VIDEO_SIZE */
export const DEFAULT_EXPORT_VIDEO_SIZE = DEFAULT_VIDEO_SIZE;

export function isPortraitVideoSize(size: VideoSize): boolean {
  return size.height > size.width;
}

/** @deprecated 使用 isPortraitVideoSize */
export const isPortraitExportSize = isPortraitVideoSize;

export function videoSizeAspectRatio(size: VideoSize): number {
  return size.width / size.height;
}

/** @deprecated 使用 videoSizeAspectRatio */
export const exportSizeAspectRatio = videoSizeAspectRatio;

/** 逻辑画布尺寸（HTML viewBox / 布局基准） */
export function logicalCanvasSize(size: VideoSize): { width: number; height: number } {
  if (isPortraitVideoSize(size)) {
    return { width: 720, height: 1280 };
  }
  return { width: 1280, height: 720 };
}

/** UI/动画画面运动伪影多，码率需高于普通视频 */
export function bitrateForVideoSize(width: number, height: number): number {
  const pixels = width * height;
  if (pixels >= 1920 * 1080) return 35_000_000;
  if (pixels >= 1280 * 720) return 22_000_000;
  return 14_000_000;
}

/** @deprecated 使用 bitrateForVideoSize */
export const bitrateForExportSize = bitrateForVideoSize;

export function imageSizeString(size: VideoSize): string {
  return `${size.width}x${size.height}`;
}

/** 给大纲 / HTML 生成器的画幅说明 */
export function videoSizeSpecForLlm(size: VideoSize): string {
  const logical = logicalCanvasSize(size);
  const ratio = isPortraitVideoSize(size) ? "9:16 竖屏" : "16:9 横屏";
  if (isPortraitVideoSize(size)) {
    return (
      `目标画幅：${ratio}，输出分辨率 ${size.width}×${size.height}，` +
      `逻辑画布 ${logical.width}×${logical.height}。` +
      `布局必须纵向堆叠（自上而下），避免横向并排多栏；字号偏大；` +
      `SVG 必须设置 viewBox="0 0 ${logical.width} ${logical.height}"；` +
      `根容器 aspect-ratio: ${logical.width}/${logical.height}。`
    );
  }
  return (
    `目标画幅：${ratio}，输出分辨率 ${size.width}×${size.height}，` +
    `逻辑画布 ${logical.width}×${logical.height}。` +
    `可使用横向分栏与宽屏构图；` +
    `SVG 必须设置 viewBox="0 0 ${logical.width} ${logical.height}"；` +
    `根容器 aspect-ratio: ${logical.width}/${logical.height}。`
  );
}

export function enrichPromptAspectRatio(prompt: string, size: VideoSize): string {
  const p = prompt.trim();
  if (/16:9|9:16|aspect ratio|竖屏|横屏/i.test(p)) return p;
  if (isPortraitVideoSize(size)) {
    return `${p}, vertical 9:16 portrait aspect ratio, mobile full screen frame`;
  }
  return `${p}, widescreen 16:9 aspect ratio, cinematic still frame`;
}

export function normalizeVideoSize(value: unknown): VideoSize | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const width = o.width;
  const height = o.height;
  const label = o.label;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1
  ) {
    return null;
  }
  const preset = VIDEO_SIZE_PRESETS.find((p) => p.width === width && p.height === height);
  return {
    width: Math.round(width),
    height: Math.round(height),
    label:
      typeof label === "string" && label.length > 0
        ? label
        : preset?.label ?? `${width}×${height}`,
  };
}

export function resolveVideoSize(
  outline?: { videoSize?: VideoSize } | null,
  meta?: { videoSize?: VideoSize } | null,
): VideoSize {
  return (
    normalizeVideoSize(outline?.videoSize) ??
    normalizeVideoSize(meta?.videoSize) ??
    DEFAULT_VIDEO_SIZE
  );
}

export function hasGeneratedSceneAssets(
  outline?: { scenes?: Array<{ htmlPath?: string; imagePath?: string }> } | null,
): boolean {
  if (!outline?.scenes) return false;
  return outline.scenes.some((s) => Boolean(s.htmlPath || s.imagePath));
}
