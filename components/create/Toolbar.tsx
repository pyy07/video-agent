"use client";

import clsx from "clsx";
import { Maximize2, MoreHorizontal, Pencil, Subtitles, Video } from "lucide-react";
type ToolbarProps = {
  title: string;
  savedLabel: string;
  subtitleOn: boolean;
  onToggleSubtitle: () => void;
  /**
   * 视频导出按钮被点击 —— 父级应该弹出 ExportModal 让用户选共享标签页。
   * disabled 状态下不响应（例如还没有任何分镜）。
   */
  onExportVideo: () => void;
  /** 是否禁用导出按钮（通常在大纲为空时） */
  exportDisabled?: boolean;
};

export function Toolbar({
  title,
  savedLabel,
  subtitleOn,
  onToggleSubtitle,
  onExportVideo,
  exportDisabled,
}: ToolbarProps) {
  return (
    <div className="flex h-full w-full shrink-0 items-center justify-between gap-3 border-b border-ink-200/70 bg-white px-6">
      <div className="flex min-w-0 items-center gap-3">
        <h2 className="truncate text-base font-semibold text-ink-900">{title}</h2>
        <button
          aria-label="重命名"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-400 transition hover:bg-ink-100 hover:text-ink-700"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <span className="hidden truncate text-xs text-ink-400 sm:inline">{savedLabel}</span>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <SubtitleToggle on={subtitleOn} onChange={onToggleSubtitle} />

        <ToolbarButton
          icon={<Maximize2 className="h-3.5 w-3.5" />}
          onClick={() => {
            // 让父组件自己处理：这里用 requestFullscreen 即可
            const el = document.documentElement;
            if (document.fullscreenElement) {
              void document.exitFullscreen();
            } else {
              void el.requestFullscreen?.();
            }
          }}
        >
          全屏
        </ToolbarButton>

        <button
          type="button"
          onClick={onExportVideo}
          disabled={exportDisabled}
          title={exportDisabled ? "请先生成视频大纲" : "把当前视频录屏导出为 MP4"}
          className="inline-flex items-center gap-2 rounded-lg bg-brand-gradient px-4 py-2 text-sm font-medium text-white shadow-glow transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Video className="h-3.5 w-3.5" />
          视频导出
        </button>

        <button
          aria-label="更多"
          className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-600 transition hover:border-ink-300 hover:bg-ink-50"
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="text-xs">更多</span>
        </button>
      </div>
    </div>
  );
}

function ToolbarButton({
  icon,
  children,
  onClick,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 transition hover:border-ink-300 hover:bg-ink-50"
    >
      {icon}
      {children}
    </button>
  );
}

function SubtitleToggle({
  on,
  onChange,
}: {
  on: boolean;
  onChange: () => void;
}) {
  return (
    <button
      onClick={onChange}
      className="inline-flex items-center gap-2 rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-700 transition hover:border-ink-300"
      aria-pressed={on}
    >
      <Subtitles className="h-3.5 w-3.5" />
      <span>字幕</span>
      <span
        className={clsx(
          "relative inline-flex h-4 w-7 items-center rounded-full transition",
          on ? "bg-brand-500" : "bg-ink-200",
        )}
      >
        <span
          className={clsx(
            "absolute h-3 w-3 rounded-full bg-white shadow transition",
            on ? "left-[14px]" : "left-[2px]",
          )}
        />
      </span>
    </button>
  );
}

