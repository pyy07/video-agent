"use client";

import clsx from "clsx";
import {
  AlertCircle,
  CircleHelp,
  Eye,
  Film,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { sendPromptAction } from "@/app/actions";
import type { PersistedChatMessage } from "@/lib/chatTypes";
import type { VideoOutline } from "@/lib/outlineTypes";
import { PROJECT_TYPE_LABEL } from "@/lib/projectTypes";
import { WORKSPACE_BOTTOM_DOCK_HEIGHT } from "@/lib/workspaceLayout";

type AIChatProps = {
  projectId: string | null;
  initialHistory: PersistedChatMessage[];
  loading: boolean;
  /**
   * 当前实时大纲（含 imagePath/audioPath）。
   * 用户点 outline 消息上的"查看完整大纲"时，如果 chat message 里的 outline 是
   * 旧快照（生成时刻、还没生图），我们优先用 liveOutline 打开弹窗，让用户能看到
   * 已经生成的画面/音频和走再生流程。
   */
  liveOutline: VideoOutline | null;
  onNewHistory: (
    messages: PersistedChatMessage[],
    outline?: VideoOutline,
    projectTitle?: string,
  ) => void;
  /**
   * 打开大纲弹窗。AIChat 不再自己持有弹窗状态，由父级 CreatePageClient 统一管理。
   * `outline` 参数：消息里带的历史 outline（可能比 live outline 旧）。
   */
  onOpenOutlineModal: (outline: VideoOutline) => void;
  /** 与左侧分镜列表底栏对齐的统一高度 */
  bottomDockHeight?: number;
  /** 顶栏由 SplitWorkspace 统一渲染时设为 true */
  hideHeader?: boolean;
};

const PENDING_BUBBLE_KEY = "__pending__";

export function AIChat({
  projectId,
  initialHistory,
  loading,
  liveOutline,
  onNewHistory,
  onOpenOutlineModal,
  bottomDockHeight = WORKSPACE_BOTTOM_DOCK_HEIGHT,
  hideHeader = false,
}: AIChatProps) {
  const [input, setInput] = useState("");
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollSentinelRef = useRef<HTMLDivElement>(null);
  // 用 ref 跟踪「当前激活项目」—— 闭包里的 projectId 在异步回调执行时是旧值
  const activeProjectIdRef = useRef(projectId);
  useEffect(() => {
    activeProjectIdRef.current = projectId;
  }, [projectId]);

  // 新消息或 pending 状态变化时，自动滚到底部
  useEffect(() => {
    const el = scrollSentinelRef.current;
    if (!el) return;
    el.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [initialHistory.length, isPending]);

  // 错误 toast 3 秒自动消失
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(id);
  }, [toast]);

  const disabled = !projectId || loading;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!projectId) return;
    const text = input.trim();
    if (text.length === 0 || isPending) return;
    setInput("");

    // 捕获发送时的 projectId；响应回来时若用户已切走，则丢弃
    const submittedFor = projectId;
    startTransition(async () => {
      const result = await sendPromptAction(submittedFor, text);
      if (activeProjectIdRef.current !== submittedFor) return;
      const nextOutline = result.ok ? result.outline : undefined;
      const nextTitle = result.ok ? result.projectTitle : undefined;
      onNewHistory(result.messages, nextOutline, nextTitle);
      if (!result.ok) {
        setToast(result.error);
      }
    });
  }

  return (
    <aside className="flex h-full min-h-0 w-full shrink-0 flex-col overflow-hidden bg-ink-50">
      {!hideHeader ? <AIChatHeader /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-3">
        {toast ? (
          <div
            role="alert"
            className="mb-2 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-700"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{toast}</span>
          </div>
        ) : null}
        <ul className="space-y-3">
          {initialHistory.length === 0 && !isPending && !loading ? (
            <li>
              <GreetingBubble />
            </li>
          ) : null}
          {initialHistory.map((m) => (
            <li key={m.id}>
              <MessageBubble
                message={m}
                onOpenOutline={(messageOutline) => {
                  const shouldUseLive =
                    liveOutline !== null &&
                    liveOutline.generatedAt === messageOutline.generatedAt;
                  onOpenOutlineModal(shouldUseLive ? liveOutline : messageOutline);
                }}
              />
            </li>
          ))}
          {isPending ? (
            <li key={PENDING_BUBBLE_KEY}>
              <PendingBubble />
            </li>
          ) : null}
        </ul>
        <div ref={scrollSentinelRef} aria-hidden />
      </div>

      <ChatInput
        ref={inputRef}
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={disabled || isPending}
        isSubmitting={isPending}
        dockHeight={bottomDockHeight}
        placeholder={
          projectId
            ? loading
              ? "正在加载历史对话…"
              : "输入你的需求…"
            : "请先在左侧选择或新建一个项目"
        }
      />
    </aside>
  );
}

export function AIChatHeader() {
  return (
    <div
      className="flex h-full w-full shrink-0 items-center justify-between gap-3 border-b border-ink-200/70 bg-white px-4"
    >
      <div className="flex min-w-0 items-center gap-2 text-base font-semibold text-ink-900">
        <Sparkles className="h-4 w-4 shrink-0 text-brand-500" />
        AI 助手
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <button className="inline-flex items-center gap-1 text-xs text-ink-500 transition hover:text-ink-700">
          <CircleHelp className="h-3.5 w-3.5" />
          使用教程
        </button>
        <div className="grid h-7 w-7 place-items-center rounded-full bg-ink-200 text-ink-500">
          <svg viewBox="0 0 24 24" fill="currentColor" className="h-4 w-4">
            <path d="M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 1114 0H5z" />
          </svg>
        </div>
      </div>
    </div>
  );
}

function GreetingBubble() {
  return (
    <div className="rounded-2xl rounded-tl-md border border-ink-200 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-ink-700 shadow-soft">
      你好！我是 AI 视频创作助手。请输入你的创作想法，我会帮你完成从脚本到分镜的全过程。
    </div>
  );
}

function PendingBubble() {
  return (
    <div className="inline-flex items-center gap-2 rounded-2xl rounded-tl-md border border-ink-200 bg-white px-3.5 py-2.5 text-sm text-ink-500 shadow-soft">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-brand-500" />
      AI 正在思考…
    </div>
  );
}

function MessageBubble({
  message,
  onOpenOutline,
}: {
  message: PersistedChatMessage;
  onOpenOutline: (outline: VideoOutline) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-gradient px-3.5 py-2.5 text-sm leading-relaxed text-white shadow-glow">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.kind === "outline") {
    return <OutlineBubble message={message} onOpen={onOpenOutline} />;
  }

  const errorClass = message.error
    ? "border-amber-200 bg-amber-50/60"
    : "border-ink-200 bg-white";

  return (
    <div
      className={clsx(
        "rounded-2xl rounded-tl-md border px-3.5 py-2.5 text-sm leading-relaxed text-ink-700 shadow-soft",
        errorClass,
      )}
    >
      {message.content}
    </div>
  );
}

function OutlineBubble({
  message,
  onOpen,
}: {
  message: Extract<PersistedChatMessage, { kind: "outline" }>;
  onOpen: (outline: VideoOutline) => void;
}) {
  const { outline } = message;
  return (
    <div className="overflow-hidden rounded-2xl rounded-tl-md border border-ink-200 bg-white shadow-soft">
      <div className="flex items-center gap-2 border-b border-ink-200/70 bg-ink-50/60 px-3.5 py-2.5">
        <Film className="h-3.5 w-3.5 text-brand-500" />
        <span className="text-xs font-semibold text-ink-900">视频大纲</span>
        <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700">
          {PROJECT_TYPE_LABEL[outline.mode]}
        </span>
        <span className="ml-auto text-[11px] text-ink-500">
          共 {outline.scenes.length} 个分镜
        </span>
      </div>
      <div className="px-3.5 py-3">
        <p className="text-[13px] leading-relaxed text-ink-700">
          {message.content}
        </p>
        <div className="mt-3 overflow-hidden rounded-lg border border-ink-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-ink-50 text-[11px] font-medium uppercase tracking-wide text-ink-500">
              <tr>
                <th className="w-10 px-2.5 py-1.5 text-center">#</th>
                <th className="px-2.5 py-1.5">标题</th>
                <th className="px-2.5 py-1.5">旁白</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 text-ink-700">
              {outline.scenes.map((s) => (
                <tr key={s.index} className="align-top">
                  <td className="px-2.5 py-1.5 text-center font-mono tabular-nums text-ink-500">
                    {s.index}
                  </td>
                  <td className="px-2.5 py-1.5 font-medium text-ink-900">
                    {s.title}
                  </td>
                  <td className="px-2.5 py-1.5">
                    <span title={s.narration} className="line-clamp-2">
                      {s.narration}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 border-t border-ink-200/70 bg-ink-50/40 px-3.5 py-2">
        <button
          type="button"
          onClick={() => onOpen(outline)}
          className="inline-flex items-center gap-1.5 rounded-md bg-brand-gradient px-3 py-1.5 text-xs font-medium text-white shadow-glow transition hover:opacity-95"
        >
          <Eye className="h-3.5 w-3.5" />
          查看完整大纲内容
        </button>
      </div>
    </div>
  );
}

type ChatInputProps = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  disabled: boolean;
  isSubmitting: boolean;
  placeholder: string;
  dockHeight: number;
};

const ChatInput = forwardRef<HTMLTextAreaElement, ChatInputProps>(function ChatInput(
  { value, onChange, onSubmit, disabled, isSubmitting, placeholder, dockHeight },
  ref,
) {
  return (
    <div
      className="box-border flex shrink-0 flex-col border-t border-ink-200/70 bg-white px-4 py-3"
      style={{ height: dockHeight }}
    >
      <form
        className={clsx(
          "relative h-full min-h-0 rounded-xl border border-ink-200 bg-white transition",
          disabled
            ? "opacity-60"
            : "focus-within:border-brand-300 focus-within:ring-2 focus-within:ring-brand-100",
        )}
        onSubmit={onSubmit}
      >
        <textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          className="block h-full w-full resize-none overflow-y-auto bg-transparent px-3 pb-12 pt-2.5 text-sm leading-relaxed text-ink-700 placeholder:text-ink-400 outline-none disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          aria-label="发送"
          disabled={disabled || value.trim().length === 0}
          className="absolute bottom-2 right-2 grid h-9 w-9 place-items-center rounded-lg bg-brand-gradient text-white shadow-glow transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </button>
      </form>
    </div>
  );
});
