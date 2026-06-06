"use client";

import clsx from "clsx";
import {
  Check,
  Code2,
  Film,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import NextImage from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addSceneAction,
  generateProjectAudiosAction,
  regenerateSceneHtmlAction,
  regenerateSceneImageAction,
  updateSceneNarrationAction,
  updateScenePromptAction,
  updateSceneTitleAction,
} from "@/app/actions";
import { PROJECT_TYPE_LABEL } from "@/lib/projectTypes";
import { projectAudioUrl } from "@/lib/audioUrl";
import type { OutlineScene, VideoOutline } from "@/lib/outlineTypes";
import { pickSceneCover } from "./sceneCover";

type OutlineModalProps = {
  outline: VideoOutline;
  projectId: string | null;
  onClose: () => void;
  /**
   * 单分镜被重新生成 / 新增分镜后，把刷新后的 outline 推回去。
   * `newScene` 仅在"添加分镜"成功时给出，便于父级把视图滚到新分镜。
   */
  onOutlineUpdated?: (outline: VideoOutline, newScene?: OutlineScene) => void;
};

export function OutlineModal({
  outline,
  projectId,
  onClose,
  onOutlineUpdated,
}: OutlineModalProps) {
  // ESC 关闭（添加分镜表单展开时不让 ESC 误关弹窗）
  const [addFormOpen, setAddFormOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (addFormOpen) return; // 让表单内的 input 自己处理
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, addFormOpen]);

  // 全局只允许一个分镜的音频在播放：当某个卡片开始播时，关掉之前的
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [regeneratingAudio, setRegeneratingAudio] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);

  const handleRegenerateAllAudio = useCallback(async () => {
    if (!projectId || regeneratingAudio) return;
    setPlayingIndex(null);
    setAudioError(null);
    setRegeneratingAudio(true);
    try {
      const res = await generateProjectAudiosAction(projectId);
      if (!res.ok) {
        setAudioError(res.error);
      } else {
        onOutlineUpdated?.(res.outline);
      }
    } catch (e) {
      setAudioError(e instanceof Error ? e.message : "重新生成失败");
    } finally {
      setRegeneratingAudio(false);
    }
  }, [projectId, regeneratingAudio, onOutlineUpdated]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="outline-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        className="absolute inset-0 bg-ink-900/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 flex h-[88vh] w-[min(960px,92vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-ink-200/70 px-6 py-4">
          <div className="flex items-center gap-2">
            <Film className="h-4 w-4 text-brand-500" />
            <h2
              id="outline-modal-title"
              className="text-base font-semibold text-ink-900"
            >
              完整大纲内容
            </h2>
            <span className="rounded-md bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-700">
              {PROJECT_TYPE_LABEL[outline.mode]}
            </span>
            <span className="text-xs text-ink-500">
              · 共 {outline.scenes.length} 个分镜
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleRegenerateAllAudio}
              disabled={!projectId || regeneratingAudio || outline.scenes.length === 0}
              title="整片旁白一次录音后切分到各分镜，会覆盖所有分镜音频"
              className={clsx(
                "inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition",
                !projectId || regeneratingAudio || outline.scenes.length === 0
                  ? "cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400"
                  : "border-ink-200 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700",
              )}
            >
              {regeneratingAudio ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
              {regeneratingAudio ? "正在合成音频…" : "重新生成音频"}
            </button>
            <button
              type="button"
              onClick={() => setAddFormOpen((v) => !v)}
              disabled={!projectId}
              className={clsx(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition",
                addFormOpen
                  ? "bg-ink-100 text-ink-700"
                  : "bg-brand-gradient text-white shadow-sm hover:opacity-95",
                !projectId && "cursor-not-allowed opacity-50",
              )}
              title={addFormOpen ? "收起添加表单" : "在末尾追加一个新分镜"}
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={2.5} />
              {addFormOpen ? "收起" : "添加分镜"}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="grid h-8 w-8 place-items-center rounded-md text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        {addFormOpen && projectId && (
          <AddSceneForm
            mode={outline.mode}
            onCancel={() => setAddFormOpen(false)}
            onAdded={(next, newScene) => {
              setAddFormOpen(false);
              onOutlineUpdated?.(next, newScene);
            }}
            projectId={projectId}
          />
        )}

        {audioError && (
          <div className="border-b border-amber-200 bg-amber-50/80 px-6 py-2 text-[12px] leading-relaxed text-amber-700">
            {audioError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <ol className="space-y-4">
            {outline.scenes.map((scene) => (
              <li key={scene.index}>
                <SceneCard
                  scene={scene}
                  projectId={projectId}
                  mode={outline.mode}
                  audioGeneratedAt={outline.audioGeneratedAt}
                  audioRegenerating={regeneratingAudio}
                  isPlaying={playingIndex === scene.index}
                  onPlayingChange={(playing) =>
                    setPlayingIndex(playing ? scene.index : null)
                  }
                  onOutlineUpdated={onOutlineUpdated}
                />
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

/* ===========================================================================
 * SceneCard
 * ========================================================================= */

type SceneCardProps = {
  scene: OutlineScene;
  projectId: string | null;
  mode: import("@/lib/projectTypes").ProjectType;
  audioGeneratedAt?: string;
  audioRegenerating?: boolean;
  isPlaying: boolean;
  onPlayingChange: (playing: boolean) => void;
  onOutlineUpdated?: (outline: VideoOutline) => void;
};

type RegenKind = "image" | "html" | null;

function SceneCard({
  scene,
  projectId,
  mode,
  audioGeneratedAt,
  audioRegenerating = false,
  isPlaying,
  onPlayingChange,
  onOutlineUpdated,
}: SceneCardProps) {
  const isHtmlMode = mode === "html";
  const [regenerating, setRegenerating] = useState<RegenKind>(null);
  const [error, setError] = useState<string | null>(null);
  // 用一个 cache-busting nonce 强制图片/HTML 刷新（重生后路径不变）
  const [imageNonce, setImageNonce] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const hasImage = Boolean(scene.imagePath);
  const hasHtml = Boolean(scene.htmlPath);
  const imageUrl =
    hasImage && projectId
      ? `/api/project-images/${projectId}/${scene.index}.png?v=${imageNonce}`
      : null;
  const htmlUrl =
    hasHtml && projectId
      ? `/api/project-scenes/${projectId}/${scene.index}.html?v=${imageNonce}`
      : null;
  const audioUrl =
    scene.audioPath && projectId
      ? projectAudioUrl(projectId, scene.index, audioGeneratedAt)
      : null;

  // 音频版本变化时停止播放
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [audioUrl]);

  // 父级要求停止（别的卡片开始播了）→ 暂停自己的 audio
  useEffect(() => {
    if (!isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
    }
  }, [isPlaying]);

  // 卡片卸载时停掉音频
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const handleTogglePlay = useCallback(() => {
    if (!audioUrl) return;
    if (isPlaying) {
      // 关掉
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      onPlayingChange(false);
      return;
    }
    // 开始播。每次都新建一个 Audio 以避开 cache-busting 后 src 改变的边界
    if (audioRef.current) audioRef.current.pause();
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.addEventListener("ended", () => onPlayingChange(false));
    audio.addEventListener("error", () => {
      setError("音频播放失败");
      onPlayingChange(false);
    });
    audio.play().catch(() => {
      setError("音频播放失败");
      onPlayingChange(false);
    });
    onPlayingChange(true);
  }, [audioUrl, isPlaying, onPlayingChange]);

  const handleRegenerateImage = useCallback(async () => {
    if (!projectId || regenerating) return;
    setError(null);
    setRegenerating("image");
    try {
      const res = isHtmlMode
        ? await regenerateSceneHtmlAction(projectId, scene.index)
        : await regenerateSceneImageAction(projectId, scene.index);
      if (!res.ok) {
        setError(res.error);
      } else {
        setImageNonce((n) => n + 1);
        onOutlineUpdated?.(res.outline);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "重新生成失败");
    } finally {
      setRegenerating(null);
    }
  }, [projectId, regenerating, scene.index, isHtmlMode, onOutlineUpdated]);

  /**
   * 手动编辑文本字段的统一入口：标题 / 旁白 / 画面提示词。
   * 调对应 action，把服务端最新 outline 推给父级，弹窗内部状态也随之刷新。
   * 错误时把消息回写到卡片底部 error 条，已存在。
   */
  const commitField = useCallback(
    async (field: "title" | "narration" | "prompt", next: string) => {
      if (!projectId) return;
      const trimmed = next.trim();
      if (trimmed.length === 0) {
        setError("内容不能为空");
        return;
      }
      setError(null);
      try {
        const res =
          field === "title"
            ? await updateSceneTitleAction(projectId, scene.index, next)
            : field === "narration"
            ? await updateSceneNarrationAction(projectId, scene.index, next)
            : await updateScenePromptAction(projectId, scene.index, next);
        if (!res.ok) {
          setError(res.error);
        } else {
          onOutlineUpdated?.(res.outline);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "保存失败");
      }
    },
    [projectId, scene.index, onOutlineUpdated],
  );

  const busy = regenerating !== null || audioRegenerating;

  return (
    <article className="overflow-hidden rounded-2xl border border-ink-200/70 bg-white shadow-soft">
      <div className="flex flex-col md:flex-row">
        {/* 画面区 */}
        <div
          className="relative h-[180px] w-full shrink-0 md:h-auto md:min-h-[220px] md:w-[260px]"
          style={
            isHtmlMode
              ? !htmlUrl
                ? { backgroundImage: pickSceneCover(scene.index) }
                : undefined
              : !imageUrl
              ? { backgroundImage: pickSceneCover(scene.index) }
              : undefined
          }
          aria-label={`分镜 ${scene.index} ${isHtmlMode ? "动画" : "画面"}`}
        >
          {isHtmlMode ? (
            htmlUrl ? (
              <iframe
                key={htmlUrl}
                src={htmlUrl}
                title={`分镜 ${scene.index} 网页动画`}
                className="absolute inset-0 h-full w-full border-0"
                sandbox="allow-scripts allow-same-origin"
                tabIndex={-1}
              />
            ) : (
              <div className="absolute inset-0 grid place-items-center">
                <div className="rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-medium text-ink-700 shadow-soft">
                  动画待生成
                </div>
              </div>
            )
          ) : imageUrl ? (
            <NextImage
              src={imageUrl}
              alt={`分镜 ${scene.index} 画面`}
              fill
              className="object-cover"
              unoptimized
              sizes="260px"
              key={imageUrl}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <div className="rounded-full bg-white/85 px-2.5 py-1 text-[11px] font-medium text-ink-700 shadow-soft">
                画面待生成
              </div>
            </div>
          )}

          {/* 重新生成视觉资源 loading 蒙层 */}
          {regenerating === "image" && (
            <div className="absolute inset-0 grid place-items-center bg-black/45 text-white">
              <div className="flex flex-col items-center gap-1.5">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-[11px]">
                  {isHtmlMode ? "正在重新生成动画…" : "正在重新生成画面…"}
                </span>
              </div>
            </div>
          )}

          {/* 左上序号 */}
          <span className="absolute left-3 top-3 grid h-6 min-w-6 place-items-center rounded-md bg-black/55 px-1.5 text-[11px] font-semibold tabular-nums text-white">
            #{scene.index}
          </span>

          {/* 右下喇叭按钮 */}
          {audioUrl && (
            <button
              type="button"
              onClick={handleTogglePlay}
              disabled={busy}
              aria-label={isPlaying ? "停止播放" : "试听旁白音频"}
              className={clsx(
                "absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-full shadow-md transition",
                isPlaying
                  ? "bg-brand-500 text-white hover:bg-brand-600"
                  : "bg-white/95 text-ink-700 hover:bg-white",
                busy && "cursor-not-allowed opacity-60",
              )}
            >
              {isPlaying ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </button>
          )}
        </div>

        {/* 文本 + 操作区 */}
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
          <EditableField
            label="分镜标题"
            value={scene.title}
            maxLength={80}
            disabled={busy || !projectId}
            className="text-sm font-semibold text-ink-900"
            onCommit={(next) => commitField("title", next)}
          />

          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
              分镜旁白
            </div>
            <EditableField
              label="分镜旁白"
              value={scene.narration}
              maxLength={1000}
              multiline
              disabled={busy || !projectId}
              className="text-sm leading-relaxed text-ink-700"
              onCommit={(next) => commitField("narration", next)}
            />
          </div>

          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-ink-400">
              {isHtmlMode ? "动画规格" : "画面提示词"}
            </div>
            <EditableField
              label={isHtmlMode ? "动画规格" : "画面提示词"}
              value={scene.prompt}
              maxLength={2000}
              multiline
              monospace
              className="text-[12px] leading-relaxed text-ink-700"
              onCommit={(next) => commitField("prompt", next)}
            />
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="rounded-md border border-amber-200 bg-amber-50/80 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-700">
              {error}
            </div>
          )}

          {/* 重新生成按钮组（画面/动画按分镜；音频在弹窗顶部整片重生） */}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleRegenerateImage}
              disabled={busy || !projectId}
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition",
                busy || !projectId
                  ? "cursor-not-allowed border-ink-200 bg-ink-50 text-ink-400"
                  : "border-ink-200 bg-white text-ink-700 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700",
              )}
            >
              {regenerating === "image" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isHtmlMode ? (
                <Code2 className="h-3.5 w-3.5" />
              ) : (
                <ImageIcon className="h-3.5 w-3.5" />
              )}
              {isHtmlMode ? "重新生成动画" : "重新生成画面"}
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}

/* ===========================================================================
 * EditableField —— 通用"显示态 / 编辑态"切换的可编辑文本
 *
 * 用法：
 *   <EditableField
 *     label="分镜标题"          // 隐藏，仅用于 aria / tooltip
 *     value={scene.title}      // 受控显示文本
 *     maxLength={80}
 *     onCommit={async (next) => ...}   // 用户失焦/回车时触发
 *     disabled={...}           // 业务忙时禁用编辑
 *     multiline                // textarea；缺省为 input
 *     monospace                // 字体（提示词用）
 *   />
 *
 * 设计：
 *  - 显示态展示 value；hover 时露出铅笔图标提示"可点击编辑"
 *  - 点击进入编辑态：input 或 textarea（multiline）
 *  - 失焦 / Ctrl+Enter（textarea）→ commit
 *  - Esc → 取消
 *  - commit 进行中显示 spinner；失败时由 onCommit 上层处理（这里只透传）
 *  - 外部 value 变化（如父级再生旁白后通过 outline 推过来）时同步显示态
 * ========================================================================= */

type EditableFieldProps = {
  label: string;
  value: string;
  onCommit: (next: string) => void | Promise<void>;
  maxLength?: number;
  multiline?: boolean;
  monospace?: boolean;
  disabled?: boolean;
  /** 自定义最外层显示态的 className（控制字号/颜色/字重），编辑态会忽略它 */
  className?: string;
};

/* ===========================================================================
 * AddSceneForm —— 大纲弹窗内"添加分镜"表单
 *
 * 三个必填字段（title / narration / prompt），都不允许空串。
 * 提交成功 → 调 onAdded 回调把新 outline 交给父级（同时会自动关闭表单）；
 * 失败 → 错误条回显，不关闭表单，让用户改正后再试。
 * ========================================================================= */

type AddSceneFormProps = {
  projectId: string;
  mode: import("@/lib/projectTypes").ProjectType;
  onAdded: (next: VideoOutline, newScene: OutlineScene) => void;
  onCancel: () => void;
};

function AddSceneForm({ projectId, mode, onAdded, onCancel }: AddSceneFormProps) {
  const [title, setTitle] = useState("");
  const [narration, setNarration] = useState("");
  const [prompt, setPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  // 打开时自动 focus 第一个输入
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const canSubmit =
    title.trim().length > 0 &&
    narration.trim().length > 0 &&
    prompt.trim().length > 0 &&
    !saving;

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const res = await addSceneAction(projectId, { title, narration, prompt });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onAdded(res.outline, res.scene);
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加分镜失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="border-b border-ink-200/70 bg-ink-50/60 px-6 py-4"
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-900">
          <Plus className="h-4 w-4 text-brand-500" />
          添加分镜
        </div>
        <span className="text-[11px] text-ink-500">
          新分镜将追加到末尾，序号自动递增
        </span>
      </div>

      <div className="space-y-2">
        <FieldRow label="分镜标题" required>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：协议集合"
            maxLength={80}
            className="w-full rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm text-ink-900 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
          />
        </FieldRow>
        <FieldRow label="分镜旁白" required>
          <textarea
            value={narration}
            onChange={(e) => setNarration(e.target.value)}
            placeholder="例如：TCP/IP 是一组协议的集合，它像一套严谨的物流系统。"
            maxLength={1000}
            rows={2}
            className="w-full resize-y rounded-md border border-ink-200 bg-white px-2.5 py-1.5 text-sm leading-relaxed text-ink-900 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
          />
        </FieldRow>
        <FieldRow label={mode === "html" ? "动画规格" : "画面提示词"} required>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={mode === "html" ? "中文网页动画规格：元素 / 动作 / 缓动 / 时长" : "英文图片生成 prompt：subject / style / lighting / composition / palette"}
            maxLength={2000}
            rows={3}
            className="w-full resize-y rounded-md border border-ink-200 bg-white px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-ink-900 outline-none focus:border-brand-300 focus:ring-2 focus:ring-brand-100"
          />
        </FieldRow>
      </div>

      {error && (
        <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/80 px-2.5 py-1.5 text-[12px] leading-relaxed text-amber-700">
          {error}
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:border-ink-300 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          取消
        </button>
        <button
          type="submit"
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-gradient px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {saving ? "添加中…" : "添加"}
        </button>
      </div>
    </form>
  );
}

function FieldRow({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-ink-500">
        {label}
        {required && <span className="text-red-500">*</span>}
      </span>
      {children}
    </label>
  );
}

function EditableField({
  label,
  value,
  onCommit,
  maxLength,
  multiline,
  monospace,
  disabled,
  className,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 外部 value 变化（父级重新生成了文本、revalidate 推送等）→ 同步显示态
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  const beginEdit = () => {
    if (disabled) return;
    setDraft(value);
    setEditing(true);
  };

  const commit = async () => {
    const next = draft;
    // 没变就只退出编辑
    if (next === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onCommit(next);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  // 进入编辑态后自动 focus + 选中文本
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (editing) {
    const baseBox = clsx(
      "mt-0.5 w-full rounded-md border border-brand-300 bg-white px-2 py-1 outline-none",
      "focus:border-brand-400 focus:ring-2 focus:ring-brand-100",
      monospace ? "font-mono text-[12px] leading-relaxed" : "text-sm",
      multiline && "min-h-[60px] resize-y",
    );
    return (
      <div>
        {multiline ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            value={draft}
            maxLength={maxLength}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                commit();
              }
            }}
            aria-label={label}
            className={baseBox}
          />
        ) : (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            value={draft}
            maxLength={maxLength}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              } else if (e.key === "Enter") {
                e.preventDefault();
                commit();
              }
            }}
            aria-label={label}
            className={clsx(baseBox, "h-7")}
          />
        )}
        {saving && (
          <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-600">
            <Loader2 className="h-3 w-3 animate-spin" />
            保存中…
          </span>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={beginEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          beginEdit();
        }
      }}
      disabled={disabled}
      title={disabled ? "不可编辑" : `点击编辑${label}`}
      aria-label={`编辑${label}`}
      className={clsx(
        "group/edit flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-left transition",
        !disabled && "hover:bg-ink-50",
        disabled && "cursor-not-allowed",
      )}
    >
      <span className={clsx("min-w-0 flex-1 break-words", className)}>
        {value}
      </span>
      {!disabled && (
        <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-ink-300 opacity-0 transition group-hover/edit:opacity-100" />
      )}
    </button>
  );
}
