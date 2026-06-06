"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { callLLM } from "@/lib/ai";
import type { PersistedChatMessage } from "@/lib/chatTypes";
import type { OutlineScene } from "@/lib/outlineTypes";
import { handleIntent } from "@/lib/handlers";
import {
  INTENT_SYSTEM_PROMPT,
  type IntentAction,
  parseIntentResponse,
} from "@/lib/intents";
import {
  appendChatMessage,
  createProject,
  getProject,
  loadChatHistory,
  loadStoryboard,
  saveStoryboard,
  updateSceneAudioPath,
  updateSceneHtmlPath,
  updateSceneImagePath,
  updateSceneNarration,
  updateScenePrompt,
  updateSceneTitle,
  addScene,
  deleteProject,
  renameProject,
  type ProjectType,
  type VideoOutline,
} from "@/lib/projects";

export type CreateProjectResult =
  | { ok: true; uuid: string }
  | { ok: false; error: string };

export async function createProjectAction(
  type: ProjectType,
): Promise<CreateProjectResult> {
  if (type !== "image" && type !== "html") {
    return { ok: false, error: "未知的创作模式" };
  }
  try {
    const project = await createProject({ type });
    revalidatePath("/create");
    return { ok: true, uuid: project.uuid };
  } catch (err) {
    console.error("[createProjectAction] failed:", err);
    const detail = err instanceof Error ? err.message : "未知错误";
    return {
      ok: false,
      error: `创建项目失败：${detail}。请确认 DATA_DIR 目录存在且当前进程可写。`,
    };
  }
}

/* ---------------------------------------------------------------------------
 * 聊天相关 actions
 * ------------------------------------------------------------------------- */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PROMPT_CHARS = 4000;
const HISTORY_TURN_CAP = 20;
const HISTORY_CHAR_BUDGET = 16_000;

const FALLBACK_ERROR_MESSAGE = "抱歉，我没能完成你的请求，请稍后重试或换个说法试试。";
const OUTLINE_FALLBACK_ERROR_MESSAGE =
  "大纲生成失败，请稍后重试。如果持续失败，可以尝试换一个更具体的主题。";

export async function getChatHistoryAction(
  uuid: string,
): Promise<PersistedChatMessage[]> {
  if (!UUID_RE.test(uuid)) return [];
  try {
    return await loadChatHistory(uuid);
  } catch (err) {
    console.error(`[getChatHistoryAction] load failed for ${uuid}:`, err);
    return [];
  }
}

export type LoadStoryboardResult =
  | { ok: true; outline: VideoOutline }
  | { ok: false; error: string };

/**
 * 重新加载项目大纲（用于图片生成后刷新 imagePath 等字段）。
 */
export async function loadStoryboardAction(
  uuid: string,
): Promise<LoadStoryboardResult> {
  if (!UUID_RE.test(uuid)) {
    return { ok: false, error: "无效的项目 ID" };
  }
  try {
    const outline = await loadStoryboard(uuid);
    if (!outline) {
      return { ok: false, error: "大纲不存在" };
    }
    return { ok: true, outline };
  } catch (err) {
    console.error(`[loadStoryboardAction] failed for ${uuid}:`, err);
    return { ok: false, error: "加载大纲失败" };
  }
}

export type SendPromptResult =
  | {
      ok: true;
      messages: PersistedChatMessage[];
      action: IntentAction;
      outline?: VideoOutline;
    }
  | { ok: false; error: string; messages: PersistedChatMessage[] };

export async function sendPromptAction(
  projectId: string,
  prompt: string,
): Promise<SendPromptResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, error: "无效的项目 ID", messages: [] };
  }
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "请输入内容后再发送。", messages: [] };
  }
  if (trimmed.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      error: `输入内容超过 ${MAX_PROMPT_CHARS} 字符上限，请精简后再试。`,
      messages: [],
    };
  }

  // 0. 取项目模式（决定画面提示词风格、也是 INT 派发的 ctx 字段）
  let projectMode: ProjectType = "image";
  try {
    const project = await getProject(projectId);
    if (project) projectMode = project.type;
  } catch (err) {
    console.error(`[sendPromptAction] getProject failed for ${projectId}:`, err);
    // 拿不到模式不致命，丢一个默认 image
  }

  // 1. 先把用户消息落盘，确保即便后续失败也能在历史里看到
  const userMessage: PersistedChatMessage = {
    id: randomUUID(),
    role: "user",
    content: trimmed,
    createdAt: new Date().toISOString(),
  };
  let history: PersistedChatMessage[];
  try {
    history = await appendChatMessage(projectId, userMessage);
  } catch (err) {
    console.error(`[sendPromptAction] append user msg failed for ${projectId}:`, err);
    return {
      ok: false,
      error: "保存消息失败，请稍后重试。",
      messages: [],
    };
  }

  // 2. 截断历史（条数 + 字符预算）后喂给 LLM
  const trimmedHistory = trimHistoryForLLM(history);

  // 3. 调 LLM → 解析 → 派发
  try {
    const raw = await callLLM({
      system: INTENT_SYSTEM_PROMPT,
      messages: trimmedHistory.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });
    const { action } = parseIntentResponse(raw);
    const result = await handleIntent(action, {
      projectId,
      mode: projectMode,
      prompt: trimmed,
      history: trimmedHistory,
    });

    let assistantMessage: PersistedChatMessage;
    if (result.kind === "outline") {
      assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        kind: "outline",
        content: result.text,
        createdAt: new Date().toISOString(),
        intent: action,
        outline: result.outline,
      };
    } else {
      assistantMessage = {
        id: randomUUID(),
        role: "assistant",
        kind: "text",
        content: result.text,
        createdAt: new Date().toISOString(),
        intent: action,
      };
    }
    const finalHistory = await appendChatMessage(projectId, assistantMessage);
    return {
      ok: true,
      messages: finalHistory,
      action,
      outline: result.kind === "outline" ? result.outline : undefined,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const prefix = classifyError(rawMessage);
    const logPayload =
      prefix === "json_parse_error" || prefix === "action_not_in_union" ||
      prefix === "outline_json_parse_error" || prefix === "outline_shape_invalid" ||
      prefix === "outline_scene_count_invalid"
        ? rawMessage.slice(0, 200)
        : rawMessage;
    console.error(`[sendPromptAction] ${prefix}: ${logPayload}`);

    // 兜底 assistant 消息仍然落盘，刷新后用户能看到这次失败的痕迹
    const fallbackMessage: PersistedChatMessage = {
      id: randomUUID(),
      role: "assistant",
      kind: "text",
      content: prefix.startsWith("outline_") ? OUTLINE_FALLBACK_ERROR_MESSAGE : FALLBACK_ERROR_MESSAGE,
      createdAt: new Date().toISOString(),
      error: true,
    };
    let finalHistory: PersistedChatMessage[];
    try {
      finalHistory = await appendChatMessage(projectId, fallbackMessage);
    } catch (appendErr) {
      console.error(
        `[sendPromptAction] append fallback msg failed for ${projectId}:`,
        appendErr,
      );
      finalHistory = history; // 退一步：至少返回已经写入的用户消息
    }
    return {
      ok: false,
      error: fallbackMessage.content,
      messages: finalHistory,
    };
  }
}

export type SaveStoryboardResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 把当前已展示的大纲强制落盘到 storyboard.txt。
 * 主要用于客户端在用户改写了字段后同步。
 * 暂未在 UI 中调用，预留给未来的「手动编辑大纲」功能。
 */
export async function saveStoryboardAction(
  projectId: string,
  outline: VideoOutline,
): Promise<SaveStoryboardResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, error: "无效的项目 ID" };
  }
  try {
    await saveStoryboard(projectId, outline);
    return { ok: true };
  } catch (err) {
    console.error(`[saveStoryboardAction] save failed for ${projectId}:`, err);
    return { ok: false, error: "保存大纲失败，请稍后重试。" };
  }
}

/* ---------------------------------------------------------------------------
 * 项目管理
 * ------------------------------------------------------------------------- */

export type RenameProjectResult =
  | { ok: true; title: string }
  | { ok: false; error: string };

/** 重命名项目。空名/超长/项目不存在都会返回 error。 */
export async function renameProjectAction(
  projectId: string,
  title: string,
): Promise<RenameProjectResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, error: "无效的项目 ID" };
  }
  try {
    const res = await renameProject(projectId, title);
    revalidatePath("/create");
    revalidatePath("/");
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[renameProjectAction] failed for ${projectId}:`, msg);
    return { ok: false, error: `重命名失败：${msg}` };
  }
}

export type DeleteProjectResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * 删除项目（含所有生成的资源：图片、音频、聊天记录、大纲、视频源码）。
 * 操作不可恢复，UI 层必须二次确认。
 */
export async function deleteProjectAction(
  projectId: string,
): Promise<DeleteProjectResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, error: "无效的项目 ID" };
  }
  try {
    const res = await deleteProject(projectId);
    revalidatePath("/create");
    revalidatePath("/");
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deleteProjectAction] failed for ${projectId}:`, msg);
    return { ok: false, error: `删除失败：${msg}` };
  }
}

function classifyError(message: string): string {
  if (message.startsWith("json_parse_error")) return "json_parse_error";
  if (message.startsWith("action_not_in_union")) return "action_not_in_union";
  if (message.startsWith("shape_invalid")) return "shape_invalid";
  if (message.startsWith("outline_json_parse_error")) return "outline_json_parse_error";
  if (message.startsWith("outline_shape_invalid")) return "outline_shape_invalid";
  if (message.startsWith("outline_scene_count_invalid")) return "outline_scene_count_invalid";
  if (message === "llm_empty_content") return "llm_empty_content";
  return "llm_network_error";
}

function trimHistoryForLLM(
  history: PersistedChatMessage[],
): PersistedChatMessage[] {
  if (history.length === 0) return [];
  let trimmed = history.slice(-HISTORY_TURN_CAP);
  let totalChars = trimmed.reduce((sum, m) => sum + m.content.length, 0);
  while (trimmed.length > 1 && totalChars > HISTORY_CHAR_BUDGET) {
    trimmed = trimmed.slice(1);
    totalChars = trimmed.reduce((sum, m) => sum + m.content.length, 0);
  }
  return trimmed;
}

/* ---------------------------------------------------------------------------
 * 图片生成相关
 * ------------------------------------------------------------------------- */

/** 每个项目的 AbortController（用于中断生成流程） */
const generationAbortControllers = new Map<string, AbortController>();

export interface GenerateImagesResult {
  ok: boolean;
  generatedCount: number;
  totalCount: number;
  /** 失败原因列表（sceneIndex -> errorMessage） */
  failures?: Record<number, string>;
  error?: string;
}

/**
 * 一键生成：逐个为还没有图片的分镜生成图片。
 * 已存在 imagePath 的分镜会跳过。
 * 生成过程中可通过 interruptGenerationAction 中断。
 */
export async function generateImagesAction(
  projectId: string,
): Promise<GenerateImagesResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, generatedCount: 0, totalCount: 0, error: "无效的项目 ID" };
  }

  // 获取大纲
  const outline = await loadStoryboard(projectId);
  if (!outline) {
    return { ok: false, generatedCount: 0, totalCount: 0, error: "大纲不存在" };
  }

  // 找出还没有图片的分镜
  const toGenerate = outline.scenes.filter((s: { imagePath?: string }) => !s.imagePath);
  if (toGenerate.length === 0) {
    return { ok: false, generatedCount: 0, totalCount: 0, error: "所有分镜都已生成图片" };
  }

  // 创建 AbortController
  const controller = new AbortController();
  generationAbortControllers.set(projectId, controller);

  const failures: Record<number, string> = {};
  let generatedCount = 0;

  try {
    for (const scene of toGenerate) {
      if (controller.signal.aborted) break;

      try {
        // 动态导入避免循环依赖
        const { generateImage } = await import("@/lib/imageGen");
        const result = await generateImage({
          projectId,
          sceneIndex: scene.index,
          prompt: scene.prompt,
        });

        // 更新 storyboard 中该分镜的图片路径
        await updateSceneImagePath(projectId, scene.index, result.relativePath);
        generatedCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[generateImagesAction] scene ${scene.index} failed:`, msg);
        failures[scene.index] = msg;
        // 单张失败不中断整体流程
      }
    }
  } finally {
    generationAbortControllers.delete(projectId);
  }

  return {
    ok: true,
    generatedCount,
    totalCount: toGenerate.length,
    failures: Object.keys(failures).length > 0 ? failures : undefined,
  };
}

/**
 * 中断正在进行的图片生成流程。
 */
export async function interruptGenerationAction(
  projectId: string,
): Promise<{ ok: boolean }> {
  const controller = generationAbortControllers.get(projectId);
  if (controller) {
    controller.abort();
    generationAbortControllers.delete(projectId);
  }
  return { ok: true };
}

/**
 * 为单个分镜生成图片。
 */
export interface GenerateSceneImageResult {
  ok: boolean;
  sceneIndex: number;
  imagePath?: string;
  error?: string;
}

export async function generateSceneImageAction(
  projectId: string,
  sceneIndex: number,
): Promise<GenerateSceneImageResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, sceneIndex, error: "无效的项目 ID" };
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, sceneIndex, error: "无效的分镜序号" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) {
    return { ok: false, sceneIndex, error: "大纲不存在" };
  }
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) {
    return { ok: false, sceneIndex, error: `分镜 ${sceneIndex} 不存在` };
  }

  try {
    const { generateImage } = await import("@/lib/imageGen");
    const result = await generateImage({
      projectId,
      sceneIndex,
      prompt: scene.prompt,
    });
    await updateSceneImagePath(projectId, sceneIndex, result.relativePath);

    // 生成完图片后，自动生成旁白音频
    try {
      const { generateAudio } = await import("@/lib/audioGen");
      const audioResult = await generateAudio({
        projectId,
        sceneIndex,
        narration: scene.narration,
      });
      await updateSceneAudioPath(projectId, sceneIndex, audioResult.relativePath);
    } catch (audioErr) {
      // 音频生成失败不中止整个流程，只打印日志
      console.error(`[generateSceneImageAction] scene ${sceneIndex} audio failed:`, audioErr instanceof Error ? audioErr.message : String(audioErr));
    }

    return { ok: true, sceneIndex, imagePath: result.relativePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generateSceneImageAction] scene ${sceneIndex} failed:`, msg);
    return { ok: false, sceneIndex, error: msg };
  }
}

/* ---------------------------------------------------------------------------
 * 单分镜重新生成（编辑大纲弹窗里用）
 * ------------------------------------------------------------------------- */

export type RegenerateSceneResult =
  | { ok: true; outline: VideoOutline }
  | { ok: false; error: string };

/**
 * 仅重新生成画面（不动 audio / narration）。
 * 用于"重新生成画面"按钮：narration 没变，audio 不必重做，节省 token 和时间。
 * 成功后返回刷新后的 outline，UI 直接替换旧 outline 即可显示新图。
 */
export async function regenerateSceneImageAction(
  projectId: string,
  sceneIndex: number,
): Promise<RegenerateSceneResult> {
  if (!UUID_RE.test(projectId)) return { ok: false, error: "无效的项目 ID" };
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, error: "无效的分镜序号" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) return { ok: false, error: "大纲不存在" };
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) return { ok: false, error: `分镜 ${sceneIndex} 不存在` };

  try {
    const { generateImage } = await import("@/lib/imageGen");
    const result = await generateImage({
      projectId,
      sceneIndex,
      prompt: scene.prompt,
    });
    await updateSceneImagePath(projectId, sceneIndex, result.relativePath);
    const fresh = await loadStoryboard(projectId);
    if (!fresh) return { ok: false, error: "刷新大纲失败" };
    return { ok: true, outline: fresh };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[regenerateSceneImageAction] scene ${sceneIndex} failed:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * 仅重新生成音频（沿用当前 narration，不动 image / narration）。
 * 用于"重新合成旁白音频"等场景；目前 UI 没直接暴露这个按钮，
 * 但 regenerateSceneNarrationAction 会在 narration 改写完后内部调用同样的逻辑。
 */
export async function regenerateSceneAudioAction(
  projectId: string,
  sceneIndex: number,
): Promise<RegenerateSceneResult> {
  if (!UUID_RE.test(projectId)) return { ok: false, error: "无效的项目 ID" };
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, error: "无效的分镜序号" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) return { ok: false, error: "大纲不存在" };
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) return { ok: false, error: `分镜 ${sceneIndex} 不存在` };

  try {
    const { generateAudio } = await import("@/lib/audioGen");
    const result = await generateAudio({
      projectId,
      sceneIndex,
      narration: scene.narration,
    });
    await updateSceneAudioPath(projectId, sceneIndex, result.relativePath);
    const fresh = await loadStoryboard(projectId);
    if (!fresh) return { ok: false, error: "刷新大纲失败" };
    return { ok: true, outline: fresh };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[regenerateSceneAudioAction] scene ${sceneIndex} failed:`, msg);
    return { ok: false, error: msg };
  }
}

/**
 * 重新生成旁白：
 *  1. 调 LLM 用同样的标题 + 整片 script 作为上下文，重写本分镜旁白（保留意思，换种表达）
 *  2. 落盘新 narration
 *  3. 立刻重生 audio（保证 audio 与新 narration 一致）
 * 成功返回刷新后的 outline。
 */
export async function regenerateSceneNarrationAction(
  projectId: string,
  sceneIndex: number,
): Promise<RegenerateSceneResult> {
  if (!UUID_RE.test(projectId)) return { ok: false, error: "无效的项目 ID" };
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, error: "无效的分镜序号" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) return { ok: false, error: "大纲不存在" };
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) return { ok: false, error: `分镜 ${sceneIndex} 不存在` };

  try {
    // Step 1: LLM 重写
    const system = `你是 AI 视频创作助手的旁白编辑器。
请把"目标分镜"的旁白重写成另一个版本：保留原意与大致长度（字数浮动 ±20% 以内），但换种表达方式。
要求：
- 直接输出新旁白纯文本，不要 JSON、不要 Markdown 围栏、不要解释、不要前缀
- 不要改变信息核心，但可以调整语气与措辞
- 保留中文标点（短句之间的逗号、句末的句号），让 TTS 能正常断句`;

    const userMsg = [
      `# 视频整体逐字稿（仅作上下文，不要改它）`,
      outline.script,
      ``,
      `# 当前要重写的分镜`,
      `标题：${scene.title}`,
      `原旁白：${scene.narration}`,
      ``,
      `请输出新的旁白文本：`,
    ].join("\n");

    const raw = await callLLM({
      system,
      messages: [{ role: "user", content: userMsg }],
    });
    const newNarration = stripQuotes(raw.trim());
    if (!newNarration || newNarration.length === 0) {
      return { ok: false, error: "LLM 返回为空" };
    }

    // Step 2: 落盘 narration
    await updateSceneNarration(projectId, sceneIndex, newNarration);

    // Step 3: 重生 audio
    try {
      const { generateAudio } = await import("@/lib/audioGen");
      const audioResult = await generateAudio({
        projectId,
        sceneIndex,
        narration: newNarration,
      });
      await updateSceneAudioPath(projectId, sceneIndex, audioResult.relativePath);
    } catch (audioErr) {
      // 音频失败不回滚 narration（用户至少看到了新文本，可以稍后手动再生音频）
      console.error(
        `[regenerateSceneNarrationAction] audio failed for scene ${sceneIndex}:`,
        audioErr instanceof Error ? audioErr.message : String(audioErr),
      );
    }

    const fresh = await loadStoryboard(projectId);
    if (!fresh) return { ok: false, error: "刷新大纲失败" };
    return { ok: true, outline: fresh };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[regenerateSceneNarrationAction] scene ${sceneIndex} failed:`, msg);
    return { ok: false, error: msg };
  }
}
/* ---------------------------------------------------------------------------
 * 手动编辑分镜文本（大纲弹窗里用）
 *
 * 这三条 action 只更新对应字段，不动图片/音频资源：
 *  - updateSceneTitleAction   —— 仅改 title
 *  - updateScenePromptAction  —— 仅改 prompt
 *  - updateSceneNarrationAction —— 仅改 narration（不自动重生成 audio，避免误伤现有素材；
 *                                 用户改完旁白后想同步音频可点"重新生成旁白"按钮）
 *
 * 全部走"原子写 storyboard + revalidatePath"，刷新后用户看到最新数据。
 * ------------------------------------------------------------------------- */

export type UpdateSceneTextResult =
  | { ok: true; outline: VideoOutline }
  | { ok: false; error: string };

async function updateSceneField(
  projectId: string,
  sceneIndex: number,
  field: "title" | "prompt" | "narration",
  value: string,
): Promise<UpdateSceneTextResult> {
  if (!UUID_RE.test(projectId)) return { ok: false, error: "无效的项目 ID" };
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, error: "无效的分镜序号" };
  }
  const outline = await loadStoryboard(projectId);
  if (!outline) return { ok: false, error: "大纲不存在" };
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) return { ok: false, error: `分镜 ${sceneIndex} 不存在` };

  try {
    if (field === "title") await updateSceneTitle(projectId, sceneIndex, value);
    else if (field === "prompt") await updateScenePrompt(projectId, sceneIndex, value);
    else await updateSceneNarration(projectId, sceneIndex, value);

    const fresh = await loadStoryboard(projectId);
    if (!fresh) return { ok: false, error: "刷新大纲失败" };
    revalidatePath("/create");
    return { ok: true, outline: fresh };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 把底层抛的 *_empty 转成用户友好文案
    if (msg === "title_empty") return { ok: false, error: "标题不能为空" };
    if (msg === "prompt_empty") return { ok: false, error: "画面提示词不能为空" };
    if (msg === "narration_empty") return { ok: false, error: "旁白不能为空" };
    return { ok: false, error: `保存失败：${msg}` };
  }
}

export async function updateSceneTitleAction(
  projectId: string,
  sceneIndex: number,
  title: string,
): Promise<UpdateSceneTextResult> {
  return updateSceneField(projectId, sceneIndex, "title", title);
}

export async function updateScenePromptAction(
  projectId: string,
  sceneIndex: number,
  prompt: string,
): Promise<UpdateSceneTextResult> {
  return updateSceneField(projectId, sceneIndex, "prompt", prompt);
}

export async function updateSceneNarrationAction(
  projectId: string,
  sceneIndex: number,
  narration: string,
): Promise<UpdateSceneTextResult> {
  return updateSceneField(projectId, sceneIndex, "narration", narration);
}

/* ---------------------------------------------------------------------------
 * 添加分镜
 * ------------------------------------------------------------------------- */

export type AddSceneResult =
  | { ok: true; outline: VideoOutline; scene: OutlineScene }
  | { ok: false; error: string };

/**
 * 追加一个新分镜到 outline 末尾。
 * 成功返回最新的 outline + 新分镜对象，UI 把 outline 替换掉即可。
 */
export async function addSceneAction(
  projectId: string,
  fields: { title: string; narration: string; prompt: string },
): Promise<AddSceneResult> {
  if (!UUID_RE.test(projectId)) return { ok: false, error: "无效的项目 ID" };
  const title = fields.title.trim();
  const narration = fields.narration.trim();
  const prompt = fields.prompt.trim();
  if (!title) return { ok: false, error: "标题不能为空" };
  if (!narration) return { ok: false, error: "旁白不能为空" };
  if (!prompt) return { ok: false, error: "画面提示词不能为空" };

  try {
    const newScene = await addScene(projectId, { title, narration, prompt });
    const fresh = await loadStoryboard(projectId);
    if (!fresh) return { ok: false, error: "刷新大纲失败" };
    revalidatePath("/create");
    return { ok: true, outline: fresh, scene: newScene };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "outline_not_found") return { ok: false, error: "大纲不存在" };
    return { ok: false, error: `添加分镜失败：${msg}` };
  }
}

/** LLM 偶尔会把整段输出包在引号或 ``` 围栏里，统一剥一层。 */
function stripQuotes(s: string): string {
  let t = s.trim();
  // 去 ``` 围栏
  const fence = t.match(/^```(?:\w+)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  // 去首尾引号
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith("「") && t.endsWith("」")) ||
    (t.startsWith("『") && t.endsWith("』"))
  ) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

/* ---------------------------------------------------------------------------
 * 分镜 HTML 动画生成（仅 HTML 模式使用）
 *
 * 设计要点：
 *  - generateSceneHtmlAction 一次只生成一镜的 HTML；为保持视觉风格一致，
 *    会从 storyboard 里读出"上一镜"的 htmlPath，把它的 HTML 文件内容
 *    作为上下文喂给 LLM（如果没有上一镜，上下文里说明"这是第一镜"）
 *  - 成功落盘后立刻生成旁白音频（与图片模式保持一致的心智模型：先生成"画面"再生成"音频"）
 *  - generateAllSceneHtmlsAction 一键生成所有缺失的 HTML（与 generateImagesAction
 *    对称）；不重做已有 htmlPath 的分镜
 * ------------------------------------------------------------------------- */

export interface GenerateSceneHtmlResult {
  ok: boolean;
  sceneIndex: number;
  htmlPath?: string;
  error?: string;
}

/**
 * 为单个分镜生成 HTML 动画。
 * - 读取 storyboard 找到该分镜；如果它有 htmlPath，跳过（不重做）
 * - 读取"上一镜"的 HTML 内容（如果存在）作为视觉风格参考
 * - 调 generateSceneHtml 写盘
 * - 落盘后立刻生成旁白音频
 */
export async function generateSceneHtmlAction(
  projectId: string,
  sceneIndex: number,
): Promise<GenerateSceneHtmlResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, sceneIndex, error: "无效的项目 ID" };
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, sceneIndex, error: "无效的分镜序号" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) {
    return { ok: false, sceneIndex, error: "大纲不存在" };
  }
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) {
    return { ok: false, sceneIndex, error: `分镜 ${sceneIndex} 不存在` };
  }
  if (scene.htmlPath) {
    return { ok: false, sceneIndex, error: "该分镜已生成动画" };
  }

  try {
    const { generateSceneHtml } = await import("@/lib/htmlSceneGen");
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");

    // 找"上一镜"：取 index < sceneIndex 的最大 index 那一镜
    const prevScene = outline.scenes
      .filter((s) => s.index < sceneIndex)
      .sort((a, b) => b.index - a.index)[0];
    let previousHtml: string | null = null;
    let previousIndex: number | null = null;
    if (prevScene?.htmlPath) {
      try {
        const dataDir = process.env.DATA_DIR?.trim()
          ? path.resolve(process.env.DATA_DIR)
          : path.join(process.cwd(), "data", "projects");
        const prevAbs = path.join(dataDir, projectId, prevScene.htmlPath);
        previousHtml = await readFile(prevAbs, "utf-8");
        previousIndex = prevScene.index;
      } catch (err) {
        // 读上一镜 HTML 失败不致命：当作没有上一镜，继续生成
        console.warn(
          `[generateSceneHtmlAction] failed to read previous HTML for ${projectId} scene ${prevScene.index}:`,
          err instanceof Error ? err.message : err,
        );
        previousHtml = null;
        previousIndex = null;
      }
    }

    const result = await generateSceneHtml({
      projectId,
      scene,
      previousHtml,
      previousIndex,
    });
    await updateSceneHtmlPath(projectId, sceneIndex, result.relativePath);

    // 自动生成旁白音频（与图片模式一致的体验）
    try {
      const { generateAudio } = await import("@/lib/audioGen");
      const audioResult = await generateAudio({
        projectId,
        sceneIndex,
        narration: scene.narration,
      });
      await updateSceneAudioPath(projectId, sceneIndex, audioResult.relativePath);
    } catch (audioErr) {
      console.error(
        `[generateSceneHtmlAction] audio failed for scene ${sceneIndex}:`,
        audioErr instanceof Error ? audioErr.message : String(audioErr),
      );
    }

    return { ok: true, sceneIndex, htmlPath: result.relativePath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[generateSceneHtmlAction] scene ${sceneIndex} failed:`, msg);
    return { ok: false, sceneIndex, error: msg };
  }
}

/**
 * 一键生成所有分镜的 HTML 动画。
 * - 已存在 htmlPath 的分镜跳过
 * - 串行执行，避免并发把 LLM 打爆
 * - 单镜失败不中断整体流程，结果里 failures 字段聚合错误
 */
export interface GenerateAllHtmlsResult {
  ok: boolean;
  generatedCount: number;
  totalCount: number;
  failures?: Record<number, string>;
  error?: string;
}

export async function generateAllSceneHtmlsAction(
  projectId: string,
): Promise<GenerateAllHtmlsResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, generatedCount: 0, totalCount: 0, error: "无效的项目 ID" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) {
    return { ok: false, generatedCount: 0, totalCount: 0, error: "大纲不存在" };
  }
  if (outline.mode !== "html") {
    return {
      ok: false,
      generatedCount: 0,
      totalCount: 0,
      error: "当前项目不是 HTML 模式",
    };
  }

  const toGenerate = outline.scenes.filter((s) => !s.htmlPath);
  if (toGenerate.length === 0) {
    return {
      ok: false,
      generatedCount: 0,
      totalCount: 0,
      error: "所有分镜都已生成动画",
    };
  }

  const failures: Record<number, string> = {};
  let generatedCount = 0;
  for (const scene of toGenerate) {
    try {
      const res = await generateSceneHtmlAction(projectId, scene.index);
      if (res.ok) {
        generatedCount++;
      } else {
        failures[scene.index] = res.error ?? "未知错误";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures[scene.index] = msg;
    }
  }

  return {
    ok: true,
    generatedCount,
    totalCount: toGenerate.length,
    failures: Object.keys(failures).length > 0 ? failures : undefined,
  };
}

/**
 * 重新生成分镜 HTML 动画（覆盖已有），用于"重新生成动画"按钮。
 * 同时也会重新生成音频（narration 不变，但既然要重做，就一并刷新）。
 */
export async function regenerateSceneHtmlAction(
  projectId: string,
  sceneIndex: number,
): Promise<RegenerateSceneResult> {
  if (!UUID_RE.test(projectId)) return { ok: false, error: "无效的项目 ID" };
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, error: "无效的分镜序号" };
  }

  const outline = await loadStoryboard(projectId);
  if (!outline) return { ok: false, error: "大纲不存在" };
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) return { ok: false, error: `分镜 ${sceneIndex} 不存在` };

  try {
    const { generateSceneHtml } = await import("@/lib/htmlSceneGen");
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");

    // 找"上一镜"：取 index < sceneIndex 的最大 index 那一镜。
    // 如果上一镜 HTML 不存在，就用更早的（往前再找）
    let previousHtml: string | null = null;
    let previousIndex: number | null = null;
    const candidates = outline.scenes
      .filter((s) => s.index < sceneIndex && s.htmlPath)
      .sort((a, b) => b.index - a.index);
    const dataDir = process.env.DATA_DIR?.trim()
      ? path.resolve(process.env.DATA_DIR)
      : path.join(process.cwd(), "data", "projects");

    for (const prev of candidates) {
      if (!prev.htmlPath) continue;
      try {
        const prevAbs = path.join(dataDir, projectId, prev.htmlPath);
        previousHtml = await readFile(prevAbs, "utf-8");
        previousIndex = prev.index;
        break;
      } catch {
        // 继续找再前一个
      }
    }

    const result = await generateSceneHtml({
      projectId,
      scene,
      previousHtml,
      previousIndex,
    });
    await updateSceneHtmlPath(projectId, sceneIndex, result.relativePath);

    // 重生音频（保持同步）
    try {
      const { generateAudio } = await import("@/lib/audioGen");
      const audioResult = await generateAudio({
        projectId,
        sceneIndex,
        narration: scene.narration,
      });
      await updateSceneAudioPath(projectId, sceneIndex, audioResult.relativePath);
    } catch (audioErr) {
      console.error(
        `[regenerateSceneHtmlAction] audio failed for scene ${sceneIndex}:`,
        audioErr instanceof Error ? audioErr.message : String(audioErr),
      );
    }

    const fresh = await loadStoryboard(projectId);
    if (!fresh) return { ok: false, error: "刷新大纲失败" };
    return { ok: true, outline: fresh };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[regenerateSceneHtmlAction] scene ${sceneIndex} failed:`, msg);
    return { ok: false, error: msg };
  }
}

/* ---------------------------------------------------------------------------
 * 读取分镜 HTML 文件内容（用于前端 iframe srcdoc 渲染）
 *
 * 设计要点：
 *  - 走专用 route handler 暴露：避免 fs API 被泄露到客户端 bundle
 *  - 返回 Content-Type: text/html; charset=utf-8
 *  - 加 Cache-Control: no-cache，与图片 API 行为一致，方便"重新生成"后立刻看到
 * ------------------------------------------------------------------------- */

export interface ReadSceneHtmlResult {
  ok: boolean;
  html?: string;
  error?: string;
}

export async function readSceneHtmlAction(
  projectId: string,
  sceneIndex: number,
): Promise<ReadSceneHtmlResult> {
  if (!UUID_RE.test(projectId)) {
    return { ok: false, error: "无效的项目 ID" };
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1) {
    return { ok: false, error: "无效的分镜序号" };
  }
  try {
    const { readFile } = await import("node:fs/promises");
    const path = await import("node:path");
    const dataDir = process.env.DATA_DIR?.trim()
      ? path.resolve(process.env.DATA_DIR)
      : path.join(process.cwd(), "data", "projects");
    const filePath = path.join(dataDir, projectId, "scenes", `${sceneIndex}.html`);
    const html = await readFile(filePath, "utf-8");
    return { ok: true, html };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, error: "HTML 文件不存在" };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[readSceneHtmlAction] failed for ${projectId}/${sceneIndex}:`, msg);
    return { ok: false, error: msg };
  }
}
