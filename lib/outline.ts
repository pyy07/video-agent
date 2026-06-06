import "server-only";
import { callLLM } from "./ai";
import type { VideoOutline, OutlineScene } from "./outlineTypes";
import type { ProjectType } from "./projectTypes";

/**
 * 视频大纲生成器。
 *
 * 流程：
 *  1. 根据项目模式拼装 system prompt（image 模式强调英文图片生成 prompt，
 *     html 模式强调中文网页动画 prompt）
 *  2. 调 LLM（response_format: json_object）
 *  3. 解析并校验（6..30 镜、index 连续、字段非空等）
 *  4. 返回 VideoOutline
 *
 * 失败语义：抛出带前缀的 Error，调用方（actions 层）按前缀打日志：
 *   - "outline_json_parse_error: ..."
 *   - "outline_shape_invalid: ..."
 *   - "outline_scene_count_invalid: ..."
 *   - "llm_empty_content"
 *   - 其他原始 SDK / 网络错误
 */

const MIN_SCENES = 6;
const MAX_SCENES = 30;

export interface GenerateOutlineInput {
  projectId: string;
  mode: ProjectType;
  /** 用户的原始创作想法 */
  prompt: string;
  /** 最近对话历史（已截断到 20 轮 / 16k 字符） */
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
}

export async function generateOutline(
  input: GenerateOutlineInput,
): Promise<VideoOutline> {
  // image模式下：先为整个视频生成一个统一的画面风格
  let globalStylePrompt: string | undefined;
  if (input.mode === "image") {
    globalStylePrompt = await generateGlobalStylePrompt(input.prompt, input.history);
  }

  const system = buildOutlineSystemPrompt(input.mode, globalStylePrompt);
  const messages = input.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: "user", content: input.prompt });

  const raw = await callLLM({ system, messages });
  return parseOutlineResponse(raw, input.mode, globalStylePrompt);
}

/**
 * 为图片轮播视频生成全局风格提示词。
 * 基于用户的创作想法，生成一组合一的画面风格描述，
 * 确保所有分镜的画面风格保持一致。
 */
async function generateGlobalStylePrompt(
  prompt: string,
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  const styleSystem = `你是 AI 视频创作助手的大纲生成器。

# 你的任务
根据用户的创作想法，分析视频主题和内容，从以下维度为整个视频生成一组合一的全局画面风格描述：

1. **整体风格（Overall Style）**：写实 / 插画 / 3D 渲染 / 水彩 / 赛博朋克 / 宫崎骏风格 等
2. **光照与色调（Lighting & Color Palette）**：柔和日光 / 戏剧性暗光 / 赛博朋克霓虹 / 暖色调 / 冷色调 等
3. **摄影与构图（Composition）**：电影感宽屏 / 特写镜头 / 远景全景 / 对称构图 等
4. **氛围关键词（Mood Keywords）**：史诗感 / 温馨 / 神秘 / 科技感 / 复古 等

生成一段2-4 句话的英文风格描述，要涵盖以上所有维度，这段文字会被 prepended 到每个分镜的画面提示词前面。

直接输出纯文本风格描述，不要 JSON，不要 Markdown 围栏，不要解释。`;

  const messages = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: prompt },
  ];

  const raw = await callLLM({ system: styleSystem, messages });
  return raw.trim();
}

function buildOutlineSystemPrompt(mode: ProjectType, globalStylePrompt?: string): string {
  const modeBlock =
    mode === "html"
      ? `# 当前模式：HTML 动画视频
你正在为「网页动画视频」模式输出分镜大纲。画面提示词 \`prompt\` 必须用中文写成网页动画规格（这是后续「分镜 HTML 生成器」直接拿来写代码的依据），必须覆盖以下维度：
- **屏幕元素**：屏幕上要出现哪些 HTML/CSS 元素（如 div / svg / canvas / img / 文字节点）
- **元素动作**：每个元素如何运动（位移 / 旋转 / 缩放 / 透明度 / 形变 / 路径）
- **缓动与时长**：缓动函数（ease-in / ease-out / linear / cubic-bezier）与每个动作的持续时长（秒）
- **整体氛围**：配色（主色 / 辅色 / 背景色）、字体、风格基调（极简 / 卡通 / 科幻 / 中国风 等）
- **镜头与版式**：版心比例（16:9 / 9:16 / 1:1）、主要元素在屏幕的相对位置

请把每个分镜的 \`prompt\` 写成一段连续的中文描述，描述清楚「画什么 + 怎么动 + 多长时间」，避免空泛形容词。`
      : `# 当前模式：图片轮播视频
画面提示词 \`prompt\` 必须用英文写成图片生成提示词（Stable Diffusion / Midjourney 风格），覆盖：
- 主体（subject）：画面里有什么
- 风格（style）：写实 / 插画 / 3D / 水彩 等
- 光照（lighting）：柔和 / 戏剧性 / 逆光 等
- 构图（composition）：特写 / 远景 / 居中 / 三分法 等
- 调色（palette）：暖色 / 冷色 / 高饱和 等`;

  const globalStyleNote = globalStylePrompt
    ? `# 全局风格参考
以下是你生成的全局画面风格描述，所有分镜的 prompt 必须以这段文字开头：
"${globalStylePrompt}"

每个分镜的 \`prompt\` 字段格式为：【全局风格描述】+【本分镜具体画面内容】
例：${globalStylePrompt.slice(0, 80)}..., a dragon flying over mountains`
    : "";

  return `你是一个网页动画视频设计工程师，同时承担 AI 视频创作助手的大纲生成器职责。${
    mode === "html"
      ? `你的核心工作是把用户的创作想法拆解成一组分镜，并为每个分镜写清楚「网页里要实现什么动画」。\n后续会有另一位「分镜 HTML 生成器」基于你写的 prompt 写出真实可运行的 HTML/CSS/JS 代码，所以你给出的 prompt 必须能让对方直接动手写代码。`
      : `你的核心工作是把用户的创作想法拆解成一组分镜，并为每个分镜写清楚「画面里要呈现什么视觉内容」，由图片生成模型据此出图。`
  }

# 你的任务
基于用户的创作想法（最后一条 user 消息），输出严格的 JSON 对象，不要包含 Markdown 围栏、注释或额外文字。

# 流程
1. **先写完整逐字稿**：在脑海里先把整个视频的旁白写出来，作为 \`script\` 字段。一镜一段，段与段之间用换行分隔。
2. **再拆分成 6 到 30 个分镜**：把逐字稿按内容切分到 \`scenes\` 数组中，每个分镜对应一个连续的旁白段。
3. **每个分镜必须包含**：
   - \`index\`: 1 起始的整数，密集（1..N 无空缺）
   - \`title\`: 短标题（不超过 20 字）
   - \`narration\`: 该分镜的旁白（与 script 中对应段一致）
   - \`prompt\`: 画面提示词（见下方模式说明）

${modeBlock}

${globalStyleNote}

# 数量约束
- scenes 数组长度必须在 ${MIN_SCENES} 到 ${MAX_SCENES} 之间
- 宁可拆细一点（更多分镜），也不要堆在少数几个长镜里

# 返回 JSON 格式
{
  "script": "完整逐字稿（中文）。多段用换行分隔。",
  "scenes": [
    { "index": 1, "title": "...", "narration": "...", "prompt": "..." },
    ...
  ]
}

# 注意事项
- 严格输出 JSON，不要加任何解释
- 不要使用 Markdown 代码块围栏
- prompt 内容要直接可用，不要写"我建议你画一个..."这种元描述`;
}

export function parseOutlineResponse(
  raw: string,
  mode: ProjectType,
  globalStylePrompt?: string,
): VideoOutline {
  const text = stripCodeFence(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`outline_json_parse_error: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("outline_shape_invalid: not an object");
  }
  const obj = parsed as Record<string, unknown>;
  const script = obj.script;
  const rawScenes = obj.scenes;
  if (typeof script !== "string" || script.trim().length === 0) {
    throw new Error("outline_shape_invalid: script missing");
  }
  if (!Array.isArray(rawScenes)) {
    throw new Error("outline_shape_invalid: scenes is not an array");
  }
  if (rawScenes.length < MIN_SCENES || rawScenes.length > MAX_SCENES) {
    throw new Error(
      `outline_scene_count_invalid: got ${rawScenes.length}, want ${MIN_SCENES}..${MAX_SCENES}`,
    );
  }
  const scenes: OutlineScene[] = [];
  for (let i = 0; i < rawScenes.length; i++) {
    const v = rawScenes[i];
    if (!v || typeof v !== "object") {
      throw new Error(`outline_shape_invalid: scene[${i}] not an object`);
    }
    const s = v as Record<string, unknown>;
    const index = s.index;
    const title = s.title;
    const narration = s.narration;
    const prompt = s.prompt;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 1) {
      throw new Error(`outline_shape_invalid: scene[${i}].index invalid`);
    }
    if (typeof title !== "string" || title.trim().length === 0) {
      throw new Error(`outline_shape_invalid: scene[${i}].title invalid`);
    }
    if (typeof narration !== "string" || narration.trim().length === 0) {
      throw new Error(`outline_shape_invalid: scene[${i}].narration invalid`);
    }
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new Error(`outline_shape_invalid: scene[${i}].prompt invalid`);
    }
    // image模式下，将全局风格 prepended 到 scene prompt 前面
    const fullPrompt = globalStylePrompt
      ? `${globalStylePrompt} ${prompt.trim()}`
      : prompt.trim();
    scenes.push({
      index,
      title: title.slice(0, 80),
      narration: narration.slice(0, 1000),
      prompt: fullPrompt.slice(0, 2000),
    });
  }
  // 校验 index 密集：1..N 无空缺无重复
  scenes.sort((a, b) => a.index - b.index);
  for (let i = 0; i < scenes.length; i++) {
    if (scenes[i].index !== i + 1) {
      throw new Error(
        `outline_shape_invalid: indices not dense, expected ${i + 1} got ${scenes[i].index}`,
      );
    }
  }
  return {
    mode,
    script: script.slice(0, 20000),
    globalStylePrompt,
    scenes,
    generatedAt: new Date().toISOString(),
  };
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1].trim();
  return trimmed;
}
