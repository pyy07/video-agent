"use client";

import { Film, Pause, Play, Square } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HtmlPreviewCanvas } from "@/components/create/HtmlPreviewCanvas";
import {
  formatPlayerDuration,
  loadSceneDurations,
  useVideoPlayer,
} from "@/components/create/useVideoPlayer";
import type { OutlineScene } from "@/lib/outlineTypes";
import type { VideoSize } from "@/lib/exportVideo";

export type HtmlStudioPreviewHandle = {
  getPreviewStage: () => HTMLDivElement | null;
  playFromIndex: (index: number) => void;
  stop: () => void;
  isPlaying: boolean;
  currentIndex: number;
};

type HtmlStudioPreviewProps = {
  scenes: OutlineScene[];
  activeSceneIndex: number;
  projectId: string | null;
  audioGeneratedAt?: string;
  showSubtitle: boolean;
  videoSize: VideoSize;
  exportBusy?: boolean;
  /** 录屏布局：固定导出像素尺寸 + 整体 scale 适配窗口，避免录制开头画面缩放 */
  recordingCapture?: boolean;
  onSceneIndexChange?: (index: number) => void;
  onPlayerStateChange?: (state: { isPlaying: boolean; currentIndex: number }) => void;
};

/**
 * HTML 模式预览 + 播放（对齐 ai-video-agent PreviewPanel 核心逻辑）。
 * 导出时在主预览区 applyRecordingFocus，不再使用全屏覆盖层第二套 VideoPreview。
 */
export const HtmlStudioPreview = forwardRef<HtmlStudioPreviewHandle, HtmlStudioPreviewProps>(
  function HtmlStudioPreview(
    {
      scenes,
      activeSceneIndex,
      projectId,
      audioGeneratedAt,
      showSubtitle,
      videoSize,
      exportBusy = false,
      recordingCapture = false,
      onSceneIndexChange,
      onPlayerStateChange,
    },
    ref,
  ) {
    const previewStageRef = useRef<HTMLDivElement>(null);
    const fitScaleLockedRef = useRef<number | null>(null);
    const [fitScale, setFitScale] = useState(1);
    const [sceneDurations, setSceneDurations] = useState<Record<number, number>>({});
    const [totalDuration, setTotalDuration] = useState(0);
    const [timelineReady, setTimelineReady] = useState(false);

    const handleSceneIndexChange = useCallback(
      (index: number) => {
        onSceneIndexChange?.(index);
      },
      [onSceneIndexChange],
    );

    const player = useVideoPlayer({
      scenes,
      projectId,
      audioGeneratedAt,
      initialIndex: activeSceneIndex,
      onSceneIndexChange: handleSceneIndexChange,
    });

    useImperativeHandle(
      ref,
      () => ({
        getPreviewStage: () => previewStageRef.current,
        playFromIndex: player.playFromIndex,
        stop: player.stop,
        isPlaying: player.isPlaying,
        currentIndex: player.currentIndex,
      }),
      [player.playFromIndex, player.stop, player.isPlaying, player.currentIndex],
    );

    useEffect(() => {
      onPlayerStateChange?.({
        isPlaying: player.isPlaying,
        currentIndex: player.currentIndex,
      });
    }, [player.isPlaying, player.currentIndex, onPlayerStateChange]);

    useLayoutEffect(() => {
      if (!recordingCapture) {
        fitScaleLockedRef.current = null;
        setFitScale(1);
        return;
      }
      if (fitScaleLockedRef.current != null) {
        setFitScale(fitScaleLockedRef.current);
        return;
      }
      const mw = window.innerWidth;
      const mh = window.innerHeight;
      const scale = Math.min(1, mw / videoSize.width, mh / videoSize.height);
      fitScaleLockedRef.current = scale;
      setFitScale(scale);
    }, [recordingCapture, videoSize.width, videoSize.height]);

    useEffect(() => {
      if (scenes.length === 0) {
        setTimelineReady(false);
        return;
      }
      let cancelled = false;
      setTimelineReady(false);
      void (async () => {
        const { durations, totalSec } = await loadSceneDurations(
          scenes,
          projectId,
          audioGeneratedAt,
        );
        if (cancelled) return;
        setSceneDurations(durations);
        setTotalDuration(totalSec);
        setTimelineReady(true);
      })();
      return () => {
        cancelled = true;
      };
    }, [scenes, projectId, audioGeneratedAt]);

    const displayIndex = player.isPlaying ? player.currentIndex : activeSceneIndex;
    const displayScene = scenes[displayIndex] ?? null;

    const elapsedTotal = useMemo(() => {
      let t = player.currentTime;
      for (let i = 0; i < displayIndex; i++) {
        const sc = scenes[i];
        if (sc) t += sceneDurations[sc.index] ?? 3;
      }
      return t;
    }, [player.currentTime, displayIndex, scenes, sceneDurations]);

    const progressPct = totalDuration > 0 ? (elapsedTotal / totalDuration) * 100 : 0;
    const hasScenes = scenes.length > 0;

    const previewContent =
      timelineReady && displayScene ? (
        <HtmlPreviewCanvas
          scene={displayScene}
          projectId={projectId}
          videoSize={videoSize}
          sceneDurations={sceneDurations}
          showSubtitle={showSubtitle}
          currentTime={player.currentTime}
          isPlaying={player.isPlaying}
          recordingCapture={recordingCapture}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-white/60">
          加载分镜时间轴…
        </div>
      );

    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div ref={previewStageRef} className="preview-fullscreen-stage relative min-h-0 flex-1">
          <div
            className={
              recordingCapture
                ? "flex h-full min-h-0 items-center justify-center overflow-hidden bg-black"
                : "flex h-full min-h-0 items-center justify-center overflow-hidden rounded-xl bg-black"
            }
          >
            {recordingCapture ? (
              <div
                data-recording-capture="1"
                className="relative shrink-0 overflow-hidden bg-black"
                style={{
                  width: videoSize.width,
                  height: videoSize.height,
                  transform: `scale(${fitScale}) translateZ(0)`,
                  transformOrigin: "center center",
                  backfaceVisibility: "hidden",
                }}
              >
                {previewContent}
              </div>
            ) : (
              previewContent
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-ink-200/70 bg-white px-3 py-2 shadow-soft">
          <button
            type="button"
            onClick={player.togglePlay}
            disabled={!hasScenes || exportBusy || !timelineReady}
            title={player.isPlaying ? "暂停" : "播放（连续播放所有分镜）"}
            className="grid h-8 w-8 place-items-center rounded-lg bg-brand-gradient text-white transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {player.isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={player.stop}
            disabled={!hasScenes || exportBusy || !timelineReady}
            title="停止"
            className="grid h-8 w-8 place-items-center rounded-lg border border-ink-200 text-ink-600 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Square className="h-3.5 w-3.5" />
          </button>

          <div className="min-w-0 flex-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
              <div
                className="h-full bg-brand-500 transition-all duration-100"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          <div className="shrink-0 font-mono text-xs tabular-nums text-ink-500">
            {formatPlayerDuration(elapsedTotal)}/{formatPlayerDuration(totalDuration)}
            <span className="ml-2 inline-flex items-center gap-1">
              <Film className="h-3 w-3" />
              {scenes.length} 镜
            </span>
          </div>
        </div>

        {player.currentAudioSrc && (
          <audio ref={player.audioRef} src={player.currentAudioSrc} preload="auto" />
        )}
      </div>
    );
  },
);
