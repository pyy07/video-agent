"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createProjectAction } from "@/app/actions";
import type { ProjectType } from "@/lib/projectTypes";
import { DEFAULT_VIDEO_SIZE, type VideoSize } from "@/lib/exportVideo";
import { VideoSizePicker } from "@/components/create/VideoSizePicker";
import {
  HtmlVideoIllustration,
  ImageCarouselIllustration,
  ModeCard,
} from "./ModeCard";

export function CreateModeCards() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeMode, setActiveMode] = useState<ProjectType | null>(null);
  const [videoSize, setVideoSize] = useState<VideoSize>(DEFAULT_VIDEO_SIZE);
  const [error, setError] = useState<{
    mode: ProjectType;
    message: string;
  } | null>(null);

  function handleCreate(mode: ProjectType) {
    if (pending) return;
    setActiveMode(mode);
    setError(null);
    startTransition(async () => {
      const result = await createProjectAction(mode, videoSize);
      if (!result.ok) {
        setError({ mode, message: result.error });
        setActiveMode(null);
        return;
      }
      router.push(`/create?id=${result.uuid}&mode=${mode}`);
    });
  }

  const loadingMode = pending ? activeMode : null;

  return (
    <section className="mt-12 w-full max-w-5xl">
      <div className="mb-6 rounded-2xl border border-white/60 bg-white/80 p-5 shadow-soft backdrop-blur-sm">
        <p className="mb-3 text-sm font-semibold text-ink-900">选择视频画幅</p>
        <VideoSizePicker value={videoSize} onChange={setVideoSize} disabled={pending} />
        <p className="mt-3 text-xs leading-relaxed text-ink-500">
          画幅在创建项目时确定，AI 会按此比例设计分镜与动画；导出时不再切换，避免变形。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ModeCard
          theme="brand"
          recommended
          title="图片轮播模式"
          description="AI 生成精美图片，多图轮播生成视频，适合讲故事、知识科普、营销宣传等场景。"
          features={[
            "文生图 AI 生成图片",
            "多图自动轮播",
            "旁白配音 & 背景音乐",
          ]}
          illustration={<ImageCarouselIllustration />}
          loading={loadingMode === "image"}
          disabled={pending && loadingMode !== "image"}
          error={error?.mode === "image" ? error.message : null}
          onCreate={() => handleCreate("image")}
        />
        <ModeCard
          theme="accent"
          title="HTML 视频模式"
          description="AI 生成网页动画，多动画片段组合成视频，适合数据可视化、产品演示、教育课件等场景。"
          features={[
            "AI 生成网页动画",
            "丰富的动画效果",
            "交互式演示体验",
          ]}
          illustration={<HtmlVideoIllustration />}
          loading={loadingMode === "html"}
          disabled={pending && loadingMode !== "html"}
          error={error?.mode === "html" ? error.message : null}
          onCreate={() => handleCreate("html")}
        />
      </div>
    </section>
  );
}
