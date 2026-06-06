// 意图识别相关定义 —— 此文件 client-safe，严禁 import 任何 Node 依赖。
// 实际的 handler 实现（含 LLM 调用、文件写入等副作用）见 ./handlers.ts。

import type { VideoOutline } from "./outlineTypes";
import type { ProjectType } from "./projectTypes";

/**
 * 全部合法 action 的字面量元组。
 * 新增 action 时：先在这里加一项；TS 会在 handlers.ts 的 INTENT_HANDLERS
 * 缺 handler 时报错，强迫你补完处理函数。
 */
export const INTENT_ACTIONS = [
  "generate_video_outline",
  "regenerate_outline",
  "add_scene",
  "delete_scene",
  "regenerate_scene",
  "other_unsupported",
] as const;

export type IntentAction = (typeof INTENT_ACTIONS)[number];

export interface IntentResult {
  action: IntentAction;
  reason: string;
}

/** handler 拿到的运行时上下文 */
export interface IntentHandlerContext {
  projectId: string;
  /** 当前模式（用于画面提示词风格） */
  mode: ProjectType;
  /** 用户本次输入的提示词（去前后空白） */
  prompt: string;
  /** 当前项目的全部历史消息（最近优先，已经过截断） */
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

/** handler 返回的 discriminated union */
export type IntentHandlerResult =
  | { kind: "text"; text: string }
  | { kind: "outline"; text: string; outline: VideoOutline };

const ACTION_SET: ReadonlySet<string> = new Set<string>(INTENT_ACTIONS);

/**
 * 解析 LLM 返回的 JSON 文本。兼容：
 *  - 前后空白
 *  - ``` ```json / ``` ``` Markdown 围栏
 *
 * 解析失败时抛出 Error（带 message 前缀，方便上游打不同日志标签）：
 *  - "json_parse_error: ..."   JSON 解析失败
 *  - "action_not_in_union: ..." action 不在六种合法值内
 *  - "shape_invalid: ..."       字段类型不对
 */
export function parseIntentResponse(raw: string): IntentResult {
  const text = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`json_parse_error: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("shape_invalid: not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const action = obj.action;
  const reason = obj.reason;
  if (typeof action !== "string" || !ACTION_SET.has(action)) {
    throw new Error(`action_not_in_union: ${JSON.stringify(action)}`);
  }
  if (typeof reason !== "string") {
    throw new Error("shape_invalid: reason is not a string");
  }
  return {
    action: action as IntentAction,
    reason: reason.slice(0, 500),
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1].trim();
  return trimmed;
}

/**
 * 给 LLM 的系统提示词。明确：
 *  1. 角色：意图识别器（不要回答问题、不要寒暄）
 *  2. 输出：纯 JSON，不要 Markdown 围栏，不要解释
 *  3. 枚举：六种合法 action 及其中文含义
 *  4. 格式：{ action, reason }
 *  5. 一次性示例
 */
export const INTENT_SYSTEM_PROMPT = `你是 AI 视频创作助手的意图识别器。

# 你的唯一任务
根据用户的输入，输出严格的 JSON 对象。不要包含任何解释、Markdown 代码块或额外文字。

# 可能的意图（action）有且仅有以下六种
1. "generate_video_outline" —— 用户希望从零开始生成完整的视频大纲/脚本/分镜
2. "regenerate_outline" —— 用户希望重新生成已经存在的视频大纲
3. "add_scene" —— 用户希望在现有大纲中新增一个分镜
4. "delete_scene" —— 用户希望删除现有大纲中的某一个分镜
5. "regenerate_scene" —— 用户希望重新生成某一个具体分镜的画面/内容
6. "other_unsupported" —— 其他所有无法归入以上五类的请求（包括闲聊、问问题、本轮尚不支持的能力等）

# 返回 JSON 格式
{"action": "<六种 action 之一>", "reason": "用一句话向用户解释为什么识别为该意图"}

# 示例
输入：帮我做一个关于宇宙探索的科普视频，时长大约 1 分钟
输出：{"action": "generate_video_outline", "reason": "用户希望从零开始创作一个完整的视频"}`;
