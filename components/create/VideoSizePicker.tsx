"use client";

import clsx from "clsx";
import { VIDEO_SIZE_PRESETS, type VideoSize } from "@/lib/exportVideo";

type VideoSizePickerProps = {
  value: VideoSize;
  onChange: (size: VideoSize) => void;
  disabled?: boolean;
  compact?: boolean;
};

/** 视频画幅选择（创建项目 / 生成前设定） */
export function VideoSizePicker({
  value,
  onChange,
  disabled = false,
  compact = false,
}: VideoSizePickerProps) {
  return (
    <div className={clsx("grid gap-1.5", compact ? "grid-cols-2" : "grid-cols-1 sm:grid-cols-2")}>
      {VIDEO_SIZE_PRESETS.map((preset) => {
        const selected = value.width === preset.width && value.height === preset.height;
        return (
          <button
            key={`${preset.width}x${preset.height}`}
            type="button"
            disabled={disabled}
            onClick={() => onChange(preset)}
            className={clsx(
              "rounded-lg border px-3 py-2 text-left transition",
              compact ? "text-[11px]" : "text-[12px]",
              selected
                ? "border-brand-400 bg-brand-50 text-brand-800 ring-1 ring-brand-300"
                : "border-ink-200 bg-white text-ink-700 hover:border-ink-300 hover:bg-ink-50",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}
