"use client";

import { Film, Play, Sparkles, Square, Volume2, X } from "lucide-react";
import Image from "next/image";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { toCanvas } from "html-to-image";
import { pickSceneCover } from "./sceneCover";
import { clauseIndexAt, splitNarration } from "@/lib/narration";
import { projectAudioUrl, projectFullAudioUrl } from "@/lib/audioUrl";
import {
  computeSceneAudioSlices,
  sceneAudioMapsFromSlices,
} from "@/lib/audioSlices";
import type { OutlineScene } from "@/lib/outlineTypes";
import type { ProjectType } from "@/lib/projectTypes";

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
};

/** 父级通过 ref 拿到录制用的 canvas + 当前正在播放的 <audio> */
export type VideoPreviewHandle = {
  getRecordingCanvas: () => HTMLCanvasElement | null;
  getCurrentAudioEl: () => HTMLAudioElement | null;
};

const DEFAULT_SCENE_DURATION = 3;
const FADE_DURATION_MS = 450; // 分镜叠化时长
const RECORDING_W = 1920;
const RECORDING_H = 1080;
const RECORDING_FPS = 30;
const RECORDING_FRAME_MS = 1000 / RECORDING_FPS;

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
      onRecordingFrameDrawn,
      onRecordingComplete,
      onRecordingCancel,
      onAudioElementChange,
      fillContainer = false,
    },
    ref,
  ) {
    const isHtmlMode = projectType === "html";
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [totalDuration, setTotalDuration] = useState(0);
    const [sceneDurations, setSceneDurations] = useState<Record<number, number>>({});
    const [kenBurnsScale, setKenBurnsScale] = useState(1);

    // 叠化用：上一镜（outgoing layer），由 1 → 0 渐隐覆盖在当前镜上面
    const [prevScene, setPrevScene] = useState<OutlineScene | null>(null);
    const [prevScale, setPrevScale] = useState(1);
    const [prevOpacity, setPrevOpacity] = useState(1);

    // 每个分镜独立的计时器 id
    const kbTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      prevOpacity: 1,
      scale: 1,
      prevScale: 1,
      showSubtitle: false,
      subtitleText: "",
      isHtmlMode: false,
    });
    const imageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map());
    // HTML 模式录制：离屏 iframe 按 1920×1080 渲染，再快照到 bitmap 供 canvas 合成
    const recordingIframeCurrentRef = useRef<HTMLIFrameElement | null>(null);
    const recordingIframePrevRef = useRef<HTMLIFrameElement | null>(null);
    const htmlBitmapCacheRef = useRef<{ current: ImageBitmap | null; prev: ImageBitmap | null }>({
      current: null,
      prev: null,
    });
    const htmlIframeReadyRef = useRef({ current: false, prev: false });

    useImperativeHandle(ref, () => ({
      getRecordingCanvas: () => recordingCanvasRef.current,
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
      if (allScenes.length === 0) return;
      let cancelled = false;

      (async () => {
        const fullDur = await loadFullAudioDuration();
        if (cancelled) return;

        if (fullDur && fullDur > 0) {
          const slices = computeSceneAudioSlices(allScenes, fullDur);
          const { durations, starts, totalSec } = sceneAudioMapsFromSlices(slices);
          setSceneDurations(durations);
          sceneStartSecRef.current = starts;
          setTotalDuration(totalSec > 0 ? totalSec : fullDur);
          return;
        }

        const fallback = await loadPerSceneDurations();
        if (cancelled) return;
        setSceneDurations(fallback.durations);
        sceneStartSecRef.current = fallback.starts;
        setTotalDuration(
          fallback.totalSec > 0
            ? fallback.totalSec
            : allScenes.length * DEFAULT_SCENE_DURATION,
        );
      })();

      return () => {
        cancelled = true;
      };
    }, [allScenes, loadFullAudioDuration, loadPerSceneDurations, audioGeneratedAt]);

    // 清理所有定时器
    const clearAll = useCallback(() => {
      if (progressTimerRef.current) { clearInterval(progressTimerRef.current); progressTimerRef.current = null; }
      if (kbTimerRef.current) { clearInterval(kbTimerRef.current); kbTimerRef.current = null; }
    }, []);

    // 立即结束叠化、清空 outgoing 图层（用于 stop / seek / 触达最后一镜）
    const clearPrevLayer = useCallback(() => {
      if (fadeoutTimerRef.current) { clearTimeout(fadeoutTimerRef.current); fadeoutTimerRef.current = null; }
      setPrevScene(null);
      setPrevScale(1);
      setPrevOpacity(1);
    }, []);

    const handleFullAudioEnded = useCallback(() => {
      isRunningRef.current = false;
      setIsPlaying(false);
      setCurrentIndex(0);
      setCurrentTime(0);
      setKenBurnsScale(1);
      clearPrevLayer();
      if (recordingMode) {
        onRecordingComplete?.();
      }
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

    // 切到下一个分镜（叠化过渡）
    const advanceToNext = useCallback(() => {
      clearAll();
      // 整片 mp3 连续播放，切镜时不暂停/重启音频
      if (currentIndex >= allScenes.length - 1) {
        isRunningRef.current = false;
        setIsPlaying(false);
        setCurrentIndex(0);
        setCurrentTime(0);
        setKenBurnsScale(1);
        // 收尾：清掉任何残留的叠化层，避免下次播放第一镜叠在旧画面上
        clearPrevLayer();
        // 录屏模式：所有镜播完，通知父级结束录屏
        if (recordingMode) {
          onRecordingComplete?.();
        }
        return;
      }

      // 捕获 outgoing 分镜与其当前 Ken Burns 缩放，作为叠化上层（opacity 1 起步）。
      // 不再用 400ms 黑屏间隔 —— 下一镜 currentIndex 立刻推进，由 useEffect 启动
      // 新分镜的音频/进度，而 useEffect([prevScene]) 会在下一帧把 prevOpacity 翻到 0，
      // 触发 CSS 叠化。
      const outgoing = allScenes[currentIndex];
      if (fadeoutTimerRef.current) clearTimeout(fadeoutTimerRef.current);

      setPrevScene(outgoing ?? null);
      setPrevScale(kenBurnsScale);
      setPrevOpacity(1);

      setCurrentIndex((i) => i + 1);
      setCurrentTime(0);
      setKenBurnsScale(1);

      fadeoutTimerRef.current = setTimeout(() => {
        setPrevScene(null);
        setPrevScale(1);
        setPrevOpacity(1);
        fadeoutTimerRef.current = null;
      }, FADE_DURATION_MS);
    }, [currentIndex, allScenes, kenBurnsScale, clearAll, clearPrevLayer, recordingMode, onRecordingComplete]);

    // 开始播放进度：以整片 mp3 的 currentTime 为唯一时钟，驱动字幕与切镜
    const startProgress = useCallback(() => {
      if (isRunningRef.current) {
        return;
      }
      isRunningRef.current = true;

      const countAtStart = ++progressCountRef.current;
      startedIndexRef.current = currentIndexRef.current;
      doneFiredRef.current = false;

      clearAll();

      kbTimerRef.current = setInterval(() => {
        setKenBurnsScale((prev) => Math.min(prev + 0.015, 1.15));
      }, 200);

      const tick = () => {
        if (
          !isRunningRef.current ||
          doneFiredRef.current ||
          countAtStart !== progressCountRef.current
        ) {
          return;
        }

        const audio = audioRef.current;
        const idx = currentIndexRef.current;
        const sc = allScenes[idx];
        if (!audio || !sc) return;

        const start = sceneStartSecRef.current[sc.index] ?? 0;
        const dur = sceneDurations[sc.index] ?? DEFAULT_SCENE_DURATION;
        const elapsed = audio.currentTime - start;

        if (elapsed >= dur - 0.05) {
          setCurrentTime(dur);
          if (idx >= allScenes.length - 1) {
            return;
          }
          doneFiredRef.current = true;
          isRunningRef.current = false;
          if (progressTimerRef.current) {
            clearInterval(progressTimerRef.current);
            progressTimerRef.current = null;
          }
          if (kbTimerRef.current) {
            clearInterval(kbTimerRef.current);
            kbTimerRef.current = null;
          }
          setTimeout(advanceToNext, 0);
          return;
        }

        sceneElapsedRef.current = Math.max(0, elapsed);
        setCurrentTime(sceneElapsedRef.current);
      };

      progressTimerRef.current = setInterval(tick, 50);
      tick();
    }, [allScenes, sceneDurations, clearAll, advanceToNext]);

    // 播放/暂停
    const togglePlay = useCallback(() => {
      if (isPlaying) {
        isRunningRef.current = false;
        clearAll();
        if (audioRef.current) audioRef.current.pause();
        setIsPlaying(false);
      } else {
        if (allScenes.length === 0) return;
        setIsPlaying(true);
        const sc = allScenes[currentIndex];
        if (sc) {
          const startSec =
            (sceneStartSecRef.current[sc.index] ?? 0) + sceneElapsedRef.current;
          playFullAudioFrom(startSec);
        }
        startProgress();
      }
    }, [isPlaying, currentIndex, allScenes, playFullAudioFrom, startProgress, clearAll]);

    // currentIndex 变化时：自动播放中只重启画面进度，不重启整片音频
    useEffect(() => {
      if (!isPlaying) return;
      clearAll();
      setKenBurnsScale(1);
      startProgress();
    }, [currentIndex]);

    /**
     * 录屏模式：父级把 recordingMode 翻成 true 后，自动从头开始播放。
     * - 重置 currentIndex / currentTime / kenBurns / 叠化层
     * - 触发 isPlaying=true 让上面那个 effect 启动音频 + 进度
     * 注意：录屏模式启动时机由父级决定，父级应该先把"全屏"切好再调这个
     * effect，否则录到的画面不一定是视频全屏的样子。
     */
    useEffect(() => {
      if (!recordingMode || !recordingCaptureReady) return;
      isRunningRef.current = false;
      clearAll();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setAudio(null);
      setCurrentIndex(0);
      setCurrentTime(0);
      setKenBurnsScale(1);
      clearPrevLayer();
      if (allScenes.length === 0) {
        // 边界：没有分镜直接结束
        onRecordingComplete?.();
        return;
      }
      setIsPlaying(true);
      playFullAudioFrom(0);
      startProgress();
      // 录屏模式不依赖 deps 重新触发，只在翻 true 时启动一次
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [recordingMode, recordingCaptureReady]);

    // prevScene 出现时，下一帧把它的 opacity 翻成 0，触发 CSS 叠化动画。
    // 关键点：必须分两次 commit —— 先以 opacity:1 落到 DOM，浏览器 paint 后再改 0，
    // 否则同一渲染周期内 React 会把两次 setState 合并成一帧，transition 不会启动。
    useEffect(() => {
      if (!prevScene) return;
      const raf = requestAnimationFrame(() => setPrevOpacity(0));
      return () => cancelAnimationFrame(raf);
    }, [prevScene]);

    /**
     * 响应外部"切换分镜"（来自 StoryboardList 的点击）：
     *  - 暂停任何正在进行的播放 / 进度 / 音频
     *  - 把内部 currentIndex 同步到外部选中的 scene
     *  - 重置进度、Ken Burns 缩放、叠化残留
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
      setKenBurnsScale(1);
      // 清理叠化层（避免带着上一个镜的残影进入新镜）
      if (fadeoutTimerRef.current) {
        clearTimeout(fadeoutTimerRef.current);
        fadeoutTimerRef.current = null;
      }
      setPrevScene(null);
      setPrevScale(1);
      setPrevOpacity(1);
    }, [scene, allScenes, clearAll]);

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
      setKenBurnsScale(1);
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
        audioRef.current.currentTime = targetSec;
      }
      setIsPlaying(false);
      setCurrentIndex(targetIdx);
      setCurrentTime(sceneOffset);
      sceneElapsedRef.current = sceneOffset;
      setKenBurnsScale(1);
      // 拖动跳转使用硬切（瞬时响应），不做叠化
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

    // 字幕分句 + 同步：把当前镜的旁白按标点切成短句，再用 currentTime/sceneDuration 落到对应短句。
    // 字数比例 = 播放比例（短句长 → 占的播放窗口长）。
    const currentClauses = useMemo(
      () => (currentScene ? splitNarration(currentScene.narration) : []),
      [currentScene],
    );
    const currentSceneDuration =
      sceneDurations[currentScene?.index ?? -1] ?? DEFAULT_SCENE_DURATION;
    const sceneRatio = currentSceneDuration > 0
      ? Math.min(currentTime / currentSceneDuration, 1)
      : 0;
    const activeClauseIdx = clauseIndexAt(currentClauses, sceneRatio);
    const subtitleText = activeClauseIdx >= 0 ? currentClauses[activeClauseIdx].text : "";

    // 录制开始前预加载所有分镜图片，避免 canvas 绘制时还在异步加载
    useEffect(() => {
      if (!recordingMode || isHtmlMode || !projectId) return;
      for (const sc of allScenes) {
        if (!sc.imagePath) continue;
        const url = `/api/project-images/${projectId}/${sc.index}.png`;
        if (imageCacheRef.current.has(url)) continue;
        const img = new globalThis.Image();
        img.src = url;
        imageCacheRef.current.set(url, img);
      }
    }, [recordingMode, isHtmlMode, projectId, allScenes]);

    // HTML 模式：同步离屏 iframe 的 src 到当前/叠化分镜
    useEffect(() => {
      if (!recordingMode || !isHtmlMode || !projectId) return;

      const curIframe = recordingIframeCurrentRef.current;
      if (curIframe) {
        htmlIframeReadyRef.current.current = false;
        if (currentScene?.htmlPath) {
          curIframe.src = sceneHtmlUrl(projectId, currentScene);
        } else {
          curIframe.src = "about:blank";
        }
      }

      const prevIframe = recordingIframePrevRef.current;
      if (prevIframe) {
        htmlIframeReadyRef.current.prev = false;
        if (prevScene?.htmlPath) {
          prevIframe.src = sceneHtmlUrl(projectId, prevScene);
        } else {
          prevIframe.src = "about:blank";
          htmlBitmapCacheRef.current.prev?.close();
          htmlBitmapCacheRef.current.prev = null;
        }
      }
    }, [recordingMode, isHtmlMode, projectId, currentScene, prevScene]);

    // 把当前播放状态写到 ref，录制循环读 ref 画到 canvas
    useEffect(() => {
      renderStateRef.current = {
        currentScene,
        prevScene,
        prevOpacity,
        scale: kenBurnsScale,
        prevScale,
        showSubtitle,
        subtitleText,
        isHtmlMode,
      };
    });

    // 录制循环：HTML 快照 + canvas 绘制 + requestFrame 统一在固定 30fps 节拍
    useEffect(() => {
      if (!recordingMode) return;
      const canvas = recordingCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      let stopped = false;
      let busy = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let nextTickAt = performance.now();

      const tick = async () => {
        if (stopped) return;
        if (busy) {
          timer = setTimeout(tick, 4);
          return;
        }
        busy = true;
        try {
          if (isHtmlMode) {
            const ready = htmlIframeReadyRef.current;
            const state = renderStateRef.current;
            if (ready.current) {
              const iframe = recordingIframeCurrentRef.current;
              if (iframe) {
                const bmp = await captureIframeToBitmap(iframe);
                if (bmp) {
                  htmlBitmapCacheRef.current.current?.close();
                  htmlBitmapCacheRef.current.current = bmp;
                }
              }
            }
            if (ready.prev && state.prevScene && state.prevOpacity > 0) {
              const iframe = recordingIframePrevRef.current;
              if (iframe) {
                const bmp = await captureIframeToBitmap(iframe);
                if (bmp) {
                  htmlBitmapCacheRef.current.prev?.close();
                  htmlBitmapCacheRef.current.prev = bmp;
                }
              }
            }
          }

          drawRecordingFrame(
            ctx,
            canvas.width,
            canvas.height,
            renderStateRef.current,
            imageCacheRef.current,
            projectId,
            htmlBitmapCacheRef.current,
          );
          onRecordingFrameDrawn?.();
        } catch (e) {
          console.warn("[recording] frame tick failed:", e);
        } finally {
          busy = false;
          if (!stopped) {
            nextTickAt += RECORDING_FRAME_MS;
            const delay = Math.max(0, nextTickAt - performance.now());
            timer = setTimeout(tick, delay);
          }
        }
      };

      nextTickAt = performance.now();
      timer = setTimeout(tick, 0);
      return () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        htmlBitmapCacheRef.current.current?.close();
        htmlBitmapCacheRef.current.prev?.close();
        htmlBitmapCacheRef.current = { current: null, prev: null };
        htmlIframeReadyRef.current = { current: false, prev: false };
      };
    }, [recordingMode, isHtmlMode, projectId, onRecordingFrameDrawn]);

    if (!scene || allScenes.length === 0) return <EmptyPreview fillContainer={fillContainer} />;

    return (
      <div className={fillContainer ? "flex h-full min-h-0 flex-col gap-2" : "space-y-3"}>
        <div
          className={
            fillContainer
              ? "relative w-full flex-1 overflow-hidden rounded-xl shadow-soft"
              : "relative h-[420px] w-full overflow-hidden rounded-xl shadow-soft"
          }
        >
          {/* 底层：当前镜（始终满 opacity，新镜出现时被上层 prev 渐隐让位露出来） */}
          {currentScene && (
            <SceneLayer
              scene={currentScene}
              projectId={projectId}
              scale={kenBurnsScale}
              opacity={1}
              fade={false}
              isHtmlMode={isHtmlMode}
            />
          )}
          {/* 上层：上一镜，opacity 1 → 0 触发叠化 */}
          {prevScene && (
            <SceneLayer
              key={`prev-${prevScene.index}`}
              scene={prevScene}
              projectId={projectId}
              scale={prevScale}
              opacity={prevOpacity}
              fade
              isHtmlMode={isHtmlMode}
            />
          )}
          <div className="absolute left-4 top-4 flex items-center gap-1.5">
            <span className="rounded-md bg-black/40 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
              {currentScene?.title ?? ""}
            </span>
            <span className="rounded-md bg-black/40 px-1.5 py-1 text-[10px] text-white/80 backdrop-blur-sm">
              {currentIndex + 1}/{allScenes.length}
            </span>
          </div>
          {recordingMode && (
            <div className="absolute right-4 top-4 flex items-center gap-1.5 rounded-md bg-red-500/95 px-2 py-1 text-[11px] font-semibold text-white shadow-md backdrop-blur-sm">
              <span className="relative grid h-2 w-2 place-items-center">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/80" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
              </span>
              录制中
            </div>
          )}
          {onRecordingCancel && recordingMode && (
            <button
              type="button"
              onClick={onRecordingCancel}
              aria-label="取消录制"
              className="absolute right-4 top-14 grid h-8 w-8 place-items-center rounded-md bg-black/55 text-white/90 backdrop-blur-sm transition hover:bg-black/75"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          {showSubtitle && subtitleText && (
            <div className="absolute inset-x-0 bottom-8 flex justify-center px-6 pointer-events-none">
              <span
                key={activeClauseIdx}
                className="max-w-[90%] rounded-md px-5 py-2 text-center text-lg font-semibold leading-snug text-white"
                style={{
                  // 多重 text-shadow：黑色描边 + 深阴影，确保亮底深底都清晰
                  textShadow:
                    "0 2px 6px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9), 0 1px 0 rgba(0,0,0,0.9), 0 -1px 0 rgba(0,0,0,0.9), 1px 0 0 rgba(0,0,0,0.9), -1px 0 0 rgba(0,0,0,0.9)",
                  letterSpacing: "0.02em",
                }}
              >
                {subtitleText}
              </span>
            </div>
          )}
        </div>
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

        {/* HTML 模式录制：离屏 iframe 承载真实动画，canvas 通过快照合成 */}
        {recordingMode && isHtmlMode && projectId && (
          <div
            className="pointer-events-none fixed left-[-9999px] top-0 opacity-0"
            style={{ width: RECORDING_W, height: RECORDING_H }}
            aria-hidden
          >
            <iframe
              ref={recordingIframeCurrentRef}
              title="录制当前镜"
              width={RECORDING_W}
              height={RECORDING_H}
              className="block border-0"
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => {
                htmlIframeReadyRef.current.current = true;
              }}
            />
            <iframe
              ref={recordingIframePrevRef}
              title="录制叠化镜"
              width={RECORDING_W}
              height={RECORDING_H}
              className="absolute left-0 top-0 block border-0"
              sandbox="allow-scripts allow-same-origin"
              onLoad={() => {
                htmlIframeReadyRef.current.prev = true;
              }}
            />
          </div>
        )}

        {/* 录制 canvas：移出视口但保持可渲染，captureStream 才能稳定抓帧。 */}
        <canvas
          ref={recordingCanvasRef}
          width={RECORDING_W}
          height={RECORDING_H}
          className="pointer-events-none fixed left-[-9999px] top-0 opacity-0"
          aria-hidden
        />
      </div>
    );
  },
);

// ===================== 录制帧绘制 =====================

const HTML_CAPTURE_OPTS = {
  width: RECORDING_W,
  height: RECORDING_H,
  canvasWidth: RECORDING_W,
  canvasHeight: RECORDING_H,
  pixelRatio: 1,
};

function sceneHtmlUrl(projectId: string, scene: OutlineScene): string {
  return `/api/project-scenes/${projectId}/${scene.index}.html`;
}

async function captureIframeToBitmap(iframe: HTMLIFrameElement): Promise<ImageBitmap | null> {
  const doc = iframe.contentDocument;
  if (!doc?.body) return null;
  const snap = await toCanvas(doc.body, {
    ...HTML_CAPTURE_OPTS,
    skipFonts: true,
  });
  return createImageBitmap(snap);
}

type HtmlBitmapCache = { current: ImageBitmap | null; prev: ImageBitmap | null };

type RenderState = {
  currentScene: OutlineScene | null;
  prevScene: OutlineScene | null;
  prevOpacity: number;
  scale: number;
  prevScale: number;
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
  htmlBitmaps: HtmlBitmapCache,
): void {
  // 1) 清屏 → 黑底
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);

  // 2) 画 prev（叠化上层，opacity 0~1）
  if (s.prevScene) {
    drawSceneLayer(
      ctx,
      w,
      h,
      s.prevScene,
      s.prevScale,
      s.prevOpacity,
      s.isHtmlMode,
      imageCache,
      projectId,
      htmlBitmaps.prev,
    );
  }
  // 3) 画 current（满 opacity）
  if (s.currentScene) {
    drawSceneLayer(
      ctx,
      w,
      h,
      s.currentScene,
      s.scale,
      1,
      s.isHtmlMode,
      imageCache,
      projectId,
      htmlBitmaps.current,
    );
  } else {
    drawEmptyState(ctx, w, h);
  }

  // 4) 角标：分镜序号
  if (s.currentScene) {
    drawBadge(ctx, w, `${s.currentScene.title} · 录制中`, 24, 24);
  }

  // 5) 字幕
  if (s.showSubtitle && s.subtitleText) {
    drawSubtitle(ctx, w, h, s.subtitleText);
  }
}

function drawSceneLayer(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  scene: OutlineScene,
  scale: number,
  opacity: number,
  isHtmlMode: boolean,
  imageCache: Map<string, HTMLImageElement>,
  projectId: string | null,
  htmlBitmap: ImageBitmap | null = null,
): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, opacity));

  const hasImage = Boolean(scene.imagePath);
  const hasHtml = Boolean(scene.htmlPath);
  const imageUrl = hasImage && projectId
    ? `/api/project-images/${projectId}/${scene.index}.png`
    : null;

  // HTML 模式：优先用离屏 iframe 快照（与预览 iframe 内容一致）
  if (isHtmlMode && hasHtml) {
    if (htmlBitmap) {
      ctx.drawImage(htmlBitmap, 0, 0, w, h);
    } else {
      drawCoverGradient(ctx, w, h, scene.index);
    }
    ctx.restore();
    return;
  }

  // 渲染优先级：
  //  - image 模式 + 有图 → drawImage（cover + Ken Burns）
  //  - HTML 模式 + 有图 → 仍然 drawImage（很多 HTML 模式也有图作为背景）
  //  - 无图 → 画 cover 渐变
  if (imageUrl) {
    const img = imageCache.get(imageUrl);
    if (img && img.complete && img.naturalWidth > 0) {
      drawCoveredImage(ctx, w, h, img, scale);
    } else {
      drawCoverGradient(ctx, w, h, scene.index);
      if (!img) {
        const newImg = new globalThis.Image();
        newImg.onload = () => {
          /* 下次 RAF 自然会重画 */
        };
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
  kenBurnsScale: number,
): void {
  // object-cover: 保持宽高比，铺满 w*h，多余裁掉
  const imgRatio = img.naturalWidth / img.naturalHeight;
  const canvasRatio = w / h;
  let drawW: number, drawH: number, drawX: number, drawY: number;
  if (imgRatio > canvasRatio) {
    // 图比画布更宽 → 以高为基准
    drawH = h;
    drawW = h * imgRatio;
    drawX = (w - drawW) / 2;
    drawY = 0;
  } else {
    drawW = w;
    drawH = w / imgRatio;
    drawX = 0;
    drawY = (h - drawH) / 2;
  }
  // Ken Burns 缩放：以画布中心为锚点放大
  const finalScale = kenBurnsScale;
  const sw = drawW * finalScale;
  const sh = drawH * finalScale;
  const sx = drawX - (sw - drawW) / 2;
  const sy = drawY - (sh - drawH) / 2;
  ctx.drawImage(img, sx, sy, sw, sh);
}

// 把 cover 的 CSS linear-gradient 翻译成 canvas 渐变。
// SCENE_COVERS 全是 160deg 起点，3 个色标，足够稳定。
function drawCoverGradient(ctx: CanvasRenderingContext2D, w: number, h: number, sceneIndex: number): void {
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
  ctx.save();
  ctx.font = "600 36px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // 描边
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.strokeText(text, w / 2, h - 100);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, w / 2, h - 100);
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

function SceneLayer({
  scene, projectId, scale, opacity, fade, isHtmlMode,
}: {
  scene: OutlineScene;
  projectId: string | null;
  scale: number;
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
    ? `/api/project-scenes/${projectId}/${scene.index}.html`
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
          className="object-cover"
          unoptimized
          style={{
            transform: `scale(${scale})`,
            transformOrigin: "center center",
            transition: "transform 0.2s linear",
          }}
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
        transform: `scale(${scale})`,
        transition: opacityTransition
          ? `transform 0.2s linear, ${opacityTransition}`
          : "transform 0.2s linear",
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
