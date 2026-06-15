// 整片 mp3 按旁白字数切分的时间轴 —— client-safe，与 audioGen 切分算法一致。

import { visualLength } from "@/lib/narration";
import type { OutlineScene } from "@/lib/outlineTypes";

export type SceneAudioSlice = {
  index: number;
  startSec: number;
  durationSec: number;
};

/** 整片 TTS 在镜间换行处会有自然停顿，切分权重需补偿等效字数 */
export const SCENE_BOUNDARY_PAUSE_WEIGHT = 6;

/**
 * 按各镜旁白 visualLength 权重，把整段 mp3 时长切成连续时间片。
 * 服务端 ffmpeg 切分与前端预览/字幕同步共用此算法。
 */
export function computeSceneAudioSlices(
  scenes: Pick<OutlineScene, "index" | "narration" | "durationSec">[],
  totalDurationSec: number,
): SceneAudioSlice[] {
  if (scenes.length === 0 || totalDurationSec <= 0) return [];

  const sorted = [...scenes].sort((a, b) => a.index - b.index);
  const weights = sorted.map((s, i) => {
    const planned =
      typeof s.durationSec === "number" && s.durationSec > 0 ? s.durationSec : 0;
    const textWeight = planned > 0 ? planned : Math.max(1, visualLength(s.narration.trim()));
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

/**
 * 分镜时间片内实际旁白朗读所占时长（扣除镜尾为换镜预留的停顿权重）。
 * 字幕应用此值做分母，避免 sceneDuration 含停顿导致字幕落后于 TTS。
 */
export function speechDurationInSlice(
  narration: string,
  sliceDurationSec: number,
  isLastScene: boolean,
): number {
  if (sliceDurationSec <= 0) return sliceDurationSec;
  const textWeight = Math.max(1, visualLength(narration.trim()));
  if (isLastScene) return sliceDurationSec;
  const weighted = sliceDurationSec * (textWeight / (textWeight + SCENE_BOUNDARY_PAUSE_WEIGHT));
  return Math.max(0.05, weighted);
}

export type PlaybackClock = {
  sceneIndex: number;
  sceneElapsed: number;
};

export type ResolvePlaybackClockParams = {
  allScenes: Pick<OutlineScene, "index">[];
  sceneDurations: Record<number, number>;
  sceneStartSec: Record<number, number>;
  useFullAudio: boolean;
  audio: HTMLAudioElement | null;
  currentIndex: number;
  sceneElapsed: number;
};

/**
 * 根据整片 mp3 或分镜 mp3 时钟，解析当前应展示的镜序号与镜内已播时长。
 * 整片模式以 slice 起始时间为准，与 ffmpeg 切分边界一致。
 */
export function resolvePlaybackClock(params: ResolvePlaybackClockParams): PlaybackClock {
  const { allScenes, sceneDurations, sceneStartSec, useFullAudio, audio, currentIndex, sceneElapsed } =
    params;

  if (useFullAudio && audio) {
    const globalTime = audio.currentTime;
    for (let i = 0; i < allScenes.length; i++) {
      const sc = allScenes[i];
      const start = sceneStartSec[sc.index] ?? 0;
      const dur = sceneDurations[sc.index] ?? 0;
      const isLast = i === allScenes.length - 1;
      const nextStart = isLast
        ? start + dur
        : (sceneStartSec[allScenes[i + 1].index] ?? start + dur);
      if (globalTime < nextStart - 1e-4 || isLast) {
        return { sceneIndex: i, sceneElapsed: Math.max(0, globalTime - start) };
      }
    }
    const lastIdx = allScenes.length - 1;
    const lastSc = allScenes[lastIdx];
    const start = sceneStartSec[lastSc.index] ?? 0;
    return { sceneIndex: lastIdx, sceneElapsed: Math.max(0, globalTime - start) };
  }

  const sc = allScenes[currentIndex];
  if (audio && sc) {
    return { sceneIndex: currentIndex, sceneElapsed: audio.currentTime };
  }
  return { sceneIndex: currentIndex, sceneElapsed };
}

/** 整片 mp3 模式下，镜内字幕应使用的有效朗读时长（扣除镜尾停顿权重） */
export function subtitleSpeechDurationSec(
  narration: string,
  sliceDurationSec: number,
  isLastScene: boolean,
  useFullAudio: boolean,
): number {
  if (!useFullAudio) return sliceDurationSec;
  return speechDurationInSlice(narration, sliceDurationSec, isLastScene);
}
