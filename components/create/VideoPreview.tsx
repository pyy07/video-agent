"use client";

import { Film, Play, Sparkles, Square, Volume2, X } from "lucide-react";
import Image from "next/image";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { pickSceneCover } from "./sceneCover";
import { splitNarration, subtitleClauseIndexAt, estimateSceneDurationSec } from "@/lib/narration";
import { projectAudioUrl, projectFullAudioUrl } from "@/lib/audioUrl";
import {
  computeSceneAudioSlices,
  resolvePlaybackClock,
  sceneAudioMapsFromSlices,
  subtitleSpeechDurationSec,
} from "@/lib/audioSlices";
import type { OutlineScene } from "@/lib/outlineTypes";
import type { ProjectType } from "@/lib/projectTypes";
import {
  DEFAULT_VIDEO_SIZE,
  isPortraitVideoSize,
  logicalCanvasSize,
  type VideoSize,
} from "@/lib/exportVideo";
import clsx from "clsx";

type VideoPreviewProps = {
  scene: OutlineScene | null;
  showSubtitle: boolean;
  projectId: string | null;
  allScenes: OutlineScene[];
  /** 最近一次整片音频生成时间，用于 cache bust */
  audioGeneratedAt?: string;
  /** 项目模式：image 模式用图片，html 模式用 iframe 嵌入动画 */
  projectType: ProjectType;
  /**
   * 录屏模式：进入后会自动从头开始播放、隐藏播放按钮、显示"录制中"角标。
   * 全部镜播完会触发 onRecordingComplete，由父级停止 recorder 并下载。
   */
  recordingMode?: boolean;
  /** 父级 recorder 就绪后再自动播放，避免 recorder 还没连上 canvas 就开录 */
  recordingCaptureReady?: boolean;
  /** 录屏预览开始播放时触发，用于音画时间轴对齐 */
  onRecordingPlaybackStart?: () => void;
  /** canvas 每画完一帧时通知 recorder 抓帧 */
  onRecordingFrameDrawn?: () => void;
  onRecordingComplete?: () => void;
  /** 录屏中：用户点"取消录制"按钮。父级会调 recorder.cancel() */
  onRecordingCancel?: () => void;
  /**
   * 当前正在播放的 <audio> 元素变化时触发。父级拿到这个 hook 后
   * 调 recorder.setAudioElement 让录屏音轨跟着切。
   */
  onAudioElementChange?: (audio: HTMLAudioElement | null) => void;
  /**
   * 录屏全屏覆盖层用：让预览区撑满父容器（默认预览是固定 420px 高）。
   * 设为 true 时：
   *  - 外层 div 用 h-full flex-col
   *  - 预览区用 flex-1 占据剩余高度
   *  - 控件栏保持原本大小
   */
  fillContainer?: boolean;
  /** 项目画幅（创建/生成时设定，预览与导出一致） */
  videoSize?: VideoSize;
};

/** 父级通过 ref 拿到录制区域 / canvas / 当前 audio */
export type VideoPreviewHandle = {
  /** 图片轮播：隐藏 canvas */
  getRecordingCanvas: () => HTMLCanvasElement | null;
  /** HTML 视频：浏览器原生采集的预览区域 */
  getCaptureRegion: () => HTMLElement | null;
  getCurrentAudioEl: () => HTMLAudioElement | null;
};

const DEFAULT_SCENE_DURATION = 3;
const FADE_DURATION_MS = 450; // 分镜交叉叠化时长
const RECORDING_W = 1920;
const RECORDING_H = 1080;
const RECORDING_FPS = 30;
const RECORDING_FRAME_MS = 1000 / RECORDING_FPS;
/** HTML 分镜 iframe 分批预载间隔（毫秒） */
const HTML_IFRAME_PRELOAD_STAGGER_MS = 200;

/** embed 注入逻辑变更时递增，避免浏览器 304 复用旧 HTML */
const SCENE_EMBED_REV = 8;

function sceneHtmlUrl(
  projectId: string,
  sceneIndex: number,
  videoSize: VideoSize,
  durationSec?: number,
  run = false,
): string {
  const logical = logicalCanvasSize(videoSize);
  const ds =
    typeof durationSec === "number" && durationSec > 0
      ? `&ds=${Math.round(durationSec)}`
      : "";
  const runQ = run ? "&run=1" : "";
  return `/api/project-scenes/${projectId}/${sceneIndex}.html?embed=1&lw=${logical.width}&lh=${logical.height}&ev=${SCENE_EMBED_REV}${ds}${runQ}`;
}

function sceneDurationSec(scene: OutlineScene | undefined): number | undefined {
  if (!scene) return undefined;
  if (typeof scene.durationSec === "number" && scene.durationSec > 0) {
    return scene.durationSec;
  }
  if (scene.narration?.trim()) {
    return estimateSceneDurationSec(scene.narration);
  }
  return undefined;
}

function effectiveSceneDurationSec(
  scene: OutlineScene | undefined,
  sceneDurations: Record<number, number>,
): number | undefined {
  if (!scene) return undefined;
  const fromAudio = sceneDurations[scene.index];
  if (typeof fromAudio === "number" && fromAudio > 0) {
    return fromAudio;
  }
  return sceneDurationSec(scene);
}

/** 叠加字幕（字号随画幅容器缩放，带描边） */
function SubtitleOverlay({ text, clauseKey }: { text: string; clauseKey: number }) {
  return (
    <div className="absolute inset-x-0 bottom-[3cqh] z-10 flex justify-center px-[3cqw] pointer-events-none">
      <span
        key={clauseKey}
        className="max-w-[90%] px-[1.5cqw] py-[0.6cqh] text-center font-bold leading-snug text-white"
        style={{
          fontSize: "6cqh",
          WebkitTextStroke: "0.55cqh rgba(0,0,0,0.95)",
          paintOrder: "stroke fill",
          letterSpacing: "0.02em",
        }}
      >
        {text}
      </span>
    </div>
  );
}

export const VideoPreview = forwardRef<VideoPreviewHandle, VideoPreviewProps>(
  function VideoPreview(
    {
      scene,
      showSubtitle,
      projectId,
      allScenes,
      audioGeneratedAt,
      projectType,
      recordingMode = false,
      recordingCaptureReady = true,
      onRecordingPlaybackStart,
      onRecordingFrameDrawn,
      onRecordingComplete,
      onRecordingCancel,
      onAudioElementChange,
      fillContainer = false,
      videoSize,
    },
    ref,
  ) {
    const isHtmlMode = projectType === "html";
    const resolvedVideoSize = videoSize ?? DEFAULT_VIDEO_SIZE;
    const exportWidth = resolvedVideoSize.width;
    const exportHeight = resolvedVideoSize.height;
    const exportPortrait = isPortraitVideoSize(resolvedVideoSize);
    const exportAspectRatio = `${exportWidth} / ${exportHeight}`;
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [totalDuration, setTotalDuration] = useState(0);
    const [sceneDurations, setSceneDurations] = useState<Record<number, number>>({});
    /** 各镜时长/起始时间轴是否已从 mp3 元数据加载完成 */
    const [sceneTimelineReady, setSceneTimelineReady] = useState(false);
    /** 当前镜透明度：交叉叠化时 0→1 */
    const [currentOpacity, setCurrentOpacity] = useState(1);
    /** 上一镜（outgoing layer），叠化时 1→0 */
    const [prevScene, setPrevScene] = useState<OutlineScene | null>(null);
    const [prevOpacity, setPrevOpacity] = useState(1);

    // 播放进度的 interval id
    const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 计数器 + 记录启动时的分镜序号，双重保证防止 stale 回调
    const progressCountRef = useRef(0);
    const startedIndexRef = useRef(0);

    // 播放锁：防止 togglePlay 和 useEffect 重复启动
    const isRunningRef = useRef(false);

    // 当前分镜累计播放时长（用 ref 跟踪，避免依赖 setState updater 里的 prev）
    const sceneElapsedRef = useRef(0);

    // 当前分镜的"到点"哨兵：StrictMode 下 React 会重复调用 setState updater，
    // 必须把推进副作用挪出 updater，并用此 ref 防止同帧/重放二次触发 advanceToNext
    const doneFiredRef = useRef(false);

    // 叠化清理定时器：在 FADE_DURATION_MS 后把 prevScene 清空
    const fadeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // 当前正在播放的 <audio> 元素。给 recorder 抓 captureStream 用。
    const audioRef = useRef<HTMLAudioElement | null>(null);
    // 整片 mp3 URL 绑定标记（audioGeneratedAt 变化时需重建）
    const boundFullAudioUrlRef = useRef<string | null>(null);
    /** 是否存在 full.mp3；旧项目只有分镜 mp3 时为 false */
    const useFullAudioRef = useRef(false);
    // 各镜在整片 mp3 中的起始秒数
    const sceneStartSecRef = useRef<Record<number, number>>({});
    const currentIndexRef = useRef(currentIndex);
    useEffect(() => {
      currentIndexRef.current = currentIndex;
    }, [currentIndex]);
    // 包装赋值：每次换 audio 都通知父级（recorder 要 setAudioElement 跟）
    const setAudio = useCallback(
      (audio: HTMLAudioElement | null) => {
        audioRef.current = audio;
        onAudioElementChange?.(audio);
      },
      [onAudioElementChange],
    );

    // === 录制 canvas 渲染相关 ===
    const recordingCanvasRef = useRef<HTMLCanvasElement | null>(null);
    // 渲染循环读这些 ref，避免 effect 频繁 re-bind
    const renderStateRef = useRef({
      currentScene: null as OutlineScene | null,
      prevScene: null as OutlineScene | null,
      currentOpacity: 1,
      prevOpacity: 1,
      showSubtitle: false,
      subtitleText: "",
      isHtmlMode: false,
    });
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const sceneDurationsRef = useRef(sceneDurations);
    useEffect(() => {
      sceneDurationsRef.current = sceneDurations;
    }, [sceneDurations]);
    /** 录制叠化：按 wall-clock 插值，不依赖 React 低频更新 */
    const fadeStartedAtRef = useRef<number | null>(null);
    const fadeOutgoingSceneRef = useRef<OutlineScene | null>(null);
    /** 导出帧绘制：上次已稳定展示的镜序号，用于检测切镜并启动叠化 */
    const recordingLastSceneIndexRef = useRef(-1);
    /** 整片 mp3 模式下，由音频时钟同步到的镜序号 */
    const audioSyncedSceneIndexRef = useRef(-1);
    /** 驱动字幕随 audio.timeupdate 刷新 */
    const [subtitlePulse, setSubtitlePulse] = useState(0);
    const lastProgressTimeRef = useRef(0);
    /** HTML 模式：导出时从此 DOM 区域裁切画面 */
    const captureRegionRef = useRef<HTMLDivElement | null>(null);
    /** 录制时把 1920×1080 预览区缩小以适应窗口，保证整页可见 */
    const [recordFitScale, setRecordFitScale] = useState(1);

    useLayoutEffect(() => {
      if (!recordingMode || !isHtmlMode || !fillContainer) {
        setRecordFitScale(1);
        return;
      }
      const footerH = 44;
      const update = () => {
        const mw = window.innerWidth;
        const mh = Math.max(200, window.innerHeight - footerH);
        setRecordFitScale(
          Math.min(1, mw / exportWidth, mh / exportHeight),
        );
      };
      update();
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }, [recordingMode, isHtmlMode, fillContainer, exportWidth, exportHeight]);

    useImperativeHandle(ref, () => ({
      getRecordingCanvas: () => recordingCanvasRef.current,
      getCaptureRegion: () => captureRegionRef.current,
      getCurrentAudioEl: () => audioRef.current,
    }), []);

    const currentScene = allScenes[currentIndex] ?? scene;

    // 读取整片 mp3 时长，并按与服务端一致的算法切分各镜时间轴
    const loadFullAudioDuration = useCallback((): Promise<number | null> => {
      if (!projectId || !allScenes.some((s) => s.audioPath)) {
        return Promise.resolve(null);
      }
      return new Promise((resolve) => {
        const audio = new Audio(projectFullAudioUrl(projectId, audioGeneratedAt));
        let settled = false;
        const settle = (val: number | null) => {
          if (!settled) {
            settled = true;
            resolve(val);
          }
        };
        audio.addEventListener("loadedmetadata", () => {
          const dur = audio.duration;
          settle(Number.isFinite(dur) && dur > 0 ? dur : null);
        });
        audio.addEventListener("error", () => settle(null));
        setTimeout(() => settle(null), 8000);
        audio.load();
      });
    }, [projectId, allScenes, audioGeneratedAt]);

    const loadPerSceneDurations = useCallback(async (): Promise<{
      durations: Record<number, number>;
      starts: Record<number, number>;
      totalSec: number;
    }> => {
      const durations: Record<number, number> = {};
      let cursor = 0;
      await Promise.all(
        allScenes.map(async (sc) => {
          if (!projectId || !sc.audioPath) {
            durations[sc.index] = DEFAULT_SCENE_DURATION;
            return;
          }
          const dur = await new Promise<number>((resolve) => {
            const audio = new Audio(
              projectAudioUrl(projectId, sc.index, audioGeneratedAt),
            );
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
      const starts: Record<number, number> = {};
      for (const sc of allScenes) {
        starts[sc.index] = cursor;
        cursor += durations[sc.index] ?? DEFAULT_SCENE_DURATION;
      }
      return { durations, starts, totalSec: cursor };
    }, [projectId, allScenes, audioGeneratedAt]);

    useEffect(() => {
      if (allScenes.length === 0) {
        setSceneTimelineReady(false);
        return;
      }
      let cancelled = false;
      setSceneTimelineReady(false);

      (async () => {
        const fullDur = await loadFullAudioDuration();
        if (cancelled) return;

        if (fullDur && fullDur > 0) {
          useFullAudioRef.current = true;
          // 与 ffmpeg 切分一致：整片 mp3 用 slice 算法，不用分镜 mp3 浏览器时长累加（易偏早切镜）
          const slices = computeSceneAudioSlices(allScenes, fullDur);
          const { durations, starts, totalSec } = sceneAudioMapsFromSlices(slices);
          setSceneDurations(durations);
          sceneStartSecRef.current = starts;
          setTotalDuration(totalSec > 0 ? totalSec : fullDur);
          setSceneTimelineReady(true);
          return;
        }

        useFullAudioRef.current = false;
        const fallback = await loadPerSceneDurations();
        if (cancelled) return;
        setSceneDurations(fallback.durations);
        sceneStartSecRef.current = fallback.starts;
        setTotalDuration(
          fallback.totalSec > 0
            ? fallback.totalSec
            : allScenes.length * DEFAULT_SCENE_DURATION,
        );
        setSceneTimelineReady(true);
      })();

      return () => {
        cancelled = true;
      };
    }, [allScenes, loadFullAudioDuration, loadPerSceneDurations, audioGeneratedAt]);

    // 清理所有定时器
    const clearAll = useCallback(() => {
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
    }, []);

    // 立即结束叠化、清空 outgoing 图层（用于 stop / seek / 触达最后一镜）
    const clearPrevLayer = useCallback(() => {
      if (fadeoutTimerRef.current) { clearTimeout(fadeoutTimerRef.current); fadeoutTimerRef.current = null; }
      fadeStartedAtRef.current = null;
      fadeOutgoingSceneRef.current = null;
      setPrevScene(null);
      setPrevOpacity(1);
      setCurrentOpacity(1);
    }, []);

    const handleFullAudioEnded = useCallback(() => {
      if (recordingMode) {
        onRecordingComplete?.();
      }
      isRunningRef.current = false;
      setIsPlaying(false);
      if (!recordingMode) {
        setCurrentIndex(0);
        setCurrentTime(0);
      }
      clearPrevLayer();
    }, [clearPrevLayer, recordingMode, onRecordingComplete]);

    // 播放整片 mp3 并从指定时间点开始（分镜切换时不重启，保证语调连贯）
    const playFullAudioFrom = useCallback((sec: number) => {
      if (!projectId || !allScenes.some((s) => s.audioPath)) {
        setAudio(null);
        return;
      }

      const url = projectFullAudioUrl(projectId, audioGeneratedAt);
      let audio = audioRef.current;

      if (!audio || boundFullAudioUrlRef.current !== url) {
        if (audio) {
          audio.pause();
          audio.removeEventListener("ended", handleFullAudioEnded);
        }
        audio = new Audio(url);
        boundFullAudioUrlRef.current = url;
        audio.addEventListener("ended", handleFullAudioEnded);
      }

      const seekAndPlay = () => {
        audio!.currentTime = Math.max(0, sec);
        audioRef.current = audio!;
        setAudio(audio!);
        audio!.addEventListener(
          "playing",
          () => onAudioElementChange?.(audio!),
          { once: true },
        );
        audio!.addEventListener(
          "error",
          () => onAudioElementChange?.(null),
          { once: true },
        );
        void audio!.play();
      };

      if (audio.readyState >= 1) {
        seekAndPlay();
      } else {
        audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        audio.load();
      }
    }, [
      projectId,
      allScenes,
      audioGeneratedAt,
      setAudio,
      onAudioElementChange,
      handleFullAudioEnded,
    ]);

    // 分镜 mp3 播放（旧项目无 full.mp3 时使用）
    const playSceneAudio = useCallback((sc: OutlineScene, offsetSec = 0) => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.removeEventListener("ended", handleFullAudioEnded);
        audioRef.current = null;
        boundFullAudioUrlRef.current = null;
      }
      if (!projectId || !sc.audioPath) {
        setAudio(null);
        return;
      }

      const url = projectAudioUrl(projectId, sc.index, audioGeneratedAt);
      const audio = new Audio(url);

      const seekAndPlay = () => {
        audio.currentTime = Math.max(0, offsetSec);
        audioRef.current = audio;
        setAudio(audio);
        audio.addEventListener(
          "playing",
          () => onAudioElementChange?.(audio),
          { once: true },
        );
        audio.addEventListener(
          "error",
          () => onAudioElementChange?.(null),
          { once: true },
        );
        void audio.play();
      };

      if (audio.readyState >= 1) {
        seekAndPlay();
      } else {
        audio.addEventListener("loadedmetadata", seekAndPlay, { once: true });
        audio.load();
      }
    }, [projectId, audioGeneratedAt, setAudio, onAudioElementChange, handleFullAudioEnded]);

    // audioGeneratedAt / projectId 变化时丢弃旧 audio 元素
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.pause();
      audio.removeEventListener("ended", handleFullAudioEnded);
      audioRef.current = null;
      boundFullAudioUrlRef.current = null;
      setAudio(null);
    }, [audioGeneratedAt, projectId, handleFullAudioEnded, setAudio]);

    // 交叉叠化切到指定镜（整片 / 分镜 mp3 共用）
    const beginCrossfadeToScene = useCallback(
      (targetIndex: number, elapsedInScene: number) => {
        const fromIndex = currentIndexRef.current;
        if (targetIndex === fromIndex) {
          sceneElapsedRef.current = elapsedInScene;
          setCurrentTime(elapsedInScene);
          return;
        }

        const outgoing = allScenes[fromIndex];
        if (fadeoutTimerRef.current) clearTimeout(fadeoutTimerRef.current);

        fadeStartedAtRef.current = performance.now();
        fadeOutgoingSceneRef.current = outgoing ?? null;

        setPrevScene(outgoing ?? null);
        setPrevOpacity(1);
        setCurrentIndex(targetIndex);
        setCurrentOpacity(0);
        sceneElapsedRef.current = elapsedInScene;
        setCurrentTime(elapsedInScene);
        audioSyncedSceneIndexRef.current = targetIndex;

        fadeoutTimerRef.current = setTimeout(() => {
          setPrevScene(null);
          setPrevOpacity(1);
          setCurrentOpacity(1);
          fadeoutTimerRef.current = null;
        }, FADE_DURATION_MS);
      },
      [allScenes],
    );

    // 切到下一个分镜（叠化过渡，仅分镜 mp3 逐镜播放时使用）
    const advanceToNext = useCallback(() => {
      clearAll();
      // 整片 mp3 连续播放，切镜时不暂停/重启音频
      if (currentIndex >= allScenes.length - 1) {
        isRunningRef.current = false;
        setIsPlaying(false);
        if (recordingMode) {
          onRecordingComplete?.();
        } else {
          setCurrentIndex(0);
          setCurrentTime(0);
          sceneElapsedRef.current = 0;
          clearPrevLayer();
        }
        return;
      }

      const outgoing = allScenes[currentIndex];
      if (fadeoutTimerRef.current) clearTimeout(fadeoutTimerRef.current);

      fadeStartedAtRef.current = performance.now();
      fadeOutgoingSceneRef.current = outgoing ?? null;

      setPrevScene(outgoing ?? null);
      setPrevOpacity(1);

      const nextIndex = currentIndex + 1;
      setCurrentIndex(nextIndex);
      setCurrentTime(0);
      sceneElapsedRef.current = 0;
      setCurrentOpacity(0);
      audioSyncedSceneIndexRef.current = nextIndex;

      fadeoutTimerRef.current = setTimeout(() => {
        setPrevScene(null);
        setPrevOpacity(1);
        setCurrentOpacity(1);
        fadeoutTimerRef.current = null;
      }, FADE_DURATION_MS);
    }, [currentIndex, allScenes, clearAll, clearPrevLayer, recordingMode, onRecordingComplete]);

    // 整片 mp3：按音频时钟同步镜序号与叠化，不切音频
    const syncPlaybackFromAudioClock = useCallback(() => {
      if (!isRunningRef.current) return;
      const audio = audioRef.current;
      if (!audio || !useFullAudioRef.current) return;

      const clock = resolvePlaybackClock({
        allScenes,
        sceneDurations,
        sceneStartSec: sceneStartSecRef.current,
        useFullAudio: true,
        audio,
        currentIndex: currentIndexRef.current,
        sceneElapsed: sceneElapsedRef.current,
      });

      sceneElapsedRef.current = clock.sceneElapsed;
      const sceneChanged = clock.sceneIndex !== audioSyncedSceneIndexRef.current;
      if (
        sceneChanged ||
        Math.abs(clock.sceneElapsed - lastProgressTimeRef.current) >= 0.08
      ) {
        lastProgressTimeRef.current = clock.sceneElapsed;
        setCurrentTime(clock.sceneElapsed);
      }

      if (audioSyncedSceneIndexRef.current < 0) {
        audioSyncedSceneIndexRef.current = clock.sceneIndex;
        if (clock.sceneIndex !== currentIndexRef.current) {
          setCurrentIndex(clock.sceneIndex);
        }
        return;
      }

      if (sceneChanged) {
        beginCrossfadeToScene(clock.sceneIndex, clock.sceneElapsed);
      }
    }, [allScenes, sceneDurations, beginCrossfadeToScene]);

    // 播放中：audio.timeupdate 驱动字幕刷新；整片 mp3 同时同步切镜（不用 setInterval 重复跑）
    useEffect(() => {
      if (!isPlaying) return;
      const audio = audioRef.current;
      if (!audio) return;
      const onTimeUpdate = () => {
        if (useFullAudioRef.current) {
          syncPlaybackFromAudioClock();
        }
        setSubtitlePulse((n) => n + 1);
      };
      audio.addEventListener("timeupdate", onTimeUpdate);
      return () => audio.removeEventListener("timeupdate", onTimeUpdate);
    }, [isPlaying, syncPlaybackFromAudioClock, audioGeneratedAt]);

    // 开始播放进度：整片 mp3 用全局时钟；分镜 mp3 用当前镜 audio.currentTime 或定时器
    const startProgress = useCallback(() => {
      if (isRunningRef.current) {
        return;
      }
      isRunningRef.current = true;

      const countAtStart = ++progressCountRef.current;
      startedIndexRef.current = currentIndexRef.current;
      doneFiredRef.current = false;

      clearAll();

      // 整片 mp3：切镜与进度由 audio.timeupdate 驱动，避免与 setInterval 双重 setState 卡顿
      if (useFullAudioRef.current) {
        syncPlaybackFromAudioClock();
        return;
      }

      const tick = () => {
        if (
          !isRunningRef.current ||
          doneFiredRef.current ||
          countAtStart !== progressCountRef.current
        ) {
          return;
        }

        const idx = currentIndexRef.current;
        const sc = allScenes[idx];
        if (!sc) return;

        const dur = sceneDurations[sc.index] ?? DEFAULT_SCENE_DURATION;
        let elapsed: number;

        {
          const audio = audioRef.current;
          if (audio && sc.audioPath) {
            elapsed = audio.currentTime;
          } else {
            sceneElapsedRef.current = Math.min(sceneElapsedRef.current + 0.05, dur);
            elapsed = sceneElapsedRef.current;
          }
        }

        if (elapsed >= dur - 0.01) {
          setCurrentTime(dur);
          if (idx >= allScenes.length - 1) {
            doneFiredRef.current = true;
            isRunningRef.current = false;
            if (progressTimerRef.current) {
              clearInterval(progressTimerRef.current);
              progressTimerRef.current = null;
            }
            setIsPlaying(false);
            if (useFullAudioRef.current) {
              // 整片 mp3 由 ended 事件收尾
            } else if (recordingMode) {
              onRecordingComplete?.();
            }
            return;
          }
          doneFiredRef.current = true;
          isRunningRef.current = false;
          if (progressTimerRef.current) {
            clearInterval(progressTimerRef.current);
            progressTimerRef.current = null;
          }
          setTimeout(advanceToNext, 0);
          return;
        }

        sceneElapsedRef.current = Math.max(0, elapsed);
        setCurrentTime(sceneElapsedRef.current);
      };

      progressTimerRef.current = setInterval(tick, 50);
      tick();
    }, [allScenes, sceneDurations, clearAll, advanceToNext, recordingMode, onRecordingComplete, syncPlaybackFromAudioClock]);

    // 播放/暂停
    const togglePlay = useCallback(() => {
      if (isPlaying) {
        isRunningRef.current = false;
        clearAll();
        if (audioRef.current) audioRef.current.pause();
        setIsPlaying(false);
      } else {
        if (allScenes.length === 0) return;
        if (!sceneTimelineReady) return;
        audioSyncedSceneIndexRef.current = -1;
        setIsPlaying(true);
        const sc = allScenes[currentIndex];
        if (sc) {
          if (useFullAudioRef.current) {
            const startSec =
              (sceneStartSecRef.current[sc.index] ?? 0) + sceneElapsedRef.current;
            playFullAudioFrom(startSec);
          } else {
            playSceneAudio(sc, sceneElapsedRef.current);
          }
        }
        startProgress();
      }
    }, [isPlaying, currentIndex, allScenes, playFullAudioFrom, playSceneAudio, startProgress, clearAll, sceneTimelineReady]);

    // 分镜切换时重启进度；首次点播放由 togglePlay 负责，避免重复 clearAll
    const prevPlayingIndexRef = useRef(currentIndex);
    useEffect(() => {
      if (!isPlaying) {
        prevPlayingIndexRef.current = currentIndex;
        return;
      }
      if (prevPlayingIndexRef.current === currentIndex) return;
      prevPlayingIndexRef.current = currentIndex;

      // 整片 mp3：音频连续，切镜只换视觉层，不重启进度计时
      if (useFullAudioRef.current) return;

      isRunningRef.current = false;
      clearAll();
      if (!useFullAudioRef.current) {
        const sc = allScenes[currentIndex];
        if (sc) {
          playSceneAudio(sc, sceneElapsedRef.current);
        }
      }
      startProgress();
    }, [currentIndex, isPlaying, allScenes, clearAll, playSceneAudio, startProgress]);

    /**
     * 录屏模式：父级把 recordingMode 翻成 true 后，自动从头开始播放。
     * - 重置 currentIndex / currentTime / 叠化层
     * - 触发 isPlaying=true 让上面那个 effect 启动音频 + 进度
     * 注意：录屏模式启动时机由父级决定，父级应该先把"全屏"切好再调这个
     * effect，否则录到的画面不一定是视频全屏的样子。
     */
    useEffect(() => {
      if (!recordingMode || !recordingCaptureReady || !sceneTimelineReady) return;
      isRunningRef.current = false;
      clearAll();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setAudio(null);
      setCurrentIndex(0);
      setCurrentTime(0);
      clearPrevLayer();
      recordingLastSceneIndexRef.current = -1;
      audioSyncedSceneIndexRef.current = -1;
      fadeStartedAtRef.current = null;
      fadeOutgoingSceneRef.current = null;
      if (allScenes.length === 0) {
        // 边界：没有分镜直接结束
        onRecordingComplete?.();
        return;
      }
      onRecordingPlaybackStart?.();
      setIsPlaying(true);
      if (useFullAudioRef.current) {
        playFullAudioFrom(0);
      } else {
        playSceneAudio(allScenes[0], 0);
      }
      startProgress();
      // 录屏模式不依赖 deps 重新触发，只在翻 true 时启动一次
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recordingMode, recordingCaptureReady, sceneTimelineReady]);

    // 交叉叠化：prevScene 出现后下一帧同时启动旧镜淡出 + 新镜淡入
    useEffect(() => {
      if (!prevScene) return;
      const raf = requestAnimationFrame(() => {
        setPrevOpacity(0);
        setCurrentOpacity(1);
      });
      return () => cancelAnimationFrame(raf);
    }, [prevScene]);

    /**
     * 响应外部"切换分镜"（来自 StoryboardList 的点击）：
     *  - 暂停任何正在进行的播放 / 进度 / 音频
     *  - 把内部 currentIndex 同步到外部选中的 scene
     *  - 重置进度、叠化残留
     *  - 不触发 advanceToNext，避免和内部到点推进逻辑互相干扰
     *
     * 实现要点：用 ref 记录"上次外部传入的 index"，只在它真正变化时执行同步，
     * 这样不会因为父级 re-render 传了同 scene 引用就误触发。
     */
    const lastExternalIndexRef = useRef<number | null>(null);
    useEffect(() => {
      if (!scene) return;
      const targetIdx = allScenes.findIndex((s) => s.index === scene.index);
      if (targetIdx < 0) return;
      if (lastExternalIndexRef.current === targetIdx) return; // 没变，noop
      lastExternalIndexRef.current = targetIdx;

      // 暂停所有正在跑的 timer
      isRunningRef.current = false;
      clearAll();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setAudio(null);
      // 同步内部状态
      setIsPlaying(false);
      setCurrentIndex(targetIdx);
      setCurrentTime(0);
      sceneElapsedRef.current = 0;
      clearPrevLayer();
    }, [scene, allScenes, clearAll, clearPrevLayer]);

    // unmount 兜底
    useEffect(() => {
      return () => {
        if (fadeoutTimerRef.current) clearTimeout(fadeoutTimerRef.current);
      };
    }, []);

    // 停止
    const handleStop = useCallback(() => {
      isRunningRef.current = false;
      clearAll();
      if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
      setAudio(null);
      setIsPlaying(false);
      setCurrentIndex(0);
      setCurrentTime(0);
      audioSyncedSceneIndexRef.current = -1;
      clearPrevLayer();
    }, [clearAll, clearPrevLayer, setAudio]);

    // 进度条点击
    const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
      if (allScenes.length === 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetSec = totalDuration * ratio;
      let acc = 0;
      let targetIdx = 0;
      let sceneOffset = 0;
      for (let i = 0; i < allScenes.length; i++) {
        const dur = sceneDurations[allScenes[i].index] ?? DEFAULT_SCENE_DURATION;
        if (acc + dur >= targetSec || i === allScenes.length - 1) {
          targetIdx = i;
          sceneOffset = Math.max(0, targetSec - acc);
          break;
        }
        acc += dur;
      }
      isRunningRef.current = false;
      clearAll();
      if (audioRef.current) {
        audioRef.current.pause();
        if (useFullAudioRef.current) {
          audioRef.current.currentTime = targetSec;
        } else {
          audioRef.current = null;
        }
      }
      setIsPlaying(false);
      setCurrentIndex(targetIdx);
      setCurrentTime(sceneOffset);
      sceneElapsedRef.current = sceneOffset;
      audioSyncedSceneIndexRef.current = targetIdx;
      clearPrevLayer();
    }, [allScenes, sceneDurations, totalDuration, clearAll, clearPrevLayer, setAudio]);

    const formatTime = (s: number) => {
      if (!Number.isFinite(s) || s <= 0) return "00:00";
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    };

    const playedTotal = (() => {
      let sum = 0;
      for (let i = 0; i < currentIndex; i++) {
        sum += sceneDurations[allScenes[i]?.index] ?? DEFAULT_SCENE_DURATION;
      }
      return sum + currentTime;
    })();

    const progressRatio = totalDuration > 0 ? playedTotal / totalDuration : 0;

    // 字幕分句：按标点切短句，时钟略提前于音频并扣除镜间停顿权重（整片 mp3 模式）
    const currentClauses = useMemo(
      () => (currentScene ? splitNarration(currentScene.narration) : []),
      [currentScene],
    );
    const currentSceneDuration =
      sceneDurations[currentScene?.index ?? -1] ?? DEFAULT_SCENE_DURATION;

    // 字幕：用镜内有效朗读时长 + 略提前的时钟，与 TTS 对齐
    const subtitleElapsed = (() => {
      void subtitlePulse;
      if (!isPlaying && !recordingMode) return currentTime;
      const audio = audioRef.current;
      const sc = currentScene;
      if (!sc) return currentTime;
      if (useFullAudioRef.current && audio) {
        const start = sceneStartSecRef.current[sc.index] ?? 0;
        return Math.max(0, audio.currentTime - start);
      }
      if (audio && sc.audioPath) return audio.currentTime;
      return currentTime;
    })();
    const subtitleSpeechDuration = currentScene
      ? subtitleSpeechDurationSec(
          currentScene.narration,
          currentSceneDuration,
          currentIndex >= allScenes.length - 1,
          useFullAudioRef.current,
        )
      : currentSceneDuration;
    const activeClauseIdx = subtitleClauseIndexAt(
      currentClauses,
      subtitleElapsed,
      subtitleSpeechDuration,
    );
    const subtitleText = activeClauseIdx >= 0 ? currentClauses[activeClauseIdx].text : "";

    // 把当前播放状态写到 ref（非录制时 canvas 不读此值，仅作兜底）
    useEffect(() => {
      renderStateRef.current = {
        currentScene,
        prevScene,
        currentOpacity,
        prevOpacity,
        showSubtitle,
        subtitleText,
        isHtmlMode,
      };
    }, [
      currentScene,
      prevScene,
      currentOpacity,
      prevOpacity,
      showSubtitle,
      subtitleText,
      isHtmlMode,
    ]);

    // 录制开始前预加载并 decode 所有分镜图片，避免导出时边画边解码
    useEffect(() => {
      if (!recordingMode || isHtmlMode || !projectId) return;
      let cancelled = false;
      void (async () => {
        await Promise.all(
          allScenes.map(async (sc) => {
            if (!sc.imagePath) return;
            const url = `/api/project-images/${projectId}/${sc.index}.png`;
            let img = imageCacheRef.current.get(url);
            if (!img) {
              img = new globalThis.Image();
              img.src = url;
              imageCacheRef.current.set(url, img);
            }
            if (!img.complete || img.naturalWidth === 0) {
              await img.decode().catch(() => undefined);
            }
          }),
        );
        if (cancelled) return;
      })();
      return () => {
        cancelled = true;
      };
    }, [recordingMode, isHtmlMode, projectId, allScenes]);

    // 图片轮播导出：单 canvas 绘制 + 按音频时钟插值交叉叠化（30fps 连续）
    useEffect(() => {
      if (!recordingMode || isHtmlMode) return;
      const canvas = recordingCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let nextTickAt = performance.now();

      const tick = () => {
        if (stopped) return;

        syncRecordingRenderState(
          renderStateRef,
          {
            allScenes,
            sceneDurations: sceneDurationsRef.current,
            sceneStartSec: sceneStartSecRef.current,
            useFullAudio: useFullAudioRef.current,
            audio: audioRef.current,
            currentIndex: currentIndexRef.current,
            sceneElapsed: sceneElapsedRef.current,
            showSubtitle,
            fadeStartedAtRef,
            fadeOutgoingSceneRef,
            recordingLastSceneIndexRef,
          },
        );

        drawRecordingFrame(
          ctx,
          canvas.width,
          canvas.height,
          renderStateRef.current,
          imageCacheRef.current,
          projectId,
        );
        onRecordingFrameDrawn?.();

        nextTickAt += RECORDING_FRAME_MS;
        const delay = Math.max(0, nextTickAt - performance.now());
        timer = setTimeout(tick, delay);
      };

      nextTickAt = performance.now();
      timer = setTimeout(tick, 0);
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      };
    }, [recordingMode, isHtmlMode, projectId, onRecordingFrameDrawn, allScenes, showSubtitle]);

    if (!scene || allScenes.length === 0) return <EmptyPreview fillContainer={fillContainer} />;

    const isHtmlRecording = recordingMode && isHtmlMode && fillContainer;

    return (
      <div
        className={
          fillContainer
            ? isHtmlRecording
              ? "relative flex h-full w-full min-h-0 flex-col bg-black"
              : "relative flex h-full min-h-0 flex-col gap-2"
            : "relative space-y-3"
        }
      >
        {isHtmlRecording ? (
          <div className="flex h-full min-h-0 w-full items-center justify-center overflow-hidden bg-black">
            <div
              ref={captureRegionRef}
              data-recording-capture="1"
              className="relative shrink-0 overflow-hidden bg-black [container-type:size]"
              style={{
                width: exportWidth,
                height: exportHeight,
                transform: `scale(${recordFitScale}) translateZ(0)`,
                transformOrigin: "center center",
                backfaceVisibility: "hidden",
                isolation: "isolate",
              }}
            >
              <HtmlSceneLayers
                allScenes={allScenes}
                projectId={projectId}
                videoSize={resolvedVideoSize}
                sceneDurations={sceneDurations}
                currentIndex={currentIndex}
                prevScene={prevScene}
                currentOpacity={currentOpacity}
                prevOpacity={prevOpacity}
                sceneTimelineReady={sceneTimelineReady}
                recordingOnly
              />
              {showSubtitle && subtitleText && (
                <SubtitleOverlay text={subtitleText} clauseKey={activeClauseIdx} />
              )}
            </div>
          </div>
        ) : (
        <>
        {fillContainer && isHtmlMode ? (
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-xl bg-black">
            <div
              ref={captureRegionRef}
              className={clsx(
                "relative overflow-hidden [container-type:size]",
                exportPortrait ? "h-full w-auto max-w-full" : "h-auto w-full max-h-full",
              )}
              style={{ aspectRatio: exportAspectRatio }}
            >
              <HtmlSceneLayers
                allScenes={allScenes}
                projectId={projectId}
                videoSize={resolvedVideoSize}
                sceneDurations={sceneDurations}
                currentIndex={currentIndex}
                prevScene={prevScene}
                currentOpacity={currentOpacity}
                prevOpacity={prevOpacity}
                sceneTimelineReady={sceneTimelineReady}
              />
              {showSubtitle && subtitleText && (
                <SubtitleOverlay text={subtitleText} clauseKey={activeClauseIdx} />
              )}
              <div className="absolute left-4 top-4 flex items-center gap-1.5">
                <span className="rounded-md bg-black/40 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
                  {currentScene?.title ?? ""}
                </span>
                <span className="rounded-md bg-black/40 px-1.5 py-1 text-[10px] text-white/80 backdrop-blur-sm">
                  {currentIndex + 1}/{allScenes.length}
                </span>
              </div>
            </div>
          </div>
        ) : (
        <div
          ref={captureRegionRef}
          className={
            fillContainer
              ? recordingMode && !isHtmlMode
                  ? "relative mx-auto flex aspect-video w-full max-h-full items-center justify-center overflow-hidden rounded-xl bg-black shadow-soft [container-type:size]"
                  : "relative w-full flex-1 overflow-hidden rounded-xl shadow-soft [container-type:size]"
              : exportPortrait
                ? "relative mx-auto aspect-[9/16] h-[420px] w-auto max-w-full overflow-hidden rounded-xl shadow-soft [container-type:size]"
              : "relative h-[420px] w-full overflow-hidden rounded-xl shadow-soft [container-type:size]"
          }
        >
          {recordingMode && !isHtmlMode ? (
            <canvas
              ref={recordingCanvasRef}
              width={exportWidth}
              height={exportHeight}
              className="h-full w-full"
              style={{ objectFit: "contain" }}
            />
          ) : isHtmlMode ? (
            <HtmlSceneLayers
              allScenes={allScenes}
              projectId={projectId}
              videoSize={resolvedVideoSize}
              sceneDurations={sceneDurations}
              currentIndex={currentIndex}
              prevScene={prevScene}
              currentOpacity={currentOpacity}
              prevOpacity={prevOpacity}
              sceneTimelineReady={sceneTimelineReady}
            />
          ) : (
            <>
              {currentScene && (
                <SceneLayer
                  scene={currentScene}
                  projectId={projectId}
                  videoSize={resolvedVideoSize}
                  sceneDurations={sceneDurations}
                  opacity={currentOpacity}
                  fade={Boolean(prevScene)}
                  isHtmlMode={false}
                />
              )}
              {prevScene && (
                <SceneLayer
                  key={`prev-${prevScene.index}`}
                  scene={prevScene}
                  projectId={projectId}
                  videoSize={resolvedVideoSize}
                  sceneDurations={sceneDurations}
                  opacity={prevOpacity}
                  fade
                  isHtmlMode={false}
                />
              )}
            </>
          )}
          {(!recordingMode || !isHtmlMode) && (
            <div className="absolute left-4 top-4 flex items-center gap-1.5">
              <span className="rounded-md bg-black/40 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
                {currentScene?.title ?? ""}
              </span>
              <span className="rounded-md bg-black/40 px-1.5 py-1 text-[10px] text-white/80 backdrop-blur-sm">
                {currentIndex + 1}/{allScenes.length}
              </span>
            </div>
          )}
          {showSubtitle && subtitleText && (!recordingMode || isHtmlMode) && (
            <SubtitleOverlay text={subtitleText} clauseKey={activeClauseIdx} />
          )}
        </div>
        )}
        {recordingMode && !isHtmlMode && (
          <div className="pointer-events-none absolute right-4 top-4 z-20 flex items-center gap-1.5 rounded-md bg-red-500/95 px-2 py-1 text-[11px] font-semibold text-white shadow-md backdrop-blur-sm">
            <span className="relative grid h-2 w-2 place-items-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
            </span>
            录制中
          </div>
        )}
        {onRecordingCancel && recordingMode && !isHtmlMode && (
          <button
            type="button"
            onClick={onRecordingCancel}
            aria-label="取消录制"
            className="absolute right-4 top-14 z-20 grid h-8 w-8 place-items-center rounded-md bg-black/55 text-white/90 backdrop-blur-sm transition hover:bg-black/75"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        <div className="flex shrink-0 items-center gap-3 px-2">
          {recordingMode ? (
            // 录屏中：禁用播放/暂停/拖动按钮，避免误操作打断录制
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-red-500/90 text-white shadow-glow">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-white" />
            </div>
          ) : (
            <button onClick={togglePlay}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-gradient text-white shadow-glow transition hover:opacity-90">
              {isPlaying
                ? <Square className="h-3.5 w-3.5 fill-white" />
                : <Play className="h-4 w-4 translate-x-[1px] fill-white" />}
            </button>
          )}
          <span className="min-w-[80px] text-xs tabular-nums text-ink-600">
            {formatTime(playedTotal)}/{formatTime(totalDuration)}
          </span>
          <div className="group relative flex-1 cursor-pointer" onClick={handleProgressClick}>
            <div className="absolute inset-y-0 my-auto h-1.5 w-full rounded-full bg-ink-200">
              <div className="h-1.5 rounded-full bg-brand-500" style={{ width: `${progressRatio * 100}%` }} />
            </div>
            <div className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-brand-500 shadow-sm opacity-0 group-hover:opacity-100"
              style={{ left: `${progressRatio * 100}%` }} />
          </div>
          <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-1 text-[11px] text-ink-500">
            <Film className="h-3 w-3" />{allScenes.length} 镜
          </span>
          <button aria-label="音量" className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-500 transition hover:bg-ink-100">
            <Volume2 className="h-4 w-4" />
          </button>
        </div>
        </>
        )}

      </div>
    );
  },
);

// ===================== 录制帧绘制（图片轮播） =====================

type SyncRecordingParams = {
  allScenes: OutlineScene[];
  sceneDurations: Record<number, number>;
  sceneStartSec: Record<number, number>;
  useFullAudio: boolean;
  audio: HTMLAudioElement | null;
  currentIndex: number;
  sceneElapsed: number;
  showSubtitle: boolean;
  fadeStartedAtRef: MutableRefObject<number | null>;
  fadeOutgoingSceneRef: MutableRefObject<OutlineScene | null>;
  recordingLastSceneIndexRef: MutableRefObject<number>;
};

/** 按音频时钟计算当前镜 / 交叉叠化，保证导出 30fps 连续 */
function syncRecordingRenderState(
  target: { current: RenderState },
  params: SyncRecordingParams,
): void {
  const clock = resolvePlaybackClock(params);
  const lastIdx = params.recordingLastSceneIndexRef.current;

  if (lastIdx < 0) {
    params.recordingLastSceneIndexRef.current = clock.sceneIndex;
  } else if (
    clock.sceneIndex !== lastIdx &&
    params.fadeStartedAtRef.current === null
  ) {
    params.fadeStartedAtRef.current = performance.now();
    params.fadeOutgoingSceneRef.current = params.allScenes[lastIdx] ?? null;
  }

  const sc = params.allScenes[clock.sceneIndex] ?? null;
  const dur = sc
    ? params.sceneDurations[sc.index] ?? DEFAULT_SCENE_DURATION
    : DEFAULT_SCENE_DURATION;

  let prevScene = params.fadeOutgoingSceneRef.current;
  let prevOpacity = 1;
  let currentOpacity = 1;
  const fadeStartedAt = params.fadeStartedAtRef.current;
  if (fadeStartedAt !== null && prevScene) {
    const fadeT = Math.min(1, (performance.now() - fadeStartedAt) / FADE_DURATION_MS);
    prevOpacity = 1 - fadeT;
    currentOpacity = fadeT;
    if (fadeT >= 1) {
      prevScene = null;
      currentOpacity = 1;
      params.fadeStartedAtRef.current = null;
      params.fadeOutgoingSceneRef.current = null;
      params.recordingLastSceneIndexRef.current = clock.sceneIndex;
    }
  } else {
    prevScene = null;
    if (fadeStartedAt === null) {
      params.recordingLastSceneIndexRef.current = clock.sceneIndex;
    }
  }

  const clauses = sc ? splitNarration(sc.narration) : [];
  const speechDur = sc
    ? subtitleSpeechDurationSec(
        sc.narration,
        dur,
        clock.sceneIndex >= params.allScenes.length - 1,
        params.useFullAudio,
      )
    : dur;
  const clauseIdx = subtitleClauseIndexAt(clauses, clock.sceneElapsed, speechDur);
  const subtitleText = clauseIdx >= 0 ? clauses[clauseIdx].text : "";

  target.current = {
    currentScene: sc,
    prevScene,
    currentOpacity,
    prevOpacity,
    showSubtitle: params.showSubtitle,
    subtitleText,
    isHtmlMode: false,
  };
}

type RenderState = {
  currentScene: OutlineScene | null;
  prevScene: OutlineScene | null;
  currentOpacity: number;
  prevOpacity: number;
  showSubtitle: boolean;
  subtitleText: string;
  isHtmlMode: boolean;
};

function drawRecordingFrame(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: RenderState,
  imageCache: Map<string, HTMLImageElement>,
  projectId: string | null,
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  if (s.currentScene) {
    drawSceneLayer(
      ctx, w, h, s.currentScene, s.currentOpacity,
      imageCache, projectId,
    );
  } else {
    drawEmptyState(ctx, w, h);
  }
  if (s.prevScene) {
    drawSceneLayer(
      ctx, w, h, s.prevScene, s.prevOpacity,
      imageCache, projectId,
    );
  }

  if (s.currentScene) {
    drawBadge(ctx, w, s.currentScene.title, 24, 24);
  }
  if (s.showSubtitle && s.subtitleText) {
    drawSubtitle(ctx, w, h, s.subtitleText);
  }
}

function drawSceneLayer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: OutlineScene,
  opacity: number,
  imageCache: Map<string, HTMLImageElement>,
  projectId: string | null,
): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

  const imageUrl = scene.imagePath && projectId
    ? `/api/project-images/${projectId}/${scene.index}.png`
    : null;

  if (imageUrl) {
    const img = imageCache.get(imageUrl);
    if (img && img.complete && img.naturalWidth > 0) {
      drawCoveredImage(ctx, w, h, img);
    } else {
      drawCoverGradient(ctx, w, h, scene.index);
      if (!img) {
        const newImg = new globalThis.Image();
        newImg.src = imageUrl;
        imageCache.set(imageUrl, newImg);
      }
    }
  } else {
    drawCoverGradient(ctx, w, h, scene.index);
  }

  ctx.restore();
}

function drawCoveredImage(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  img: HTMLImageElement,
): void {
  // object-contain: 保持宽高比，完整显示在 w*h 区域内，多余留黑边
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const canvasRatio = w / h;
  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (imgRatio > canvasRatio) {
    // 图片更宽 → 以宽为基准，垂直居中
    drawW = w;
    drawH = w / imgRatio;
    drawX = 0;
    drawY = (h - drawH) / 2;
  } else {
    // 图片更高 → 以高为基准，水平居中
    drawH = h;
    drawW = h * imgRatio;
    drawX = (w - drawW) / 2;
    drawY = 0;
  }
  ctx.drawImage(img, drawX, drawY, drawW, drawH);
}

// 把 cover 的 CSS linear-gradient 翻译成 canvas 渐变。
const coverGradientCache = new Map<number, CanvasGradient | "solid">();

function drawCoverGradient(ctx: CanvasRenderingContext2D, w: number, h: number, sceneIndex: number): void {
  const cached = coverGradientCache.get(sceneIndex);
  if (cached === "solid") {
    ctx.fillStyle = "#0b1024";
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (cached) {
    ctx.fillStyle = cached;
    ctx.fillRect(0, 0, w, h);
    return;
  }

  const css = pickSceneCover(sceneIndex);
  // 形如 "linear-gradient(160deg, #0b1024 0%, #1e1b4b 50%, #312e81 100%)"
  const m = css.match(/linear-gradient\((\d+)deg,\s*(.+)\)$/);
  let angle = 160;
  let stops: { offset: number; rgb: [number, number, number] }[] = [];
  if (m) {
    angle = parseInt(m[1], 10);
    const parts = m[2].split(",").map((s) => s.trim());
    for (const p of parts) {
      const token = p.split(/\s+/);
      const hex = token[0];
      const pct = token[1] ? parseFloat(token[1]) : null;
      const rgb = hexToRgb(hex);
      if (rgb && pct !== null) {
        stops.push({ offset: pct / 100, rgb });
      }
    }
  }
  if (stops.length < 2) {
    coverGradientCache.set(sceneIndex, "solid");
    ctx.fillStyle = "#0b1024";
    ctx.fillRect(0, 0, w, h);
    return;
  }

  // CSS linear-gradient 角度定义：0deg = 向上（从下到上），顺时针。
  // Canvas (x0, y0) → (x1, y1) 是沿 (x0,y0)→(x1,y1) 方向的渐变。
  // 简化：把渐变线定义为画布外接矩形 + 角度的映射。
  const rad = (angle - 90) * (Math.PI / 180);
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.max(w, h);
  const dx = Math.cos(rad) * half;
  const dy = Math.sin(rad) * half;
  const x0 = cx - dx;
  const y0 = cy - dy;
  const x1 = cx + dx;
  const y1 = cy + dy;

  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const s of stops) {
    grad.addColorStop(s.offset, `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]})`);
  }
  coverGradientCache.set(sceneIndex, grad);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

function drawEmptyState(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.save();
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "32px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("视频预览等待生成", w / 2, h / 2);
  ctx.restore();
}

function drawBadge(ctx: CanvasRenderingContext2D, w: number, text: string, x: number, y: number): void {
  ctx.save();
  ctx.font = "600 22px sans-serif";
  const paddingX = 18;
  const paddingY = 10;
  const metrics = ctx.measureText(text);
  const boxW = metrics.width + paddingX * 2;
  const boxH = 38;
  // 圆角矩形
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  roundRect(ctx, x, y, boxW, boxH, 8);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + paddingX, y + boxH / 2);
  ctx.restore();
}

function drawSubtitle(ctx: CanvasRenderingContext2D, w: number, h: number, text: string): void {
  const fontSize = Math.round(h * 0.06);
  const strokeWidth = Math.max(3, Math.round(h * 0.0055));
  const y = h - Math.round(h * 0.09);
  ctx.save();
  ctx.font = `700 ${fontSize}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = strokeWidth;
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,0.95)";
  ctx.strokeText(text, w / 2, y);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, w / 2, y);
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * HTML 分镜层：fetch + 分批 iframe 预载全部分镜，切镜只切 opacity。
 */
function HtmlSceneLayers({
  allScenes,
  projectId,
  videoSize,
  sceneDurations,
  currentIndex,
  prevScene,
  currentOpacity,
  prevOpacity,
  sceneTimelineReady,
  recordingOnly = false,
}: {
  allScenes: OutlineScene[];
  projectId: string | null;
  videoSize: VideoSize;
  sceneDurations: Record<number, number>;
  currentIndex: number;
  prevScene: OutlineScene | null;
  currentOpacity: number;
  prevOpacity: number;
  sceneTimelineReady: boolean;
  /** 录制模式：仅挂载当前镜与叠化 outgoing 镜，避免隐藏 iframe 叠层拖影 */
  recordingOnly?: boolean;
}) {
  const [mountedIndices, setMountedIndices] = useState<number[]>([]);
  const prefetchStartedRef = useRef(false);

  const htmlSceneIndices = useMemo(
    () => allScenes.filter((s) => s.htmlPath).map((s) => s.index),
    [allScenes],
  );

  // 1) fetch 预热 HTTP 缓存
  useEffect(() => {
    if (!projectId || !sceneTimelineReady || prefetchStartedRef.current) return;
    prefetchStartedRef.current = true;
    for (const idx of htmlSceneIndices) {
      const sc = allScenes.find((s) => s.index === idx);
      void fetch(
        sceneHtmlUrl(projectId, idx, videoSize, effectiveSceneDurationSec(sc, sceneDurations)),
      ).catch(() => undefined);
    }
  }, [projectId, sceneTimelineReady, htmlSceneIndices, videoSize, allScenes, sceneDurations]);

  // 2) 时间轴就绪后分批挂载 iframe（首镜优先，其余每 200ms 一个，只执行一次）
  useEffect(() => {
    if (recordingOnly || !projectId || !sceneTimelineReady || htmlSceneIndices.length === 0) {
      return;
    }

    const firstIdx = allScenes[0]?.index;
    const ordered = [...htmlSceneIndices].sort((a, b) => {
      if (firstIdx != null) {
        if (a === firstIdx) return -1;
        if (b === firstIdx) return 1;
      }
      return a - b;
    });

    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    ordered.forEach((idx, i) => {
      timers.push(
        setTimeout(() => {
          if (cancelled) return;
          setMountedIndices((prev) =>
            prev.includes(idx) ? prev : [...prev, idx].sort((x, y) => x - y),
          );
        }, i * HTML_IFRAME_PRELOAD_STAGGER_MS),
      );
    });

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [projectId, sceneTimelineReady, htmlSceneIndices, allScenes, recordingOnly]);

  useEffect(() => {
    if (!sceneTimelineReady) {
      setMountedIndices([]);
      prefetchStartedRef.current = false;
    }
  }, [sceneTimelineReady]);

  // 3) 当前镜 / 叠化 outgoing 镜必须立刻在池中
  useEffect(() => {
    const urgent = new Set<number>();
    const cur = allScenes[currentIndex];
    if (cur?.htmlPath) urgent.add(cur.index);
    if (prevScene?.htmlPath) urgent.add(prevScene.index);
    if (urgent.size === 0) return;
    setMountedIndices((prev) => {
      const merged = new Set([...prev, ...urgent]);
      return [...merged].sort((a, b) => a - b);
    });
  }, [allScenes, currentIndex, prevScene]);

  const renderIndices = useMemo(() => {
    if (!recordingOnly) return mountedIndices;
    const indices = new Set<number>();
    const cur = allScenes[currentIndex];
    if (cur?.htmlPath) indices.add(cur.index);
    if (prevScene?.htmlPath) indices.add(prevScene.index);
    const next = allScenes[currentIndex + 1];
    if (next?.htmlPath) indices.add(next.index);
    return [...indices].sort((a, b) => a - b);
  }, [recordingOnly, mountedIndices, allScenes, currentIndex, prevScene]);

  return (
    <>
      {renderIndices.map((sceneIndex) => {
        const arrIdx = allScenes.findIndex((s) => s.index === sceneIndex);
        if (arrIdx < 0 || !projectId) return null;
        const sc = allScenes[arrIdx];
        if (!sc.htmlPath) return null;

        const isCurrent = arrIdx === currentIndex;
        const isPrev = prevScene?.index === sceneIndex;
        const isPreload = !isCurrent && !isPrev;

        let opacity = 0;
        let fade = false;
        if (isPrev) {
          opacity = prevOpacity;
          fade = true;
        } else if (isCurrent) {
          opacity = currentOpacity;
          fade = Boolean(prevScene);
        }

        const zIndex = isCurrent ? 2 : isPrev ? 1 : 0;
        const dur = effectiveSceneDurationSec(sc, sceneDurations);
        const shouldRun = isCurrent || isPrev;
        const url = sceneHtmlUrl(projectId, sceneIndex, videoSize, dur, shouldRun);

        return (
          <div
            key={sceneIndex}
            className="absolute inset-0"
            style={{
              opacity,
              zIndex,
              transition: fade && !recordingOnly ? `opacity ${FADE_DURATION_MS}ms ease-in-out` : undefined,
              pointerEvents: opacity > 0 ? undefined : "none",
              willChange: !recordingOnly && fade ? "opacity" : undefined,
              transform: recordingOnly ? undefined : "translateZ(0)",
              contentVisibility: isPreload ? "hidden" : "visible",
            }}
            aria-hidden={isPreload}
            {...(isPreload ? { inert: true } : {})}
          >
            <iframe
              key={shouldRun ? `${sceneIndex}-run` : `${sceneIndex}-hold`}
              src={url}
              title={`分镜 ${sceneIndex} 网页动画`}
              className="h-full w-full border-0"
              sandbox="allow-scripts allow-same-origin"
              tabIndex={-1}
            />
          </div>
        );
      })}
    </>
  );
}

function SceneLayer({
  scene, projectId, videoSize, sceneDurations, opacity, fade, isHtmlMode,
}: {
  scene: OutlineScene;
  projectId: string | null;
  videoSize: VideoSize;
  sceneDurations: Record<number, number>;
  opacity: number;
  fade: boolean;
  isHtmlMode: boolean;
}) {
  const hasImage = Boolean(scene.imagePath);
  const hasHtml = Boolean(scene.htmlPath);
  const imageUrl = hasImage && projectId
    ? `/api/project-images/${projectId}/${scene.index}.png`
    : null;
  const htmlUrl = hasHtml && projectId
    ? sceneHtmlUrl(
        projectId,
        scene.index,
        videoSize,
        effectiveSceneDurationSec(scene, sceneDurations),
        opacity > 0,
      )
    : null;
  const cover = pickSceneCover(scene.index);
  const opacityTransition = fade ? `opacity ${FADE_DURATION_MS}ms ease-in-out` : undefined;

  // HTML 模式：iframe 嵌入动画，opacity 走 CSS 过渡
  if (isHtmlMode) {
    if (htmlUrl) {
      return (
        <div
          className="absolute inset-0"
          style={{ opacity, transition: opacityTransition }}
        >
          <iframe
            key={htmlUrl}
            src={htmlUrl}
            title={`分镜 ${scene.index} 网页动画`}
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin"
            tabIndex={-1}
          />
        </div>
      );
    }
    return (
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: cover,
          backgroundSize: "cover",
          backgroundPosition: "center",
          opacity,
          transition: opacityTransition,
        }}
      />
    );
  }

  if (imageUrl) {
    return (
      <div className="absolute inset-0" style={{ opacity, transition: opacityTransition }}>
        <Image
          src={imageUrl}
          alt={`分镜 ${scene.index}`}
          fill
          className="object-contain"
          unoptimized
        />
      </div>
    );
  }
  return (
    <div
      className="absolute inset-0"
      style={{
        backgroundImage: cover,
        backgroundSize: "cover",
        backgroundPosition: "center",
        opacity,
        transition: opacityTransition,
      }}
    />
  );
}

function EmptyPreview({ fillContainer = false }: { fillContainer?: boolean }) {
  return (
    <div className={fillContainer ? "flex h-full min-h-0 flex-col" : "space-y-3"}>
      <div
        className={
          fillContainer
            ? "relative flex flex-1 w-full flex-col items-center justify-center overflow-hidden rounded-xl border border-dashed border-ink-300 bg-gradient-to-br from-ink-50 to-ink-100"
            : "relative flex h-[420px] w-full flex-col items-center justify-center overflow-hidden rounded-2xl border border-dashed border-ink-300 bg-gradient-to-br from-ink-50 to-ink-100"
        }
      >
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-white text-brand-500 shadow-soft">
          <Sparkles className="h-7 w-7" />
        </div>
        <h3 className="mt-4 text-base font-semibold text-ink-900">视频预览等待生成</h3>
        <p className="mt-1 max-w-md px-6 text-center text-sm leading-relaxed text-ink-500">
          在右侧 AI 助手中输入你的创作想法，AI 会先生成完整的脚本与分镜大纲，再依次为每个分镜生成画面。
        </p>
      </div>
    </div>
  );
}
