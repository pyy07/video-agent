import "server-only";
import OpenAI from "openai";

/**
 * OpenAI 兼容接口的轻量封装。
 *
 * 设计要点：
 *  - client 懒加载，第一次调用时才校验 env，避免 import 期崩溃
 *  - 仅暴露 callLLM 一个对外入口；不直接泄漏 OpenAI SDK 给调用方
 *  - json_object 模式 + 防御性解析（parseIntentResponse / parseOutlineResponse
 *    端）双保险
 *  - temperature 固定 0.2：意图分类 / 大纲生成是离散任务，温度太高反而抖动
 *  - extractText 对常见的「非标准 OpenAI-compat 代理」做了兼容，详见函数注释
 */

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!baseURL) {
    throw new Error("LLM_BASE_URL 未配置。请在 .env 中设置 LLM_BASE_URL。");
  }
  if (!apiKey) {
    throw new Error("LLM_API_KEY 未配置。请在 .env 中设置 LLM_API_KEY。");
  }
  _client = new OpenAI({ baseURL, apiKey });
  return _client;
}

function resolveModel(): string {
  const fromEnv = process.env.LLM_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "gemini-3-flash-preview";
}

/**
 * 调一次 LLM。返回第一个 choice 的原始 content 字符串。
 * 上层负责 JSON 解析与错误分类。
 */
export async function callLLM(opts: {
  system: string;
  messages: LLMMessage[];
}): Promise<string> {
  return callLLMRaw({ ...opts, jsonMode: true });
}

/**
 * 调一次 LLM，可选是否强制 JSON 模式。
 * - jsonMode: true（默认）→ response_format: json_object，用于需要结构化 JSON 的场景
 * - jsonMode: false → 让 LLM 自由输出（HTML、纯文本等），不再被强制包裹成 JSON
 */
export async function callLLMRaw(opts: {
  system: string;
  messages: LLMMessage[];
  jsonMode?: boolean;
}): Promise<string> {
  const jsonMode = opts.jsonMode !== false;
  const res = await getClient().chat.completions.create({
    model: resolveModel(),
    temperature: 0.2,
    ...(jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    messages: [{ role: "system", content: opts.system }, ...opts.messages],
  });

  // 1) 代理把 4xx/5xx 包装成 200 OK 返回（{ "error": {...} } 形态）
  const errorField = readErrorField(res);
  if (errorField) {
    throw new Error(`llm_error_response: ${errorField}`);
  }

  const text = extractText(res);
  if (text === null) {
    // 全部常见形态都没匹配上 —— 把响应结构摘要化抛出去，方便排查代理差异
    throw new Error(`llm_empty_content: ${summarizeResponse(res)}`);
  }
  if (text.trim().length === 0) {
    throw new Error("llm_empty_content: text was empty after trim");
  }
  return text;
}

/**
 * 从代理响应里把文本抠出来。兼容：
 *  - 标准 OpenAI: { choices: [{ message: { content } }] } 或 { choices: [{ text }] }
 *  - Anthropic 风格: { content: "..." }
 *  - 一些代理: { output: "..." } / { text: "..." }
 *  - 包装型: { data: [{ content: "..." }] }
 *  - 顶层 message: { message: { content: "..." } }
 *
 * 返回 null 表示没有匹配上。
 */
function extractText(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const r = res as Record<string, unknown>;

  // 标准 OpenAI choices[]
  if (Array.isArray(r.choices) && r.choices.length > 0) {
    const c = r.choices[0];
    if (c && typeof c === "object") {
      const cc = c as Record<string, unknown>;
      if (typeof cc.text === "string") return cc.text;
      const m = cc.message;
      if (m && typeof m === "object") {
        const mm = m as Record<string, unknown>;
        if (typeof mm.content === "string") return mm.content;
        // content 可能是 array of { type, text }（新版多模态形态）
        if (Array.isArray(mm.content)) {
          const joined = mm.content
            .map((p) =>
              p && typeof p === "object" && typeof (p as Record<string, unknown>).text === "string"
                ? ((p as Record<string, unknown>).text as string)
                : "",
            )
            .join("");
          if (joined.length > 0) return joined;
        }
      }
    }
  }

  // Anthropic / Claude 风格
  if (typeof r.content === "string") return r.content;

  // 顶层 message.content
  if (r.message && typeof r.message === "object") {
    const m = r.message as Record<string, unknown>;
    if (typeof m.content === "string") return m.content;
  }

  // 一些代理用 output / text 平铺
  if (typeof r.output === "string") return r.output;
  if (typeof r.text === "string") return r.text;

  // 包装型 data[]
  if (Array.isArray(r.data) && r.data.length > 0) {
    const d = r.data[0];
    if (d && typeof d === "object") {
      const dd = d as Record<string, unknown>;
      if (typeof dd.content === "string") return dd.content;
      if (typeof dd.text === "string") return dd.text;
    }
  }

  return null;
}

/** 代理把错误塞进 body 而不是抛 APIError 的情况。 */
function readErrorField(res: unknown): string | null {
  if (!res || typeof res !== "object") return null;
  const r = res as Record<string, unknown>;
  const e = r.error;
  if (e && typeof e === "object") {
    try {
      return JSON.stringify(e).slice(0, 300);
    } catch {
      return "[unserializable error]";
    }
  }
  if (typeof e === "string") return e.slice(0, 300);
  return null;
}

/** 把响应结构压缩成单行摘要，便于日志和错误信息。 */
function summarizeResponse(res: unknown): string {
  if (res === null || res === undefined) return String(res);
  if (typeof res !== "object") return `${typeof res}=${String(res).slice(0, 80)}`;
  try {
    const json = JSON.stringify(res);
    const keys = Object.keys(res as Record<string, unknown>).join(",");
    return `keys=[${keys}] preview=${json.slice(0, 400)}`;
  } catch {
    return `keys=[?] preview=[unserializable]`;
  }
}
