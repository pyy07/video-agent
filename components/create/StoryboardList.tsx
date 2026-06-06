"use client";

import clsx from "clsx";
import { BarChart3, Code2, Eye, ImageIcon, Loader2, MoreHorizontal, Plus, Sparkles, Volume2, Wand2, X } from "lucide-react";
import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { pickSceneCover } from "./sceneCover";
import { projectAudioUrl } from "@/lib/audioUrl";
import type { OutlineScene } from "@/lib/outlineTypes";
import type { ProjectType } from "@/lib/projectTypes";

type StoryboardListProps = {
  scenes: OutlineScene[];
  activeSceneId: string | null;
  onSelectScene: (id: string) => void;
  /** 大纲是否存在（控制按钮显示） */
  hasOutline: boolean;
  /**正在生成图片的分镜序号（null 表示没有） */
  generatingSceneIndex: number | null;
  /** 单个分镜生成按钮点击 */
  onGenerateScene: (sceneIndex: number) => void;
  /** 项目 ID（用于拼接图片路径） */
  projectId: string | null;
  /** 项目模式（image / html），决定预览和按钮文案 */
  projectType: ProjectType;
  /** 一键生成进度：current/total（任务以"画面/音频"为粒度计数） */
  bulkProgress: { current: number; total: number } | null;
  /** 一键生成按钮回调（再次点击触发取消） */
  onBulkGenerate: () => void;
  /** 打开"完整大纲内容"弹窗（"查看大纲内容"按钮用） */
  onOpenOutlineModal: () => void;
  /** 底栏模式：固定高度容器内紧凑展示 */
  dock?: boolean;
  /** 最近一次整片音频生成时间，用于 cache bust */
  audioGeneratedAt?: string;
};

const CHARS_PER_SECOND = 4;

export function StoryboardList({
  scenes,
  activeSceneId,
  onSelectScene,
  hasOutline,
  generatingSceneIndex,
  onGenerateScene,
  projectId,
  projectType,
  bulkProgress,
  onBulkGenerate,
  onOpenOutlineModal,
  dock = false,
  audioGeneratedAt,
}: StoryboardListProps) {
  const isHtmlMode = projectType === "html";

  // 缺失任务数：
  //  - image 模式：缺图算 1、缺音算 1（同一镜两样都缺算 2）
  //  - html 模式：缺 HTML 动画算 1、缺音算 1（同一镜两样都缺算 2）
  const missingCount = useMemo(() => {
    let n = 0;
    for (const s of scenes) {
      if (isHtmlMode) {
        if (!s.htmlPath) n++;
      } else {
        if (!s.imagePath) n++;
      }
      if (!s.audioPath) n++;
    }
    return n;
  }, [scenes, isHtmlMode]);

  /**
   * 资源 cache-buster：大纲被服务端刷新（chat 回了新大纲、编辑弹窗里重新生成了
   * 画面/HTML/音频等）时自增一次，append 到所有资源 URL 的 query string 上。
   * 理由：同一分镜图片/HTML 覆盖后路径字段不变（都是 images/N.png 或 scenes/N.html），
   * 光改服务端 ETag 不够稳，加 ?v=N 后 URL 变化强制浏览器重新拉。
   * 只在父级传入的 scenes 引用变化时自增，平时不浪费请求。
   */
  const [imageNonce, setImageNonce] = useState(0);
  const lastScenesRef = useRef<OutlineScene[]>(scenes);
  useEffect(() => {
    if (lastScenesRef.current !== scenes) {
      lastScenesRef.current = scenes;
      setImageNonce((n) => n + 1);
    }
  }, [scenes]);

  const isBulking = bulkProgress !== null;
  const bulkDisabled = !hasOutline || !projectId || (!isBulking && missingCount === 0) ||
    (generatingSceneIndex !== null && !isBulking);

  if (scenes.length === 0 && !dock) {
    return <EmptyState />;
  }

  return (
    <div
      className={clsx(
        "rounded-2xl border border-ink-200/70 bg-white shadow-soft",
        dock ? "flex h-full min-h-0 flex-col overflow-hidden p-3" : "p-4",
      )}
    >
      <div className={clsx("flex shrink-0 items-center justify-between", dock ? "mb-2" : "mb-3")}>
        <h3 className="text-sm font-semibold text-ink-900">
          分镜列表{" "}
          {scenes.length > 0 ? (
            <span className="text-ink-400">（共 {scenes.length} 个分镜）</span>
          ) : null}
        </h3>
        <div className="flex items-center gap-1.5 text-xs">
          {/* 一键生成按钮 */}
          {hasOutline && (
            <button
              type="button"
              onClick={onBulkGenerate}
              disabled={bulkDisabled}
              title={
                isBulking
                  ? "点击取消生成"
                  : missingCount === 0
                  ? isHtmlMode
                    ? "所有分镜的动画和音频都已生成"
                    : "所有分镜的画面和音频都已生成"
                  : isHtmlMode
                  ? `还有 ${missingCount} 项待生成（动画 + 音频）`
                  : `还有 ${missingCount} 项待生成（画面 + 音频）`
              }
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition",
                isBulking
                  ? "bg-amber-50 text-amber-700 hover:bg-amber-100"
                  : missingCount === 0
                  ? "cursor-not-allowed bg-ink-50 text-ink-400"
                  : "bg-brand-gradient text-white shadow-sm hover:opacity-90",
                bulkDisabled && !isBulking && "cursor-not-allowed opacity-60",
              )}
            >
              {isBulking ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  生成中 {bulkProgress!.current}/{bulkProgress!.total}
                  <X className="h-3 w-3 opacity-70" />
                </>
              ) : (
                <>
                  <Wand2 className="h-3.5 w-3.5" />
                  一键生成
                  {missingCount > 0 && (
                    <span className="rounded-full bg-white/25 px-1.5 text-[10px] tabular-nums">
                      {missingCount}
                    </span>
                  )}
                </>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={onOpenOutlineModal}
            disabled={!hasOutline}
            className={clsx(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium transition",
              hasOutline
                ? "text-brand-600 hover:bg-brand-50"
                : "cursor-not-allowed text-ink-300",
            )}
            title={hasOutline ? "查看完整大纲内容" : "暂无大纲"}
          >
            <Eye className="h-3.5 w-3.5" />
            查看大纲内容
          </button>
          <button
            aria-label="更多"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className={clsx("-mx-1 overflow-x-auto pb-1", dock && "min-h-0 flex-1")}>
        {scenes.length === 0 ? (
          <DockEmptyState />
        ) : (
        <ul className="flex gap-3 px-1">
          {scenes.map((scene) => (
            <li key={scene.index} className="shrink-0">
              <StoryboardCard
                scene={scene}
                active={`s-${scene.index}` === activeSceneId}
                onClick={() => onSelectScene(`s-${scene.index}`)}
                projectId={projectId}
                hasOutline={hasOutline}
                isGenerating={generatingSceneIndex === scene.index}
                isBulking={isBulking}
                onGenerate={() => onGenerateScene(scene.index)}
                imageNonce={imageNonce}
                projectType={projectType}
                audioGeneratedAt={audioGeneratedAt}
              />
            </li>
          ))}
        </ul>
        )}
      </div>
    </div>
  );
}

type StoryboardCardProps = {
  scene: OutlineScene;
  active: boolean;
  onClick: () => void;
  projectId: string | null;
  hasOutline: boolean;
  isGenerating: boolean;
  /** 是否正处于一键生成的批处理中（单镜按钮要禁用） */
  isBulking: boolean;
  onGenerate: () => void;
  /** 大纲版本戳，附加到图片 URL 上强制刷新 */
  imageNonce: number;
  projectType: ProjectType;
  audioGeneratedAt?: string;
};

function StoryboardCard({
  scene,
  active,
  onClick,
  projectId,
  hasOutline,
  isGenerating,
  isBulking,
  onGenerate,
  imageNonce,
  projectType,
  audioGeneratedAt,
}: StoryboardCardProps) {
  const isHtmlMode = projectType === "html";
  const cover = pickSceneCover(scene.index);
  const hasImage = Boolean(scene.imagePath);
  const hasHtml = Boolean(scene.htmlPath);
  const hasAudio = Boolean(scene.audioPath);
  // 视觉资源是否"已有"：image 模式看 imagePath，html 模式看 htmlPath
  const hasVisual = isHtmlMode ? hasHtml : hasImage;
  const isComplete = hasVisual && hasAudio;
  const needVisual = !hasVisual;
  const needAudio = !hasAudio;
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const imageUrl = hasImage && projectId
    ? `/api/project-images/${projectId}/${scene.index}.png?v=${imageNonce}`
    : null;

  const htmlUrl = hasHtml && projectId
    ? `/api/project-scenes/${projectId}/${scene.index}.html?v=${imageNonce}`
    : null;

  const audioUrl = hasAudio && projectId
    ? projectAudioUrl(projectId, scene.index, audioGeneratedAt)
    : null;

  // 音频版本变化时重置播放器，避免继续播旧缓存
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [audioUrl]);

  const handleAudioClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!audioUrl) return;
    if (audioRef.current) {
      audioRef.current.play();
    }
  };

  return (
    <div className="group flex w-[112px] flex-col items-stretch">
      {/* 预览区域 */}
      <button
        onClick={onClick}
        className={clsx(
          "relative h-[72px] w-full overflow-hidden rounded-lg transition",
          active
            ? "ring-2 ring-brand-500 ring-offset-2 ring-offset-white"
            : "ring-1 ring-ink-200 group-hover:ring-ink-300",
        )}
      >
        {isHtmlMode ? (
          htmlUrl ? (
            // HTML 动画：用 iframe 嵌入，自动循环播放。
            // pointer-events-none 让点击穿透到外层 button，便于点击切镜。
            <iframe
              key={htmlUrl}
              src={htmlUrl}
              title={`分镜 ${scene.index} 网页动画`}
              className="pointer-events-none absolute inset-0 h-full w-full border-0"
              // 沙箱：允许脚本、动画、style，但不允许弹窗/顶级导航/同源访问
              sandbox="allow-scripts allow-same-origin"
              tabIndex={-1}
            />
          ) : (
            <div className="absolute inset-0" style={{ backgroundImage: cover }} />
          )
        ) : imageUrl ? (
          <Image
            src={imageUrl}
            alt={`分镜 ${scene.index}画面`}
            fill
            className="object-cover"
            unoptimized
          />
        ) : (
          <div className="absolute inset-0" style={{ backgroundImage: cover }} />
        )}
        <span className="absolute left-1.5 top-1.5 grid h-5 min-w-5 place-items-center rounded-md bg-black/55 px-1 text-[10px] font-semibold text-white">
          {scene.index}
        </span>
        {/* 模式徽章（HTML 模式才显示） */}
        {isHtmlMode && hasHtml && (
          <span
            title="HTML 动画"
            className="absolute left-1.5 bottom-1.5 grid h-4 w-4 place-items-center rounded-md bg-teal-500/90 text-white"
          >
            <Code2 className="h-2.5 w-2.5" />
          </span>
        )}
        {/* 音频按钮 */}
        {hasAudio && audioUrl && (
          <span
            onClick={handleAudioClick}
            className="absolute right-1.5 top-1.5 grid h-5 w-5 cursor-pointer place-items-center rounded-md bg-orange-500/90 text-white transition hover:bg-orange-500"
          >
            <Volume2 className="h-3 w-3" />
          </span>
        )}
        {!hasAudio && (
          <span className="absolute right-1.5 top-1.5 grid h-5 w-5 place-items-center rounded-md bg-black/40 text-white/50">
            <Volume2 className="h-3 w-3" />
          </span>
        )}
        {active && !hasAudio && !isHtmlMode && (
          <span className="absolute bottom-1.5 left-1.5 grid h-5 w-5 place-items-center rounded-md bg-white/85 text-brand-600">
            <BarChart3 className="h-3 w-3" />
          </span>
        )}
        <span className="absolute bottom-1.5 right-1.5 rounded-sm bg-black/60 px-1 py-[1px] text-[10px] tabular-nums text-white">
          {formatDuration(scene.narration.length)}
        </span>
        {/* 隐藏 audio 元素 */}
        {audioUrl && <audio ref={audioRef} src={audioUrl} />}
      </button>

      {/* 标题 + 生成按钮 */}
      <div className="mt-2 flex flex-col items-center gap-1">
        <span
          className={clsx(
            "truncate text-center text-xs",
            active ? "font-semibold text-brand-700" : "text-ink-600",
          )}
        >
          {scene.title}
        </span>
        {/* 缺失项才会显示"生成"按钮。已全部生成的，分镜卡片不再提供入口——
            重新生成（覆盖已有素材）请到「完整大纲内容」弹窗里操作。 */}
        {hasOutline && !isComplete && (
          <button
            onClick={(e) => { e.stopPropagation(); onGenerate(); }}
            disabled={isGenerating || isBulking}
            title={generateButtonTitle(needVisual, needAudio, isHtmlMode)}
            className={clsx(
              "flex items-center gap-1 rounded-full bg-brand-gradient px-3 py-1 text-[10px] font-medium text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60",
              isGenerating && "animate-pulse",
            )}
          >
            {isGenerating ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin" />
            ) : isHtmlMode ? (
              <Code2 className="h-2.5 w-2.5" />
            ) : (
              <ImageIcon className="h-2.5 w-2.5" />
            )}
            {isGenerating ? "生成中…" : generateButtonLabel(needVisual, needAudio, isHtmlMode)}
          </button>
        )}
      </div>
    </div>
  );
}

/** 缺失项不同，按钮文案要告诉用户会生成什么。 */
function generateButtonLabel(needVisual: boolean, needAudio: boolean, isHtmlMode: boolean): string {
  if (needVisual && needAudio) return "生成";
  if (needVisual) return isHtmlMode ? "生成动画" : "生成画面";
  return "生成音频";
}

function generateButtonTitle(needVisual: boolean, needAudio: boolean, isHtmlMode: boolean): string {
  if (needVisual && needAudio) {
    return isHtmlMode
      ? "仅补缺失的动画和音频（不会重做已有素材）"
      : "仅补缺失的画面和音频（不会重做已有素材）";
  }
  if (needVisual) {
    return isHtmlMode
      ? "仅补缺失的网页动画（不会重做已有音频）"
      : "仅补缺失的画面（不会重做已有音频）";
  }
  return "仅补缺失的音频（不会重做已有画面）";
}

function formatDuration(narrationChars: number): string {
  const seconds = Math.max(6, Math.round(narrationChars / CHARS_PER_SECOND));
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function DockEmptyState() {
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center px-4 text-center">
      <div className="grid h-8 w-8 place-items-center rounded-lg bg-brand-50 text-brand-500">
        <Sparkles className="h-4 w-4" />
      </div>
      <p className="mt-2 text-xs font-medium text-ink-700">还没有分镜</p>
      <p className="mt-1 max-w-xs text-[11px] leading-relaxed text-ink-400">
        在右侧 AI 助手中输入创作想法，AI 会自动生成脚本与分镜大纲
      </p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-ink-300 bg-white/60 p-6 text-center">
      <div className="mx-auto grid h-10 w-10 place-items-center rounded-xl bg-brand-50 text-brand-500">
        <Sparkles className="h-5 w-5" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-ink-900">还没有分镜</h3>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-ink-500">
        在右侧 AI 助手中输入你的创作想法，例如「帮我做一个关于宇宙探索的科普视频」，
        AI 会自动生成完整的脚本与分镜大纲。
      </p>
    </div>
  );
}