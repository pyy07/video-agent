"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OutlineScene } from "@/lib/outlineTypes";
import { projectAudioUrl } from "@/lib/audioUrl";

export interface UseVideoPlayerOptions {
  scenes: OutlineScene[];
  projectId: string | null;
  audioGeneratedAt?: string;
  initialIndex: number;
  onSceneIndexChange?: (index: number) => void;
}

export interface UseVideoPlayerResult {
  isPlaying: boolean;
  currentTime: number;
  currentIndex: number;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  togglePlay: () => void;
  play: () => void;
  stop: () => void;
  pause: () => void;
  playFromIndex: (index: number) => void;
  currentAudioSrc: string | null;
}

const DEFAULT_SCENE_DURATION = 3;

/**
 * 全屏连续播放 Hook（对齐 ai-video-agent usePlayer）。
 * - audio 元素稳定挂载，通过 src 切换分镜
 * - 不监听 play/pause 事件，避免 src 变化误判
 * - ended 自动推进下一镜
 */
export function useVideoPlayer({
  scenes,
  projectId,
  audioGeneratedAt,
  initialIndex,
  onSceneIndexChange,
}: UseVideoPlayerOptions): UseVideoPlayerResult {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(Math.max(0, initialIndex));
  const [currentTime, setCurrentTime] = useState(0);
  const initRef = useRef(false);

  const currentAudioSrc =
    projectId && scenes[currentIndex]?.audioPath
      ? projectAudioUrl(projectId, scenes[currentIndex].index, audioGeneratedAt)
      : null;

  useEffect(() => {
    if (initRef.current === false) {
      initRef.current = true;
      return;
    }
    if (!isPlaying) {
      const next = Math.max(0, initialIndex);
      if (next !== currentIndex) {
        setCurrentIndex(next);
        setCurrentTime(0);
        const a = audioRef.current;
        if (a) {
          a.pause();
          a.currentTime = 0;
        }
      }
    }
  }, [initialIndex, isPlaying, currentIndex]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);

    const onEnded = () => {
      setCurrentIndex((prev) => {
        if (prev + 1 < scenes.length) {
          const nextIdx = prev + 1;
          onSceneIndexChange?.(nextIdx);
          return nextIdx;
        }
        setIsPlaying(false);
        return prev;
      });
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("ended", onEnded);
    };
  }, [scenes.length, onSceneIndexChange]);

  useEffect(() => {
    if (!isPlaying) return;
    const audio = audioRef.current;
    if (!audio) return;

    let cancelled = false;
    let onCanPlay: (() => void) | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;

    const playNow = () => {
      if (cancelled) return;
      try {
        audio.currentTime = 0;
      } catch {
        /* readyState 不够时忽略 */
      }
      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          if (cancelled) return;
          console.warn("[player] play() rejected:", err?.message || err);
          fallbackTimer = setTimeout(() => {
            if (cancelled || !isPlaying) return;
            audio.play().catch(() => {
              if (!cancelled) setIsPlaying(false);
            });
          }, 800);
        });
      }
    };

    if (audio.readyState >= 3) {
      playNow();
    } else {
      onCanPlay = () => {
        if (cancelled) return;
        if (onCanPlay) audio.removeEventListener("canplay", onCanPlay);
        onCanPlay = null;
        playNow();
      };
      audio.addEventListener("canplay", onCanPlay);
    }

    return () => {
      cancelled = true;
      if (onCanPlay) {
        audio.removeEventListener("canplay", onCanPlay);
      }
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }
    };
  }, [currentIndex, isPlaying, currentAudioSrc]);

  const play = useCallback(() => {
    if (scenes.length === 0) return;
    if (isPlaying) return;
    if (currentIndex >= scenes.length) {
      setCurrentIndex(0);
    }
    setIsPlaying(true);
    onSceneIndexChange?.(Math.max(0, currentIndex));
  }, [scenes.length, isPlaying, currentIndex, onSceneIndexChange]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    audioRef.current?.pause();
  }, []);

  const stop = useCallback(() => {
    setIsPlaying(false);
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    const next = Math.max(0, initialIndex);
    setCurrentIndex(next);
    setCurrentTime(0);
    onSceneIndexChange?.(next);
  }, [initialIndex, onSceneIndexChange]);

  const playFromIndex = useCallback(
    (index: number) => {
      if (scenes.length === 0) return;
      const nextIndex = Math.max(0, Math.min(index, scenes.length - 1));
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.currentTime = 0;
      }
      setCurrentIndex(nextIndex);
      setCurrentTime(0);
      onSceneIndexChange?.(nextIndex);
      setIsPlaying(true);
    },
    [scenes.length, onSceneIndexChange],
  );

  return {
    isPlaying,
    currentTime,
    currentIndex,
    audioRef,
    togglePlay: () => (isPlaying ? pause() : play()),
    play,
    stop,
    pause,
    playFromIndex,
    currentAudioSrc,
  };
}

/** 从分镜 mp3 元数据加载各镜时长 */
export async function loadSceneDurations(
  scenes: OutlineScene[],
  projectId: string | null,
  audioGeneratedAt?: string,
): Promise<{ durations: Record<number, number>; totalSec: number }> {
  const durations: Record<number, number> = {};
  if (!projectId || scenes.length === 0) {
    return { durations, totalSec: 0 };
  }

  await Promise.all(
    scenes.map(async (sc) => {
      if (!sc.audioPath) {
        durations[sc.index] = DEFAULT_SCENE_DURATION;
        return;
      }
      const dur = await new Promise<number>((resolve) => {
        const audio = new Audio(projectAudioUrl(projectId, sc.index, audioGeneratedAt));
        let settled = false;
        const settle = (val: number) => {
          if (!settled) {
            settled = true;
            resolve(val);
          }
        };
        audio.addEventListener("loadedmetadata", () =>
          settle(Math.max(audio.duration, DEFAULT_SCENE_DURATION)),
        );
        audio.addEventListener("error", () => settle(DEFAULT_SCENE_DURATION));
        setTimeout(() => settle(DEFAULT_SCENE_DURATION), 5000);
        audio.load();
      });
      durations[sc.index] = dur;
    }),
  );

  const totalSec = scenes.reduce(
    (sum, sc) => sum + (durations[sc.index] ?? DEFAULT_SCENE_DURATION),
    0,
  );
  return { durations, totalSec };
}

export function formatPlayerDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
