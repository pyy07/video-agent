"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type HtmlExportStatus =
  | "idle"
  | "preparing"
  | "prompting"
  | "countdown"
  | "recording"
  | "finalizing"
  | "failed";

interface ExportRecordingOverlayProps {
  open: boolean;
  status: HtmlExportStatus;
  message: string;
  countdown: number;
}

/** 录制倒计时/提示层（录制进度在独立 popup，避免进入录屏画面） */
export function ExportRecordingOverlay({
  open,
  status,
  message,
  countdown,
}: ExportRecordingOverlayProps) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  if (!open || !mounted || status === "recording" || status === "finalizing") return null;

  const label =
    status === "countdown"
      ? "录屏即将开始"
      : status === "prompting"
        ? "请在弹窗中选择当前标签页"
        : "正在准备录制";

  const overlayContent = (
    <div className="pointer-events-none fixed left-6 top-6 z-[2147483647] flex justify-start">
      <div className="w-[300px] rounded-2xl border border-ink-700 bg-ink-950/92 px-5 py-4 text-white shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col items-center text-center">
          <div className="mb-3 h-3 w-3 animate-pulse rounded-full bg-red-500" />
          <div className="mb-2 rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
            MP4 (H.264)
          </div>
          <div className="text-sm text-slate-300">{label}</div>
          {status === "countdown" && (
            <div className="mt-4 text-5xl font-semibold tabular-nums">{countdown}</div>
          )}
          {message ? <div className="mt-3 text-xs text-slate-400">{message}</div> : null}
        </div>
      </div>
    </div>
  );

  return createPortal(overlayContent, document.body);
}
