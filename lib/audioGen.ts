import "server-only";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 语音合成模块（gpt-4o-mini-tts）。
 *
 * 使用 OpenAI 兼容接口调用 TTS 服务，
 * 生成的音频直接保存到本地项目目录。
 */

/* ---------------------------------------------------------------------------
 * 配置
 * ------------------------------------------------------------------------- */

function getAudioConfig() {
  const baseURL = process.env.LLM_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!baseURL) {
    throw new Error("LLM_BASE_URL 未配置。");
  }
  if (!apiKey) {
    throw new Error("LLM_API_KEY 未配置。");
  }
  return { baseURL, apiKey };
}

function resolveVoice(): string {
  const fromEnv = process.env.AUDIO_VOICE?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : "shimmer";
}

/** 全片统一的 TTS 语气指令，避免各分镜语调漂移 */
function resolveAudioInstructions(): string {
  const fromEnv = process.env.AUDIO_INSTRUCTIONS?.trim();
  if (fromEnv) return fromEnv;
  return [
    "用标准、自然、平稳的普通话说出以下旁白。",
    "保持全片一致的音色、语速和情绪：专业清晰的讲解风格，像同一位解说员在连续录音。",
    "不要戏剧化，不要忽快忽慢，不要突然切换语气。",
    "遇到专业术语时读得稍慢、吐字清楚。",
  ].join("");
}

function resolveAudioSpeed(): number {
  const raw = process.env.AUDIO_SPEED?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.25 || n > 4) return 1;
  return n;
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

function projectAudioDir(projectId: string): string {
  return path.join(dataRoot(), projectId, "audio");
}

/* ---------------------------------------------------------------------------
 * 类型
 * ------------------------------------------------------------------------- */

export interface GenerateAudioInput {
  projectId: string;
  sceneIndex: number;
  /** 要朗读的旁白文本 */
  narration: string;
}

export interface GenerateAudioResult {
  relativePath: string;
  absolutePath: string;
}

/* ---------------------------------------------------------------------------
 * 核心生成函数
 * ------------------------------------------------------------------------- */

export async function generateAudio(
  input: GenerateAudioInput,
): Promise<GenerateAudioResult> {
  const { projectId, sceneIndex, narration } = input;

  const { baseURL, apiKey } = getAudioConfig();
  const voice = resolveVoice();
  const instructions = resolveAudioInstructions();
  const speed = resolveAudioSpeed();

  const audioDir = projectAudioDir(projectId);
  await mkdir(audioDir, { recursive: true });

  const fileName = `${sceneIndex}.mp3`;
  const relativePath = path.join("audio", fileName);
  const absolutePath = path.join(audioDir, fileName);

  // 调用 TTS API
  const response = await fetch(`${baseURL}/audio/speech`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      input: narration,
      voice,
      instructions,
      speed,
      response_format: "mp3",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`audio_generation_failed: HTTP ${response.status}: ${text}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(absolutePath, buffer);

  return { relativePath, absolutePath };
}