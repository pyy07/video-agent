"use client";

import { Code2 } from "lucide-react";
import {
  forwardRef,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { OutlineScene } from "@/lib/outlineTypes";
import {
  DEFAULT_VIDEO_SIZE,
  logicalCanvasSize,
  type VideoSize,
} from "@/lib/exportVideo";
import { estimateSceneDurationSec, clauseIndexAt, splitNarration } from "@/lib/narration";

const TRANSITION_MS = 500;
const SCENE_EMBED_REV = 9;

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

function sceneDurationSec(
  scene: OutlineScene,
  sceneDurations: Record<number, number>,
): number {
  const fromAudio = sceneDurations[scene.index];
  if (typeof fromAudio === "number" && fromAudio > 0) return fromAudio;
  if (typeof scene.durationSec === "number" && scene.durationSec > 0) {
    return scene.durationSec;
  }
  if (scene.narration?.trim()) {
    return estimateSceneDurationSec(scene.narration);
  }
  return 3;
}

function SubtitleOverlay({ text, clauseKey }: { text: string; clauseKey: number }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-[3cqh] z-10 flex justify-center px-[3cqw]">
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

export type HtmlPreviewCanvasProps = {
  scene: OutlineScene | null;
  projectId: string | null;
  videoSize?: VideoSize;
  sceneDurations: Record<number, number>;
  showSubtitle: boolean;
  currentTime: number;
  isPlaying: boolean;
  /** 录屏采集：固定尺寸容器内渲染，禁用叠化避免开头缩放/淡入 */
  recordingCapture?: boolean;
};

/** HTML 分镜预览画布（对齐 ai-video-agent PreviewCanvas） */
export const HtmlPreviewCanvas = forwardRef<HTMLDivElement, HtmlPreviewCanvasProps>(
  function HtmlPreviewCanvas(
    {
      scene,
      projectId,
      videoSize,
      sceneDurations,
      showSubtitle,
      currentTime,
      isPlaying,
      recordingCapture = false,
    },
    ref,
  ) {
    const resolvedVideoSize = videoSize ?? DEFAULT_VIDEO_SIZE;
    const exportAspectRatio = `${resolvedVideoSize.width} / ${resolvedVideoSize.height}`;

    if (!scene || !projectId) {
      return (
        <div
          ref={ref}
          className="preview-stage flex h-full items-center justify-center rounded-xl border-2 border-dashed border-ink-200 bg-ink-50"
        >
          <div className="text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-ink-100">
              <Code2 className="h-6 w-6 text-ink-400" />
            </div>
            <p className="text-sm font-medium text-ink-700">还没有可预览的内容</p>
          </div>
        </div>
      );
    }

    return (
      <HtmlPreviewBody
        ref={ref}
        scene={scene}
        projectId={projectId}
        videoSize={resolvedVideoSize}
        exportAspectRatio={exportAspectRatio}
        sceneDurations={sceneDurations}
        showSubtitle={showSubtitle}
        currentTime={currentTime}
        isPlaying={isPlaying}
        recordingCapture={recordingCapture}
      />
    );
  },
);

type HtmlPreviewBodyProps = {
  scene: OutlineScene;
  projectId: string;
  videoSize: VideoSize;
  exportAspectRatio: string;
  sceneDurations: Record<number, number>;
  showSubtitle: boolean;
  currentTime: number;
  isPlaying: boolean;
  recordingCapture: boolean;
};

const HtmlPreviewBody = forwardRef<HTMLDivElement, HtmlPreviewBodyProps>(function HtmlPreviewBody(
  {
    scene,
    projectId,
    videoSize,
    exportAspectRatio,
    sceneDurations,
    showSubtitle,
    currentTime,
    isPlaying,
    recordingCapture,
  },
  ref,
) {
  const [displayed, setDisplayed] = useState(scene);
  const [outgoing, setOutgoing] = useState<OutlineScene | null>(null);
  const [incomingKey, setIncomingKey] = useState(0);
  const initRef = useRef(false);

  useEffect(() => {
    if (recordingCapture) {
      setDisplayed(scene);
      setOutgoing(null);
      return;
    }
    if (initRef.current === false) {
      initRef.current = true;
      return;
    }
    if (scene.index === displayed.index) {
      setDisplayed(scene);
      return;
    }
    setOutgoing(displayed);
    setDisplayed(scene);
    setIncomingKey((k) => k + 1);
    const timer = setTimeout(() => setOutgoing(null), TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [scene, displayed, recordingCapture]);

  const activeScene = recordingCapture ? scene : displayed;
  const dur = sceneDurationSec(activeScene, sceneDurations);
  const cues = useMemo(() => splitNarration(activeScene.narration), [activeScene.narration]);
  const speechDur = dur;
  const ratio = speechDur > 0 ? Math.min(currentTime / speechDur, 1) : 0;
  const clauseIdx = clauseIndexAt(cues, ratio);
  const subtitleText = clauseIdx >= 0 ? cues[clauseIdx]?.text : "";

  return (
    <div
      ref={ref}
      className={
        recordingCapture
          ? "preview-stage relative h-full w-full overflow-hidden bg-black [container-type:size]"
          : "preview-stage relative mx-auto h-full w-full max-h-full max-w-full overflow-hidden rounded-xl bg-black shadow-soft [container-type:size]"
      }
      style={recordingCapture ? undefined : { aspectRatio: exportAspectRatio }}
    >
      {recordingCapture ? (
        <HtmlFrame
          scene={activeScene}
          projectId={projectId}
          videoSize={videoSize}
          sceneDurations={sceneDurations}
          isPlaying={isPlaying}
        />
      ) : (
        <>
          {outgoing && (
            <div
              key={`out-${outgoing.index}`}
              className="frame-fade-out pointer-events-none absolute inset-0"
            >
              <HtmlFrame
                scene={outgoing}
                projectId={projectId}
                videoSize={videoSize}
                sceneDurations={sceneDurations}
                isPlaying={false}
              />
            </div>
          )}
          <div key={`in-${incomingKey}`} className="frame-fade-in absolute inset-0">
            <HtmlFrame
              scene={displayed}
              projectId={projectId}
              videoSize={videoSize}
              sceneDurations={sceneDurations}
              isPlaying={isPlaying}
            />
          </div>
        </>
      )}
      {showSubtitle && subtitleText && (
        <SubtitleOverlay text={subtitleText} clauseKey={clauseIdx} />
      )}
      {!recordingCapture && (
        <div className="absolute left-4 top-4 flex items-center gap-1.5">
          <span className="rounded-md bg-black/40 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
            {activeScene.title}
          </span>
        </div>
      )}
    </div>
  );
});

function HtmlFrame({
  scene,
  projectId,
  videoSize,
  sceneDurations,
  isPlaying,
}: {
  scene: OutlineScene;
  projectId: string;
  videoSize: VideoSize;
  sceneDurations: Record<number, number>;
  isPlaying: boolean;
}) {
  const dur = sceneDurationSec(scene, sceneDurations);
  const src = scene.htmlPath
    ? sceneHtmlUrl(projectId, scene.index, videoSize, dur, isPlaying)
    : null;

  if (!src) {
    return (
      <div className="flex h-full items-center justify-center text-ink-400">
        <div className="text-center">
          <Code2 className="mx-auto h-8 w-8" />
          <p className="mt-2 text-sm">该分镜尚未生成 HTML 动画</p>
        </div>
      </div>
    );
  }

  return (
    <iframe
      key={scene.index}
      title={`分镜 ${scene.index}`}
      src={src}
      sandbox="allow-scripts"
      loading="lazy"
      referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full border-0 bg-black"
    />
  );
}
