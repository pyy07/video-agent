"use client";

import clsx from "clsx";
import { CircleAlert, Film, Loader2, MonitorUp, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { VideoSize } from "@/lib/exportVideo";
import type { ProjectType } from "@/lib/projectTypes";
import { PROJECT_TYPE_LABEL } from "@/lib/projectTypes";

type ExportModalProps = {
  open: boolean;
  onClose: () => void;
  onStart: () => Promise<void>;
  sceneCount: number;
  projectType: ProjectType;
  /** 项目创建/生成时设定的画幅，导出沿用此尺寸 */
  videoSize: VideoSize;
};

type Phase = "ready" | "starting" | "error";

/**
 * 视频导出弹窗。
 * - 图片轮播：隐藏 canvas 逐帧编码，无系统弹窗
 * - HTML 视频：getDisplayMedia 采集预览区（需允许共享当前标签页）
 */
export function ExportModal({
  open,
  onClose,
  onStart,
  sceneCount,
  projectType,
  videoSize,
}: ExportModalProps) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const isHtml = projectType === "html";

  useEffect(() => {
    if (!open) {
      setPhase("ready");
      setErrorMsg(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "starting") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, phase, onClose]);

  if (!open) return null;

  const handleStart = async () => {
    setPhase("starting");
    setErrorMsg(null);
    try {
      await onStart();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setPhase("error");
      setErrorMsg(msg);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        className="absolute inset-0 bg-ink-900/55 backdrop-blur-sm"
        onClick={() => phase !== "starting" && onClose()}
        aria-hidden
      />
      <div className="relative z-10 flex w-[min(540px,92vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-ink-200/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <MonitorUp className="h-4 w-4 text-brand-500" />
            <h2 id="export-modal-title" className="text-sm font-semibold text-ink-900">
              导出视频
            </h2>
            <span className="rounded-md bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-600">
              {PROJECT_TYPE_LABEL[projectType]} · {sceneCount} 镜
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={phase === "starting"}
            aria-label="关闭"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-500 transition hover:bg-ink-100 hover:text-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-lg border border-ink-200 bg-ink-50/60 px-3 py-2.5 text-[12px] text-ink-700">
            输出画幅：<span className="font-medium text-ink-900">{videoSize.label}</span>
            <p className="mt-1 text-[11px] leading-relaxed text-ink-500">
              画幅在项目创建时设定，并与 AI 生成分镜保持一致；导出不再切换比例，避免画面变形。
            </p>
          </div>

          {isHtml ? (
            <>
              <Step
                n={1}
                title="允许共享当前标签页"
                desc={
                  <>
                    点击开始后，浏览器会弹出共享提示，请选择<b>当前标签页</b>并点「共享」。
                    HTML 动画将按预览效果直接录制，支持 SVG、filter、drop-shadow 等全部 CSS 效果。
                  </>
                }
                icon={<MonitorUp className="h-3.5 w-3.5" />}
              />
              <Step
                n={2}
                title="全屏自动播放"
                desc={
                  <>
                    共享成功后预览会全屏播放所有分镜。
                    <b className="text-amber-600">录制期间不要切换标签页</b>，否则画面会暂停。
                  </>
                }
                icon={<Sparkles className="h-3.5 w-3.5" />}
              />
            </>
          ) : (
            <>
              <Step
                n={1}
                title="点开始录制"
                desc={
                  <>
                    点击下方按钮，预览会全屏并从第一镜自动播放。
                    图片轮播在后台 canvas 合成，无需系统弹窗。
                  </>
                }
                icon={<Sparkles className="h-3.5 w-3.5" />}
              />
              <Step
                n={2}
                title="录制中可取消"
                desc="录制中右上角有 ✕ 可随时中止；不操作则自动播完。"
                icon={<Film className="h-3.5 w-3.5" />}
              />
            </>
          )}
          <Step
            n={isHtml ? 3 : 3}
            title="播完自动下载"
            desc="所有分镜播完后，浏览器会自动下载 H.264 MP4 到默认下载目录。"
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
          />

          {errorMsg && (
            <div
              className={clsx(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] leading-relaxed",
                "border-red-200 bg-red-50 text-red-700",
              )}
            >
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-ink-200/70 bg-ink-50/40 px-5 py-3">
          <p className="text-[11px] text-ink-500">
            WebCodecs + mp4-muxer，纯浏览器内编码。
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={phase === "starting"}
              className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:border-ink-300 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleStart}
              disabled={phase === "starting"}
              className="inline-flex items-center gap-1.5 rounded-md bg-brand-gradient px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {phase === "starting" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MonitorUp className="h-3.5 w-3.5" />
              )}
              {phase === "starting" ? "准备录制…" : "开始录制"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  desc,
  icon,
}: {
  n: number;
  title: string;
  desc: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-gradient text-[12px] font-semibold text-white">
        {n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
          <span className="text-brand-500">{icon}</span>
          {title}
        </div>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-600">{desc}</p>
      </div>
    </div>
  );
}
