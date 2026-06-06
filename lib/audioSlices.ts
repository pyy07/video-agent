// 整片 mp3 按旁白字数切分的时间轴 —— client-safe，与 audioGen 切分算法一致。

import { visualLength } from "@/lib/narration";
import type { OutlineScene } from "@/lib/outlineTypes";

export type SceneAudioSlice = {
  index: number;
  startSec: number;
  durationSec: number;
};

/** 整片 TTS 在镜间换行处会有自然停顿，切分权重需补偿等效字数 */
const SCENE_BOUNDARY_PAUSE_WEIGHT = 6;

/**
 * 按各镜旁白 visualLength 权重，把整段 mp3 时长切成连续时间片。
 * 服务端 ffmpeg 切分与前端预览/字幕同步共用此算法。
 */
export function computeSceneAudioSlices(
  scenes: Pick<OutlineScene, "index" | "narration">[],
  totalDurationSec: number,
): SceneAudioSlice[] {
  if (scenes.length === 0 || totalDurationSec <= 0) return [];

  const sorted = [...scenes].sort((a, b) => a.index - b.index);
  const weights = sorted.map((s, i) => {
    const textWeight = Math.max(1, visualLength(s.narration.trim()));
    const pauseWeight = i < sorted.length - 1 ? SCENE_BOUNDARY_PAUSE_WEIGHT : 0;
    return textWeight + pauseWeight;
  });
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  let cursor = 0;
  return sorted.map((scene, i) => {
    const isLast = i === sorted.length - 1;
    const durationSec = isLast
      ? Math.max(0.05, totalDurationSec - cursor)
      : (totalDurationSec * weights[i]) / totalWeight;
    const slice: SceneAudioSlice = {
      index: scene.index,
      startSec: cursor,
      durationSec,
    };
    cursor += durationSec;
    return slice;
  });
}

/** 由切片列表生成 index -> duration / start 映射 */
export function sceneAudioMapsFromSlices(slices: SceneAudioSlice[]): {
  durations: Record<number, number>;
  starts: Record<number, number>;
  totalSec: number;
} {
  const durations: Record<number, number> = {};
  const starts: Record<number, number> = {};
  let totalSec = 0;
  for (const slice of slices) {
    durations[slice.index] = slice.durationSec;
    starts[slice.index] = slice.startSec;
    totalSec = slice.startSec + slice.durationSec;
  }
  return { durations, starts, totalSec };
}
