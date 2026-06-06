import "server-only";
import { generateOutline } from "./outline";
import { saveStoryboard } from "./projects";
import type {
  IntentAction,
  IntentHandlerContext,
  IntentHandlerResult,
} from "./intents";

/**
 * 全部 intent 的运行时实现。
 *
 *  - `Record<IntentAction, ...>` 意味着新增 action 时 TS 会在此处报错，
 *    强迫补完 handler。
 *  - 每个 handler 必须返回 IntentHandlerResult（text 或 outline），
 *    由 actions 层统一落盘为 assistant 消息。
 *  - 真正的副作用（写文件、读 LLM）只发生在 generate_video_outline 里，
 *    其余 5 个 handler 仍是占位文本。
 */
export const INTENT_HANDLERS: Record<
  IntentAction,
  (ctx: IntentHandlerContext) => Promise<IntentHandlerResult>
> = {
  generate_video_outline: async (ctx) => {
    const outline = await generateOutline({
      projectId: ctx.projectId,
      mode: ctx.mode,
      prompt: ctx.prompt,
      history: ctx.history,
    });
    await saveStoryboard(ctx.projectId, outline);
    const totalChars = outline.script.length;
    return {
      kind: "outline",
      text:
        `已为你生成《${outline.scenes[0]?.title ?? "视频"}》等 ${outline.scenes.length} 个分镜的大纲` +
        `（共 ${totalChars} 字逐字稿）。点击下方卡片查看完整内容。`,
      outline,
    };
  },

  regenerate_outline: async () => ({
    kind: "text" as const,
    text: "好的，我正在重新生成视频大纲…",
  }),
  add_scene: async () => ({
    kind: "text" as const,
    text: "好的，我正在为你新增一个分镜…",
  }),
  delete_scene: async () => ({
    kind: "text" as const,
    text: "好的，我正在删除指定分镜…",
  }),
  regenerate_scene: async () => ({
    kind: "text" as const,
    text: "好的，我正在重新生成分镜…",
  }),
  other_unsupported: async () => ({
    kind: "text" as const,
    text:
      "这个需求暂时还不支持。目前我能帮你：生成/重新生成视频大纲、添加/删除/重新生成分镜。请换个说法试试。",
  }),
};

export async function handleIntent(
  action: IntentAction,
  ctx: IntentHandlerContext,
): Promise<IntentHandlerResult> {
  return INTENT_HANDLERS[action](ctx);
}
