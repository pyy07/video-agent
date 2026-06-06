"use client";

import clsx from "clsx";
import { CircleAlert, Film, Loader2, MonitorUp, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useState } from "react";

type ExportModalProps = {
  open: boolean;
  onClose: () => void;
  /**
   * 用户点击「开始录制」时调用。父级会切到全屏录制覆盖层、自动播放所有分镜、开始编码。
   * resolve() = 成功；reject(err) = 启动失败（如 canvas 未就绪），由弹窗显示错误。
   */
  onStart: () => Promise<void>;
  /** 总分镜数（弹窗文案展示用） */
  sceneCount: number;
};

type Phase = "ready" | "starting" | "error";

/**
 * 视频导出弹窗（v2：canvas 录制，无系统 picker）。
 *
 * 流程：
 *  1. 用户在 Toolbar 点「视频导出」→ 父级控制 open=true
 *  2. 这个弹窗显示"录制流程"教学
 *  3. 用户点"开始录制" → 父级创建 recorder（基于 canvas）+ 切全屏 + 切录屏模式
 *  4. VideoPreview 从头播放所有分镜；canvas 渲染循环把每帧画到录制画布
 *  5. 播完触发 onRecordingComplete → finalize → 下载 MP4
 */
export function ExportModal({ open, onClose, onStart, sceneCount }: ExportModalProps) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 弹窗关闭时重置
  useEffect(() => {
    if (!open) {
      setPhase("ready");
      setErrorMsg(null);
    }
  }, [open]);

  // ESC 关闭（启动中不允许）
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
      // 成功：父级会自己关弹窗。这里不要做清理。
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
            <h2
              id="export-modal-title"
              className="text-sm font-semibold text-ink-900"
            >
              导出视频
            </h2>
            <span className="rounded-md bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-600">
              共 {sceneCount} 个分镜
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
          <Step
            n={1}
            title="点开始录制"
            desc={
              <>
                点击下方按钮，<b>视频预览会自动全屏</b>并从第一个分镜开始自动播放，
                <b className="text-amber-600">不要中途切换标签页</b>，否则录屏会暂停。
              </>
            }
            icon={<Sparkles className="h-3.5 w-3.5" />}
          />
          <Step
            n={2}
            title="录制中可取消"
            desc={
              <>
                录制中预览右上角有 <b>✕</b> 按钮，随时中止；不点就让它自动播完。
              </>
            }
            icon={<Film className="h-3.5 w-3.5" />}
          />
          <Step
            n={3}
            title="播完自动下载"
            desc="所有分镜播完后，浏览器会自动下载 H.264 MP4 文件到默认下载目录。"
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
            录屏功能基于 WebCodecs + mp4-muxer，纯浏览器内编码，零上传。
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
