import "server-only";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { callLLMRaw } from "./ai";
import type { OutlineScene } from "./outlineTypes";

/**
 * 分镜 HTML 动画生成器。
 *
 * 流程（仅在 HTML 模式下调用）：
 *  1. 拼装 system prompt：明确"网页动画视频设计工程师"身份 + 写一份可直接运行的
 *     HTML 页面（包含 <style> 和 <script>）的要求
 *  2. user message：目标分镜的标题 / 旁白 / 画面提示词 + 上一镜的 HTML 代码（如果有）
 *  3. 解析返回：剥掉 Markdown 围栏 / ```html 围栏；如果 LLM 仍然回了一段解释就拿首段 <!DOCTYPE> 或 <html> 切出来
 *  4. 落到项目目录 <projectDir>/scenes/<index>.html
 *  5. 返回相对路径 scenes/<index>.html
 *
 * 设计要点：
 *  - 保持视觉风格一致：把上一镜的 HTML 完整地附在上下文里，让 LLM 在配色 / 字体 / 风格
 *    上自然延续（不强制"逐字继承"，但要求"协调统一"）
 *  - 提示词长度大、温度低（继承 outline.ts 的 0.2），让 LLM 偏向"写代码"而不是"聊设计"
 *  - HTML 不做 XSS 转义：这是我们自己写、自己消费的代码；iframe srcdoc 渲染时天然隔离
 *  - 不依赖任何额外 SDK，纯字符串拼接 + 文件 IO
 */

const HTML_SYSTEM_PROMPT = `你是一个网页动画视频设计工程师。

# 你的任务
根据「目标分镜」的标题、旁白、画面提示词，输出一个完整、可直接运行的 HTML 页面（包含 <!DOCTYPE html>、<html>、<head>、<body>、内联 <style> 与 <script>），用来承载这一个分镜的网页动画。动画会被嵌入到视频播放器中自动循环播放，配合旁白音频。

# 内容对齐（最重要）
- 动画必须**可视化旁白正在讲的内容**：旁白提到的对象、过程、对比、比喻，都应在画面中有对应元素
- 若旁白在解释抽象概念，用图标/流程/标签/箭头/数字等辅助理解，不要只做无关背景特效
- 画面提示词与旁白冲突时，以**旁白语义**为准

# 输出要求
1. **必须是完整 HTML 页面**：以 <!DOCTYPE html> 开头，以 </html> 结尾，包含 head 和 body
2. **动画技术**：用 HTML + CSS（@keyframes / transition / transform / animation / filter）+ JS（setTimeout / requestAnimationFrame / Web Animations API）+ SVG / Canvas。多种技术可以组合使用
3. **时长**：单镜动画时长 4-12 秒，循环播放；多个元素的起止时间错开，让画面"动起来"而不是一闪而过
4. **视觉规格**：
   - 根容器建议使用 class \`video-canvas\`（16:9，默认 \`aspect-ratio: 16/9\`）；内置标题/字幕容器可用 \`.header\`、\`.subtitle-container\`
   - 背景与画布比例遵循画面提示词
   - 配色 / 字体 / 风格基调用「上一个分镜的 HTML」作为参考，保持整组视频的视觉一致性
   - 元素要"在屏幕中"：不要让元素跑出可视区导致看不到
5. **稳定运行**：动画要可循环（用 infinite 或在末尾加 reset），不要做 fetch / 外部资源引用
6. **代码风格**：HTML / CSS / JS 写在同一个文件里，结构清晰；变量名 / 类名用英文
7. **不要做的**：不要写说明文字、不要 Markdown 围栏、不要解释、不要把"示例"或"思路"作为注释残留到最终代码中

# 关于"上一个分镜的 HTML"
如果上下文里有上一个分镜的 HTML 代码（标注为"上一镜 HTML 参考"），请**保持视觉风格的延续**：
- 沿用相同的色系 / 字体 / 风格基调
- 元素排版与转场思路可以呼应
- 不需要逐字复制，可以演进，但避免突兀的视觉跳跃

# 输出格式
仅输出 HTML 代码本身，从 <!DOCTYPE html> 开头，到 </html> 结尾，前后不要有其他内容。`;

export interface GenerateSceneHtmlInput {
  projectId: string;
  scene: OutlineScene;
  /** 上一镜的 HTML（用于视觉风格延续），可选：第一镜时为 null */
  previousHtml: string | null;
  /** 上一镜的 index（调试 / 标识用），可选 */
  previousIndex?: number | null;
}

export interface GenerateSceneHtmlResult {
  relativePath: string;
  absolutePath: string;
  /** 实际写盘的内容（去掉围栏后的纯净 HTML） */
  html: string;
}

export async function generateSceneHtml(
  input: GenerateSceneHtmlInput,
): Promise<GenerateSceneHtmlResult> {
  const { projectId, scene, previousHtml, previousIndex } = input;

  // 1) 拼装 user message
  const parts: string[] = [];
  parts.push(`# 目标分镜`);
  parts.push(`标题：${scene.title}`);
  parts.push(`旁白：${scene.narration}`);
  parts.push(`画面提示词（网页动画规格）：${scene.prompt}`);
  parts.push(`内容对齐：动画必须直接可视化旁白中的核心概念，不要跑题。`);
  parts.push("");
  if (previousHtml && previousIndex != null) {
    parts.push(`# 上一镜 HTML 参考（第 ${previousIndex} 镜）`);
    parts.push("请保持视觉风格与上一镜一致（配色 / 字体 / 风格基调可以延续，但不要逐字复制）。");
    parts.push("");
    parts.push("```html");
    parts.push(previousHtml);
    parts.push("```");
    parts.push("");
  } else {
    parts.push(`# 上一镜 HTML 参考`);
    parts.push(`这是视频的第一镜，没有上一镜。请为整组视频定下视觉风格基调（配色 / 字体 / 整体氛围），后续分镜会与这一镜保持一致。`);
    parts.push("");
  }
  parts.push(`# 请输出第 ${scene.index} 镜的 HTML 代码`);
  const userContent = parts.join("\n");

  // 2) 调 LLM：关掉 JSON 模式，让 LLM 直接输出 HTML 字符串。
  //    （开了 json_object 的话 LLM 会把整段 HTML 包成 {"html": "..."} 然后 \n
  //    还会被转义成字面字符，反而要写更多解析代码。）
  const raw = await callLLMRaw({
    system: HTML_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userContent }],
    jsonMode: false,
  });

  // 3) 提取纯净 HTML
  const html = extractHtml(raw);
  if (!html || html.trim().length === 0) {
    throw new Error("html_gen_empty: LLM returned empty HTML after cleanup");
  }

  // 4) 写盘
  const scenesDir = path.join(projectScenesDir(projectId));
  await mkdir(scenesDir, { recursive: true });
  const fileName = `${scene.index}.html`;
  const relativePath = path.join("scenes", fileName);
  const absolutePath = path.join(scenesDir, fileName);
  await writeFile(absolutePath, html, "utf-8");

  return { relativePath, absolutePath, html };
}

/* ---------------------------------------------------------------------------
 * 路径
 * ------------------------------------------------------------------------- */

function dataRoot(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  return fromEnv
    ? path.resolve(fromEnv)
    : path.join(process.cwd(), "data", "projects");
}

function projectScenesDir(projectId: string): string {
  return path.join(dataRoot(), projectId, "scenes");
}

/* ---------------------------------------------------------------------------
 * 提取纯净 HTML
 *
 * LLM 偶尔会回：
 *   - 围栏：```html ... ``` / ``` ... ```
 *   - 解释 + 代码：先讲两句"下面是代码"再写 <!DOCTYPE>
 *   - 直接给代码
 * 这里统一剥掉前两种，只留下 HTML 本身。
 * ------------------------------------------------------------------------- */

function extractHtml(raw: string): string {
  let text = raw.trim();

  // 0) 由于 ai.ts 全局开了 response_format: json_object，LLM 会把 HTML 包成
  //    `{"html": "<!DOCTYPE html>..."}` 这种 JSON 形态返回（string 里的 \n
  //    仍然是字面字符）。这里尝试先 JSON.parse 一层把 string 字段解出来。
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed === "string") {
        text = parsed;
      } else if (parsed && typeof parsed === "object") {
        // 找一个包含 <!DOCTYPE 或 <html 的 string 字段
        for (const v of Object.values(parsed as Record<string, unknown>)) {
          if (typeof v === "string" && /<!doctype\s+html|<html[\s>]/i.test(v)) {
            text = v;
            break;
          }
        }
      }
    } catch {
      // JSON.parse 失败就走下面的兜底流程
    }
  }

  // 1) 去掉 ```html ... ``` 围栏
  const fenceMatch = text.match(/^```(?:html|HTML)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // 2) 兜底：把首段 <!DOCTYPE ...> 之前的所有解释文字去掉
  const doctypeIdx = text.search(/<!doctype\s+html/i);
  if (doctypeIdx > 0) {
    text = text.slice(doctypeIdx);
  } else if (doctypeIdx < 0) {
    // 连 <!DOCTYPE> 都没有，但也许有 <html> 起点
    const htmlIdx = text.search(/<html[\s>]/i);
    if (htmlIdx > 0) text = text.slice(htmlIdx);
  }

  // 3) 兜底：把最后 </html> 之后的所有尾巴去掉（有时 LLM 会写"以上是完整代码"）
  const endIdx = text.toLowerCase().lastIndexOf("</html>");
  if (endIdx >= 0) {
    text = text.slice(0, endIdx + "</html>".length);
  }

  return text.trim();
}
