/**
 * 图片轮播 prompt 拼装与归一化（client-safe）。
 * 全局风格只拼一次，分镜 prompt 仅保留本镜 subject，避免重复稀释主体描述。
 */

/** 结构化全局画面风格（大纲生成器输出） */
export type ImageGlobalStyle = {
  visualMotif: string;
  overallStyle: string;
  lightingColor: string;
  composition: string;
  mood: string;
};

const GLOBAL_STYLE_KEYS: (keyof ImageGlobalStyle)[] = [
  "visualMotif",
  "overallStyle",
  "lightingColor",
  "composition",
  "mood",
];

/** 将结构化风格转为一句紧凑英文，供存盘与拼 prompt */
export function globalStyleToProse(style: ImageGlobalStyle): string {
  const parts = [
    style.visualMotif && `Recurring motif: ${style.visualMotif}`,
    style.overallStyle && `Style: ${style.overallStyle}`,
    style.lightingColor && `Lighting and color: ${style.lightingColor}`,
    style.composition && `Composition: ${style.composition}`,
    style.mood && `Mood: ${style.mood}`,
  ].filter(Boolean);
  return parts.join(". ");
}

/**
 * 解析全局风格：支持结构化 JSON 或历史遗留的纯文本 / JSON 字符串。
 * 失败时原样 trim 返回。
 */
export function normalizeGlobalStylePrompt(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  const fromJson = tryParseGlobalStyleJson(trimmed);
  if (fromJson) return globalStyleToProse(fromJson);

  return trimmed.replace(/\s+/g, " ").slice(0, 800);
}

export function tryParseGlobalStyleJson(text: string): ImageGlobalStyle | null {
  let candidate = text.trim();
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) candidate = fence[1].trim();

  if (!candidate.startsWith("{")) return null;

  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>;
    const style: ImageGlobalStyle = {
      visualMotif: readStyleField(obj, "visualMotif", "topic_anchor", "topicAnchor"),
      overallStyle: readStyleField(obj, "overallStyle", "overall_style"),
      lightingColor: readStyleField(obj, "lightingColor", "lighting_and_color", "lighting"),
      composition: readStyleField(obj, "composition"),
      mood: readStyleField(obj, "mood", "mood_keywords", "moodKeywords"),
    };
    const hasContent = GLOBAL_STYLE_KEYS.some((k) => style[k].length > 0);
    return hasContent ? style : null;
  } catch {
    return null;
  }
}

function readStyleField(obj: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** 去掉分镜 prompt 开头误粘贴的全局风格 / JSON 块 */
export function cleanSceneSubjectPrompt(sceneSubject: string, globalProse: string): string {
  let subject = sceneSubject.trim();
  if (!subject) return subject;

  const global = globalProse.trim();
  if (global && subject.startsWith(global)) {
    subject = subject.slice(global.length).replace(/^[\s.,;]+/, "").trim();
  }

  subject = stripLeadingJsonStyleBlock(subject);

  if (global.length > 20) {
    const prefix = global.slice(0, 40).toLowerCase();
    const lower = subject.toLowerCase();
    if (lower.startsWith(prefix)) {
      subject = subject.slice(40).replace(/^[\s.,;]+/, "").trim();
    }
  }

  return subject || sceneSubject.trim();
}

function stripLeadingJsonStyleBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return trimmed;

  const fromJson = tryParseGlobalStyleJson(trimmed);
  if (!fromJson) return trimmed;

  const prose = globalStyleToProse(fromJson);
  let rest = trimmed;
  if (rest.startsWith("{")) {
    const end = rest.indexOf("}");
    if (end >= 0) rest = rest.slice(end + 1).trim();
  }
  if (rest.startsWith(prose)) {
    rest = rest.slice(prose.length).replace(/^[\s.,;]+/, "").trim();
  }
  if (prose.length > 30 && rest.toLowerCase().startsWith(prose.slice(0, 30).toLowerCase())) {
    const idx = rest.indexOf(". ");
    if (idx > 0) rest = rest.slice(idx + 2).trim();
  }
  return rest || trimmed;
}

/** 全局风格 + 本镜 subject → 最终图片生成 prompt（只拼一次） */
export function buildSceneImagePrompt(globalProse: string, sceneSubject: string): string {
  const global = normalizeGlobalStylePrompt(globalProse);
  const subject = cleanSceneSubjectPrompt(sceneSubject, global);

  if (global && subject) {
    return `${global}. ${subject}`.replace(/\s+/g, " ").trim().slice(0, 2000);
  }
  return (subject || global).slice(0, 2000);
}

/** 调用图片 API 前补充画幅提示 */
export function enrichPromptForImageGeneration(
  prompt: string,
  size?: { width: number; height: number },
): string {
  const p = prompt.trim();
  if (/16:9|9:16|aspect ratio|竖屏|横屏/i.test(p)) return p;
  if (size && size.height > size.width) {
    return `${p}, vertical 9:16 portrait aspect ratio, mobile full screen frame`;
  }
  return `${p}, widescreen 16:9 aspect ratio, cinematic still frame`;
}
