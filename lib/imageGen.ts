import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { enrichPromptForImageGeneration } from "./imagePrompt";
import { imageSizeString, type VideoSize } from "./exportVideo";

/**
 * ModelScope / z-image-turbo 图片生成模块。
 *
 * ModelScope API 采用异步任务模式：
 *  1. 提交生成请求（带 X-ModelScope-Async-Mode: true）
 *  2. 轮询任务状态（带 X-ModelScope-Task-Type: image_generation）
 *  3. SUCCEED 后从 output_images 拿到图片 URL，下载并保存为本地文件
 */

/* ---------------------------------------------------------------------------
 * 客户端配置
 * ------------------------------------------------------------------------- */

function resolveImageModel(): string {
  const fromEnv = process.env.IMAGE_MODEL?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "Tongyi-MAI/Z-Image-Turbo";
}

/** 与 VideoPreview 导出一致的 16:9 画幅，可通过 IMAGE_SIZE 覆盖 */
function resolveImageSize(): string {
  const fromEnv = process.env.IMAGE_SIZE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "1280x720";
}

const DEFAULT_NEGATIVE_PROMPT =
  "text, watermark, logo, signature, blurry, low quality, deformed, extra limbs, bad anatomy, cropped, out of frame, cluttered border, split screen";

function resolveNegativePrompt(): string {
  const fromEnv = process.env.IMAGE_NEGATIVE_PROMPT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_NEGATIVE_PROMPT;
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

function projectImagesDir(projectId: string): string {
  return path.join(dataRoot(), projectId, "images");
}

/* ---------------------------------------------------------------------------
 * 核心生成函数
 * ------------------------------------------------------------------------- */

export interface GenerateImageInput {
  projectId: string;
  sceneIndex: number;
  prompt: string;
  /** 图片生成尺寸，如 1280x720；未传则用环境变量或默认横屏 */
  imageSize?: string;
  videoSize?: VideoSize;
}

export interface GenerateImageResult {
  relativePath: string;
  absolutePath: string;
}

/**
 * ModelScope 异步图片生成：
 *  1. 提交任务（带 X-ModelScope-Async-Mode: true）获取 task_id
 *  2. 轮询任务状态（带 X-ModelScope-Task-Type: image_generation）
 *  3. SUCCEED 后从 output_images[0] 下载图片并保存到本地
 */
export async function generateImage(
  input: GenerateImageInput,
): Promise<GenerateImageResult> {
  const { projectId, sceneIndex, prompt, imageSize, videoSize } = input;

  const baseURL = process.env.IMAGE_BASE_URL?.trim()!;
  const apiKey = process.env.IMAGE_API_KEY?.trim()!;
  const model = resolveImageModel();
  const size = imageSize ?? (videoSize ? imageSizeString(videoSize) : resolveImageSize());
  const negativePrompt = resolveNegativePrompt();
  const finalPrompt = enrichPromptForImageGeneration(prompt, videoSize);

  const submitRes = await fetch(`${baseURL}/images/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-ModelScope-Async-Mode": "true",
    },
    body: JSON.stringify({
      model,
      prompt: finalPrompt,
      size,
      negative_prompt: negativePrompt,
    }),
  });

  if (!submitRes.ok) {
    const text = await submitRes.text();
    throw new Error(`image_submit_failed: HTTP ${submitRes.status}: ${text}`);
  }

  const submitJson = await submitRes.json();
  const taskId = submitJson.task_id;
  if (!taskId) {
    throw new Error(`image_submit_no_task_id: response=${JSON.stringify(submitJson)}`);
  }
  console.log(`[generateImage] scene ${sceneIndex} submitted task_id=${taskId}`);

  // Step 2: 轮询任务状态
  const maxAttempts = 30;
  const pollIntervalMs = 5000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await sleep(pollIntervalMs);

    const statusRes = await fetch(`${baseURL}/tasks/${taskId}`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-ModelScope-Task-Type": "image_generation",
      },
    });

    if (!statusRes.ok) {
      const text = await statusRes.text();
      console.error(`[generateImage] scene ${sceneIndex} poll HTTP ${statusRes.status}:`, text);
      continue;
    }

    const taskJson = await statusRes.json();
    console.log(`[generateImage] scene ${sceneIndex} poll attempt ${attempt + 1}:`, JSON.stringify(taskJson));

    if (taskJson.task_status === "SUCCEED") {
      const outputImages: string[] | undefined = taskJson.output_images;
      if (!outputImages || outputImages.length === 0) {
        throw new Error(`image_no_output: scene ${sceneIndex} SUCCEED but no output_images`);
      }
      const imageUrl = outputImages[0];
      console.log(`[generateImage] scene ${sceneIndex} downloading from ${imageUrl}`);

      // Step 3: 下载图片
      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        throw new Error(`image_download_failed: scene ${sceneIndex} HTTP ${imgRes.status}`);
      }
      const arrayBuffer = await imgRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const ext = "png";
      const imagesDir = projectImagesDir(projectId);
      await mkdir(imagesDir, { recursive: true });
      const fileName = `${sceneIndex}.${ext}`;
      const relativePath = path.join("images", fileName);
      const absolutePath = path.join(imagesDir, fileName);
      await writeFile(absolutePath, buffer);
      console.log(`[generateImage] scene ${sceneIndex} saved to ${absolutePath}`);
      return { relativePath, absolutePath };
    }

    if (taskJson.task_status === "FAILED") {
      throw new Error(`image_generation_failed: ModelScope task FAILED for scene ${sceneIndex}`);
    }
  }

  throw new Error(`image_polling_timeout: scene ${sceneIndex} — max ${maxAttempts} polls reached`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}