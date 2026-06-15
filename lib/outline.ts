import "server-only";
import { callLLM } from "./ai";
import {
  buildSceneImagePrompt,
  globalStyleToProse,
  normalizeGlobalStylePrompt,
  tryParseGlobalStyleJson,
} from "./imagePrompt";
import type { VideoOutline, OutlineScene } from "./outlineTypes";
import type { ProjectType } from "./projectTypes";
import type { VideoSize } from "./exportVideo";
import { videoSizeSpecForLlm } from "./exportVideo";

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
  /** 视频画幅（写入大纲并影响 prompt 排版描述） */
  videoSize: VideoSize;
}

export async function generateOutline(
  input: GenerateOutlineInput,
): Promise<VideoOutline> {
  // image模式下：先为整个视频生成一个统一的画面风格
  let globalStylePrompt: string | undefined;
  if (input.mode === "image") {
    globalStylePrompt = await generateGlobalStylePrompt(
      input.prompt,
      input.history,
      input.videoSize,
    );
    globalStylePrompt = normalizeGlobalStylePrompt(globalStylePrompt);
  }

  const system = buildOutlineSystemPrompt(input.mode, input.videoSize, globalStylePrompt);
  const messages = input.history.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  messages.push({ role: "user", content: input.prompt });

  const raw = await callLLM({ system, messages });
  return parseOutlineResponse(raw, input.mode, input.videoSize, globalStylePrompt);
}

/**
 * 为图片轮播视频生成全局风格提示词。
 * 基于用户的创作想法，生成一组合一的画面风格描述，
 * 确保所有分镜的画面风格保持一致。
 */
async function generateGlobalStylePrompt(
  prompt: string,
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
  videoSize: VideoSize,
): Promise<string> {
  const aspectNote = videoSize.height > videoSize.width
    ? "composition：竖屏 9:16，主体居中，上下留白，适合手机观看"
    : "composition：16:9 宽屏，居中主体、留白字幕区等";

  const styleSystem = `你是 AI 视频创作助手的大纲生成器，专注「图片轮播 + 旁白讲解」类短视频（人物传记、历史事件、知识科普、文化解读等）。

# 画幅
${videoSizeSpecForLlm(videoSize)}

# 你的任务
根据用户的创作想法，为整组视频输出**一套统一的全局画面风格**（JSON 对象）。后续每个分镜只会单独描述「本镜主体画面」，不会再重复写风格，因此请把风格信息写全。

# 字段说明（全部用英文填写）
- visualMotif：贯穿全片的视觉母题（如 historical portrait series / documentary photo essay / illustrated timeline）
- overallStyle：整体画风（写实摄影 / 纪实插画 / 油画质感 / 3D 等）
- lightingColor：光照与主色调
- composition：构图习惯（${aspectNote}）
- mood：氛围关键词

# 题材提示
- 讲人物：偏向肖像、代表性场景、时代符号，风格庄重或传记感
- 讲事件：偏向时间节点、地点、群像与关键物件，偏纪实或历史插画
- 讲概念：可用隐喻画面，但仍需清晰、易懂、不跑题

# 输出格式（严格 JSON，不要 Markdown 围栏）
{
  "visualMotif": "...",
  "overallStyle": "...",
  "lightingColor": "...",
  "composition": "...",
  "mood": "..."
}`;

  const messages = [
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    { role: "user" as const, content: prompt },
  ];

  const raw = await callLLM({ system: styleSystem, messages });
  const parsed = tryParseGlobalStyleJson(raw);
  if (parsed) return globalStyleToProse(parsed);

  // 兜底：模型未按 JSON 返回时仍归一化为 prose
  return normalizeGlobalStylePrompt(raw);
}

function buildOutlineSystemPrompt(
  mode: ProjectType,
  videoSize: VideoSize,
  globalStylePrompt?: string,
): string {
  const sizeBlock = `# 视频画幅（硬性）
${videoSizeSpecForLlm(videoSize)}
所有分镜的 \`prompt\` 必须按此画幅设计版式与元素排布；竖屏禁止宽屏横向多栏拓扑，横屏禁止竖向长条堆叠占满全屏。`;

  const modeBlock =
    mode === "html"
      ? `# 当前模式：HTML 动画视频（适合数学定理、几何推导、公式变换、流程演示等）
你正在为「网页动画视频」模式输出分镜大纲。画面提示词 \`prompt\` 必须用中文写成网页动画规格（这是后续「分镜 HTML 生成器」直接拿来写代码的依据），必须覆盖以下维度：
- **旁白对应画面**：动画必须展示本镜 narration 正在讲解的概念/对象/过程（如定理条件、辅助线、公式步骤），不要用无关背景动画糊弄
- **屏幕元素**：屏幕上要出现哪些 HTML/CSS 元素（如 div / svg / canvas / 公式文字 / 几何图形）
- **元素动作**：每个元素如何运动（位移 / 旋转 / 缩放 / 透明度 / 形变 / 路径），推导步骤要按顺序出现
- **缓动与时长**：缓动函数（ease-in / ease-out / linear / cubic-bezier）与每个动作的持续时长（秒）
- **整体氛围**：配色（主色 / 辅色 / 背景色）、字体、风格基调（极简 / 卡通 / 科幻 / 课堂板书 等）
- **镜头与版式**：按上方画幅设计元素位置；竖屏优先上下排列，横屏可用左右分栏；字幕由播放器叠加，HTML 动画无需预留字幕区

请把每个分镜的 \`prompt\` 写成一段连续的中文描述，描述清楚「画什么 + 怎么动 + 多长时间」，避免空泛形容词。`
      : `# 当前模式：图片轮播视频（适合人物传记、历史事件、文化科普等「画面 + 旁白讲解」）
每个分镜的 \`prompt\` 字段**只写本镜主体画面的英文描述**（subject），不要重复全局风格（全局风格会由系统自动拼接一次）。

用 Stable Diffusion / Midjourney 风格英文，聚焦：
- **subject（主体）**：本镜 narration 正在讲的人物、事件、场景、物件或象征画面，必须贴题
- **action / context（情境）**：人物在做什么、事件发生在何时何地、与旁白一致的关键细节
- **shot（景别）**：portrait / medium shot / wide establishing shot / detail close-up 等（选一种即可）

不要在本镜 prompt 里写 overall style、lighting palette、mood 等全局项；不要输出 JSON。`;

  const globalStyleNote =
    mode === "image" && globalStylePrompt
      ? `# 全局风格（已生成，勿在分镜 prompt 中重复）
系统已为全片生成以下英文全局风格，**不要**写进各分镜的 \`prompt\` 字段：
"${globalStylePrompt}"

每个分镜的 \`prompt\` 仅写本镜 subject（英文短句或短语），例：
"A portrait of ...", "A wide shot of the battle at ...", "Close-up of an ancient manuscript showing ..."`
      : "";

  const roleIntro =
    mode === "html"
      ? `你是一个网页动画视频设计工程师，同时承担 AI 视频创作助手的大纲生成器职责。你的核心工作是把用户的创作想法（尤其是数学定理、几何证明、公式推导、步骤演示）拆解成一组分镜，并为每个分镜写清楚「网页里要实现什么动画」。后续会有「分镜 HTML 生成器」基于你写的 prompt 写出真实可运行的 HTML/CSS/JS 代码，所以你给出的 prompt 必须能让对方直接动手写代码。`
      : `你是一位擅长人物故事、历史事件与知识科普的短视频分镜师。你的核心工作是把用户的创作想法拆解成一组分镜：旁白负责讲解，画面负责呈现人物、场景与关键细节，由图片生成模型据此出图。`;

  return `${roleIntro}

# 你的任务
基于用户的创作需求（对话中最后一条 user 消息是最高优先级），输出严格的 JSON 对象，不要包含 Markdown 围栏、注释或额外文字。

# 贴题要求（最重要）
- 全片必须围绕用户指定的主题、问题或概念展开，不得跑题，不要堆砌与主题无关的百科内容
- 若用户指定了受众、时长、风格、重点或必须提到的术语，必须在 script 与 scenes 中落实
- 每个分镜的 \`prompt\` 必须**直接可视化该镜 \`narration\` 正在讲的内容**，禁止出现与旁白无关的 generic 装饰画面
- 分镜之间要有逻辑递进（引入 → 展开 → 举例/对比 → 总结），不要 6 个分镜重复讲同一件事

# 旁白与脚本要求
- \`script\` 与每镜 \`narration\` 使用口语化中文，适合 TTS 朗读
- 全片保持**同一讲解者**口吻：专业、清晰、不跳戏，避免有的分镜像新闻、有的像广告
- 每镜 \`narration\` 建议 15–55 字；用连接词让镜间过渡自然
- 避免生僻词连用、过长从句、英文缩写不解释

# 流程
1. **先写完整逐字稿**：在脑海里先把整个视频的旁白写出来，作为 \`script\` 字段。一镜一段，段与段之间用换行分隔。
2. **再拆分成 6 到 30 个分镜**：把逐字稿按内容切分到 \`scenes\` 数组中，每个分镜对应一个连续的旁白段。
3. **每个分镜必须包含**：
   - \`index\`: 1 起始的整数，密集（1..N 无空缺）
   - \`title\`: 短标题（不超过 20 字，概括本镜核心信息）
   - \`narration\`: 该分镜的旁白（与 script 中对应段一致）
   - \`prompt\`: 画面提示词（见下方模式说明；必须能回答「这一镜旁白在讲什么，画面应该看到什么」）

${sizeBlock}

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
- prompt 内容要直接可用，不要写"我建议你画一个..."这种元描述
- 输出前自检：随机抽 3 个分镜，确认 narration 与 prompt 是否一一对应、是否紧扣用户主题`;
}

export function parseOutlineResponse(
  raw: string,
  mode: ProjectType,
  videoSize: VideoSize,
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
    // image 模式：全局风格 + 本镜 subject 只拼一次
    const normalizedGlobal =
      mode === "image" && globalStylePrompt
        ? normalizeGlobalStylePrompt(globalStylePrompt)
        : "";
    const fullPrompt =
      mode === "image" && normalizedGlobal
        ? buildSceneImagePrompt(normalizedGlobal, prompt.trim())
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
    videoSize,
    script: script.slice(0, 20000),
    globalStylePrompt:
      mode === "image" && globalStylePrompt
        ? normalizeGlobalStylePrompt(globalStylePrompt)
        : globalStylePrompt,
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
