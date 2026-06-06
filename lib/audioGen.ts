import "server-only";

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { parseBuffer } from "music-metadata";
import { computeSceneAudioSlices } from "@/lib/audioSlices";
import type { OutlineScene } from "@/lib/outlineTypes";

/**
 * 语音合成模块（gpt-4o-mini-tts）。
 *
 * 整片一次 TTS 录音，再按各镜旁白字数比例切分为分镜 mp3，
 * 保证全片音色、语速、情绪一致。
 */

const execFileAsync = promisify(execFile);

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
function resolveAudioInstructions(forFullScript: boolean): string {
  const fromEnv = process.env.AUDIO_INSTRUCTIONS?.trim();
  const base =
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : [
          "用标准、自然、平稳的普通话说出以下旁白。",
          "保持全片一致的音色、语速和情绪：专业清晰的讲解风格，像同一位解说员在连续录音。",
          "不要戏剧化，不要忽快忽慢，不要突然切换语气。",
          "遇到专业术语时读得稍慢、吐字清楚。",
        ].join("");
  if (!forFullScript) return base;
  return `${base}按顺序朗读以下各段旁白，段与段之间作自然短停顿，全片一次录完，不要分段重读。`;
}

function resolveAudioSpeed(): number {
  const raw = process.env.AUDIO_SPEED?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.25 || n > 4) return 1;
  return n;
}

function resolveFfmpegPath(): string {
  const fromEnv = process.env.FFMPEG_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  // Next 打包后 ffmpeg-static 的 default import 会指向错误路径，直接从 node_modules 取
  const direct = path.join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");
  if (existsSync(direct)) return direct;

  const req = createRequire(path.join(process.cwd(), "package.json"));
  const fromPkg = req("ffmpeg-static") as string | null;
  if (fromPkg && existsSync(fromPkg)) return fromPkg;

  throw new Error("ffmpeg_static_missing: 无法找到 ffmpeg 可执行文件，请确认已安装 ffmpeg-static");
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

export interface GenerateProjectAudiosInput {
  projectId: string;
  scenes: Pick<OutlineScene, "index" | "narration">[];
}

export interface GenerateProjectAudiosResult {
  /** sceneIndex -> 相对路径 audio/N.mp3 */
  scenePaths: Record<number, string>;
  /** 整段录音 audio/full.mp3 */
  fullRelativePath: string;
}

/* ---------------------------------------------------------------------------
 * 核心：整段录音 + 切分
 * ------------------------------------------------------------------------- */

export async function generateProjectAudios(
  input: GenerateProjectAudiosInput,
): Promise<GenerateProjectAudiosResult> {
  const { projectId, scenes } = input;
  if (scenes.length === 0) {
    throw new Error("audio_no_scenes: 没有可分镜的旁白");
  }

  const sorted = [...scenes].sort((a, b) => a.index - b.index);
  const fullText = buildFullNarrationText(sorted);
  if (fullText.length === 0) {
    throw new Error("audio_empty_narration: 旁白文本为空");
  }

  const audioDir = projectAudioDir(projectId);
  await mkdir(audioDir, { recursive: true });

  const fullAbsolutePath = path.join(audioDir, "full.mp3");
  const fullRelativePath = path.join("audio", "full.mp3");

  const mp3Buffer = await synthesizeSpeech(fullText, true);
  await writeFile(fullAbsolutePath, mp3Buffer);

  const totalDurationSec = await readMp3DurationSec(mp3Buffer);
  const slices = computeSceneAudioSlices(sorted, totalDurationSec);

  const scenePaths: Record<number, string> = {};
  for (const slice of slices) {
    const fileName = `${slice.index}.mp3`;
    const absolutePath = path.join(audioDir, fileName);
    await splitMp3Segment(fullAbsolutePath, absolutePath, slice.startSec, slice.durationSec);
    scenePaths[slice.index] = path.join("audio", fileName);
  }

  return { scenePaths, fullRelativePath };
}

/* ---------------------------------------------------------------------------
 * 内部工具
 * ------------------------------------------------------------------------- */

function buildFullNarrationText(
  scenes: Pick<OutlineScene, "index" | "narration">[],
): string {
  return scenes
    .map((s) => s.narration.trim())
    .filter((s) => s.length > 0)
    .join("\n");
}

async function synthesizeSpeech(fullText: string, forFullScript: boolean): Promise<Buffer> {
  const { baseURL, apiKey } = getAudioConfig();
  const voice = resolveVoice();
  const instructions = resolveAudioInstructions(forFullScript);
  const speed = resolveAudioSpeed();

  const response = await fetch(`${baseURL}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini-tts",
      input: fullText,
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

  return Buffer.from(await response.arrayBuffer());
}

async function readMp3DurationSec(buffer: Buffer): Promise<number> {
  const meta = await parseBuffer(buffer, { mimeType: "audio/mpeg" });
  const duration = meta.format.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("audio_duration_invalid: 无法读取整段 mp3 时长");
  }
  return duration;
}

async function splitMp3Segment(
  inputPath: string,
  outputPath: string,
  startSec: number,
  durationSec: number,
): Promise<void> {
  const ffmpeg = resolveFfmpegPath();
  await execFileAsync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inputPath,
    "-ss",
    startSec.toFixed(3),
    "-t",
    durationSec.toFixed(3),
    "-acodec",
    "libmp3lame",
    "-q:a",
    "4",
    outputPath,
  ]);
}
