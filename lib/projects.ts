import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PersistedChatMessage } from "./chatTypes";
import { INTENT_ACTIONS } from "./intents";
import { estimateSceneDurationSec } from "./narration";
import type { VideoOutline, OutlineScene } from "./outlineTypes";
import { normalizeVideoSize, DEFAULT_VIDEO_SIZE, type VideoSize } from "./exportVideo";
import {
  PROJECT_TYPE_LABEL,
  type ProjectDetail,
  type ProjectSummary,
  type ProjectType,
} from "./projectTypes";

export {
  PROJECT_TYPE_LABEL,
  type PersistedChatMessage,
  type ProjectDetail,
  type ProjectSummary,
  type ProjectType,
  type VideoOutline,
  type OutlineScene,
};

/* ---------------------------------------------------------------------------
 * 文件布局
 *
 *   <DATA_DIR>/                  默认 ./data/projects
 *     <uuid>/                    每个项目一个目录，名字就是 uuid
 *       meta.json                小文件：uuid / title / type / createdAt
 *       storyboard.txt           大字符串：完整分镜大纲
 *       source.txt               大字符串：视频源码
 *       chat.json                数组：[{ id, role, content, createdAt, intent?, error? }, ...]
 *
 * 设计要点：
 *   - 列表查询只读 meta.json，不触碰巨大的 storyboard/source，开销极低
 *   - 写文件统一走「写临时文件 + rename」，避免半截写入污染数据
 *   - meta.json 字段缺失 / 损坏的目录会被 listProjects 跳过而非崩溃
 *   - chat.json 损坏时会被改名为 chat.json.corrupt-<ts>，避免后续 append
 *     持续往一个不可解析的文件里写
 * ------------------------------------------------------------------------- */

const META_FILE = "meta.json";
const STORYBOARD_FILE = "storyboard.txt";
const SOURCE_FILE = "source.txt";
const CHAT_FILE = "chat.json";
const IMAGES_DIR = "images";
const AUDIO_DIR = "audio";
const SCENES_DIR = "scenes";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------------------
 * 写并发控制：单进程内每个 uuid 一条串行链
 *
 * 读改写是经典竞态：两个 append 同时读 [A]，分别写 [A,B] 和 [A,C]，最后
 * 落盘的人赢，另一条消息凭空消失。Map<uuid, Promise> 串行化每次写即可。
 * 锁不需要跨进程：本应用是单实例 Node，下一轮才需要 Redis / 磁盘锁。
 * ------------------------------------------------------------------------- */
const chatLocks = new Map<string, Promise<unknown>>();

interface MetaFile {
  uuid: string;
  title: string;
  type: ProjectType;
  createdAt: string;
  videoSize?: VideoSize;
}

export function defaultTitleFor(type: ProjectType): string {
  return `未命名${PROJECT_TYPE_LABEL[type]}项目`;
}

/** 是否为新建项目时的默认标题（尚未手动命名） */
export function isDefaultProjectTitle(title: string, type: ProjectType): boolean {
  return title === defaultTitleFor(type);
}

function dataRoot(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  return fromEnv
    ? path.resolve(fromEnv)
    : path.join(process.cwd(), "data", "projects");
}

function projectDir(uuid: string): string {
  return path.join(dataRoot(), uuid);
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  await writeFile(tmp, content, "utf-8");
  await rename(tmp, filePath);
}

async function readMeta(dir: string): Promise<MetaFile | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, META_FILE), "utf-8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MetaFile>;
    if (
      typeof parsed.uuid === "string" &&
      typeof parsed.title === "string" &&
      (parsed.type === "image" || parsed.type === "html") &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        uuid: parsed.uuid,
        title: parsed.title,
        type: parsed.type,
        createdAt: parsed.createdAt,
        videoSize: normalizeVideoSize(parsed.videoSize) ?? undefined,
      };
    }
  } catch {
    /* 落到 return null */
  }
  return null;
}

function metaToSummary(m: MetaFile): ProjectSummary {
  return {
    uuid: m.uuid,
    title: m.title,
    type: m.type,
    createdAt: m.createdAt,
    videoSize: m.videoSize,
  };
}

export async function createProject(opts: {
  type: ProjectType;
  title?: string;
  videoSize?: VideoSize;
}): Promise<ProjectSummary> {
  if (opts.type !== "image" && opts.type !== "html") {
    throw new Error("无效的项目类型");
  }

  const root = dataRoot();
  await mkdir(root, { recursive: true });

  const uuid = randomUUID();
  const dir = path.join(root, uuid);
  await mkdir(dir, { recursive: false });

  const videoSize = normalizeVideoSize(opts.videoSize) ?? DEFAULT_VIDEO_SIZE;

  const meta: MetaFile = {
    uuid,
    title: (opts.title ?? defaultTitleFor(opts.type)).slice(0, 255),
    type: opts.type,
    createdAt: new Date().toISOString(),
    videoSize,
  };

  await Promise.all([
    writeAtomic(path.join(dir, META_FILE), JSON.stringify(meta, null, 2) + "\n"),
    writeAtomic(path.join(dir, STORYBOARD_FILE), ""),
    writeAtomic(path.join(dir, SOURCE_FILE), ""),
  ]);

  return metaToSummary(meta);
}

export async function listProjects(limit = 50): Promise<ProjectSummary[]> {
  const root = dataRoot();
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const metas = await Promise.all(
    entries.map(async (entry) => {
      if (!UUID_RE.test(entry)) return null;
      const dir = path.join(root, entry);
      const st = await stat(dir).catch(() => null);
      if (!st?.isDirectory()) return null;
      return readMeta(dir);
    }),
  );

  return metas
    .filter((m): m is MetaFile => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, safeLimit)
    .map(metaToSummary);
}

export async function getProject(uuid: string): Promise<ProjectDetail | null> {
  if (!UUID_RE.test(uuid)) return null;
  const dir = projectDir(uuid);
  const meta = await readMeta(dir);
  if (!meta) return null;

  const [storyboard, sourceCode] = await Promise.all([
    readFile(path.join(dir, STORYBOARD_FILE), "utf-8").catch(() => ""),
    readFile(path.join(dir, SOURCE_FILE), "utf-8").catch(() => ""),
  ]);

  return {
    ...metaToSummary(meta),
    storyboard,
    sourceCode,
  };
}

/**
 * 重命名项目：仅修改 meta.json 里的 title 字段。
 * 标题长度截到 80 字，去掉首尾空白；空串视为错误（不要允许变成"无标题"）。
 * 成功后返回新标题，便于客户端即时同步本地状态。
 */
export async function renameProject(
  uuid: string,
  title: string,
): Promise<{ ok: true; title: string } | { ok: false; error: string }> {
  if (!UUID_RE.test(uuid)) return { ok: false, error: "无效的项目 ID" };
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, error: "项目名称不能为空" };
  const next = trimmed.slice(0, 80);

  const dir = projectDir(uuid);
  const meta = await readMeta(dir);
  if (!meta) return { ok: false, error: "项目不存在" };

  meta.title = next;
  await writeAtomic(path.join(dir, META_FILE), JSON.stringify(meta, null, 2) + "\n");
  return { ok: true, title: next };
}

/** 更新项目画幅（仅 meta.json；需在外层校验是否已有生成资产） */
export async function updateProjectVideoSize(
  uuid: string,
  videoSize: VideoSize,
): Promise<{ ok: true; videoSize: VideoSize } | { ok: false; error: string }> {
  if (!UUID_RE.test(uuid)) return { ok: false, error: "无效的项目 ID" };
  const normalized = normalizeVideoSize(videoSize);
  if (!normalized) return { ok: false, error: "无效的画幅" };

  const dir = projectDir(uuid);
  const meta = await readMeta(dir);
  if (!meta) return { ok: false, error: "项目不存在" };

  meta.videoSize = normalized;
  await writeAtomic(path.join(dir, META_FILE), JSON.stringify(meta, null, 2) + "\n");
  return { ok: true, videoSize: normalized };
}

/**
 * 物理删除项目：删除整个 <data>/<uuid>/ 目录，包含 storyboard / source / chat /
 * images / audio 等所有资源。不可恢复。
 *
 * 安全策略：
 *  1. UUID 校验 → 不合规直接拒绝
 *  2. 必须能读出 meta.json → 防误删非项目目录
 *  3. 解析后的 dir 必须在 dataRoot 之下（防路径穿越）
 *  4. rm 要加 { recursive: true, force: true }，目录不存在时也不抛
 */
export async function deleteProject(
  uuid: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!UUID_RE.test(uuid)) return { ok: false, error: "无效的项目 ID" };

  const dir = projectDir(uuid);

  // 防误删：必须能读到 meta
  const meta = await readMeta(dir);
  if (!meta) return { ok: false, error: "项目不存在" };

  // 防路径穿越：确保解析后仍在 dataRoot 下
  const resolved = path.resolve(dir);
  const rootResolved = path.resolve(dataRoot());
  if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
    return { ok: false, error: "项目路径异常，拒绝删除" };
  }

  try {
    await rm(resolved, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[deleteProject] rm failed for ${uuid}:`, msg);
    return { ok: false, error: `删除失败：${msg}` };
  }
}

export async function countProjects(): Promise<number> {
  // 准确计数（不受 limit 影响）
  const root = dataRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  const checks = await Promise.all(
    entries.map(async (entry) => {
      if (!UUID_RE.test(entry)) return false;
      const st = await stat(path.join(root, entry)).catch(() => null);
      return Boolean(st?.isDirectory());
    }),
  );
  return checks.filter(Boolean).length;
}

/* ---------------------------------------------------------------------------
 * 视频大纲（持久化在 storyboard.txt 里，JSON 格式）
 * ------------------------------------------------------------------------- */

export async function loadStoryboard(
  uuid: string,
): Promise<VideoOutline | null> {
  if (!UUID_RE.test(uuid)) return null;
  const file = path.join(projectDir(uuid), STORYBOARD_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[loadStoryboard] storyboard.txt is not valid JSON for ${uuid}: ${detail}`,
    );
    return null;
  }
  if (!isVideoOutlineShape(parsed)) {
    console.error(
      `[loadStoryboard] storyboard.txt shape invalid for ${uuid}, ignoring`,
    );
    return null;
  }
  return parsed;
}

export async function saveStoryboard(
  uuid: string,
  outline: VideoOutline,
): Promise<void> {
  if (!UUID_RE.test(uuid)) {
    throw new Error("无效的项目 ID");
  }
  const file = path.join(projectDir(uuid), STORYBOARD_FILE);
  await writeAtomic(file, JSON.stringify(outline, null, 2) + "\n");
}

/**
 * 更新指定分镜的图片路径。
 * 只改 storyboard.txt 中对应 scene 的 imagePath，其他字段不变。
 */
export async function updateSceneImagePath(
  uuid: string,
  sceneIndex: number,
  imagePath: string,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) {
    throw new Error("outline_not_found");
  }
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) {
    throw new Error(`scene_index_invalid: ${sceneIndex}`);
  }
  scene.imagePath = imagePath;
  await saveStoryboard(uuid, outline);
}

/**
 * 获取项目图片目录的绝对路径。
 */
export function getProjectImagesDir(uuid: string): string {
  return path.join(projectDir(uuid), IMAGES_DIR);
}

/**
 * 获取项目 HTML 动画目录的绝对路径。
 */
export function getProjectScenesDir(uuid: string): string {
  return path.join(projectDir(uuid), SCENES_DIR);
}

/**
 * 更新指定分镜的音频路径。
 * 只改 storyboard.txt 中对应 scene 的 audioPath，其他字段不变。
 */
export async function updateSceneAudioPath(
  uuid: string,
  sceneIndex: number,
  audioPath: string,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) {
    throw new Error("outline_not_found");
  }
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) {
    throw new Error(`scene_index_invalid: ${sceneIndex}`);
  }
  scene.audioPath = audioPath;
  await saveStoryboard(uuid, outline);
}

/** 批量更新各分镜 audioPath（整片录音切分后一次写入） */
export async function updateAllSceneAudioPaths(
  uuid: string,
  paths: Record<number, string>,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) {
    throw new Error("outline_not_found");
  }
  for (const scene of outline.scenes) {
    const next = paths[scene.index];
    if (next) {
      scene.audioPath = next;
    }
  }
  outline.audioGeneratedAt = new Date().toISOString();
  await saveStoryboard(uuid, outline);
}

/**
 * 更新指定分镜的 HTML 路径。
 * 只改 storyboard.txt 中对应 scene 的 htmlPath，其他字段不变。
 */
export async function updateSceneHtmlPath(
  uuid: string,
  sceneIndex: number,
  htmlPath: string,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) {
    throw new Error("outline_not_found");
  }
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) {
    throw new Error(`scene_index_invalid: ${sceneIndex}`);
  }
  scene.htmlPath = htmlPath;
  await saveStoryboard(uuid, outline);
}

/**
 * 更新指定分镜的旁白文本。
 * 注意：调用方负责保证 audio 与新 narration 一致（一般是重生 audio）。
 */
export async function updateSceneNarration(
  uuid: string,
  sceneIndex: number,
  narration: string,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) {
    throw new Error("outline_not_found");
  }
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) {
    throw new Error(`scene_index_invalid: ${sceneIndex}`);
  }
  const next = narration.trim().slice(0, 1000);
  if (next.length === 0) {
    throw new Error("narration_empty");
  }
  scene.narration = next;
  await saveStoryboard(uuid, outline);
}

/** 更新分镜标题。空串拒绝，限长 80。 */
export async function updateSceneTitle(
  uuid: string,
  sceneIndex: number,
  title: string,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) throw new Error("outline_not_found");
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) throw new Error(`scene_index_invalid: ${sceneIndex}`);
  const next = title.trim().slice(0, 80);
  if (next.length === 0) throw new Error("title_empty");
  scene.title = next;
  await saveStoryboard(uuid, outline);
}

/** 更新分镜画面提示词。空串拒绝，限长 2000（与生成时保持一致）。 */
export async function updateScenePrompt(
  uuid: string,
  sceneIndex: number,
  prompt: string,
): Promise<void> {
  const outline = await loadStoryboard(uuid);
  if (!outline) throw new Error("outline_not_found");
  const scene = outline.scenes.find((s) => s.index === sceneIndex);
  if (!scene) throw new Error(`scene_index_invalid: ${sceneIndex}`);
  const next = prompt.trim().slice(0, 2000);
  if (next.length === 0) throw new Error("prompt_empty");
  scene.prompt = next;
  await saveStoryboard(uuid, outline);
}

/**
 * 追加一个新分镜到 outline 末尾。
 *  - 新 index 取 (现有最大 index + 1)，保证密集递增
 *  - 三个必填字段（title / narration / prompt）必须非空；可选字段 (imagePath / audioPath) 不初始化
 *  - 注意：与 generateOutline 不同，不强制 image/audui 立即生成；用户后续可以"一键生成"补齐
 */
export async function addScene(
  uuid: string,
  fields: { title: string; narration: string; prompt: string },
): Promise<OutlineScene> {
  const outline = await loadStoryboard(uuid);
  if (!outline) throw new Error("outline_not_found");

  const title = fields.title.trim().slice(0, 80);
  const narration = fields.narration.trim().slice(0, 1000);
  const prompt = fields.prompt.trim().slice(0, 2000);
  if (!title) throw new Error("title_empty");
  if (!narration) throw new Error("narration_empty");
  if (!prompt) throw new Error("prompt_empty");

  const maxIndex = outline.scenes.reduce((m, s) => Math.max(m, s.index), 0);
  const newScene: OutlineScene = {
    index: maxIndex + 1,
    title,
    narration,
    prompt,
    ...(outline.mode === "html"
      ? { durationSec: estimateSceneDurationSec(narration) }
      : {}),
  };
  outline.scenes.push(newScene);
  await saveStoryboard(uuid, outline);
  return newScene;
}

/**
 * 获取项目音频目录的绝对路径。
 */
export function getProjectAudioDir(uuid: string): string {
  return path.join(projectDir(uuid), AUDIO_DIR);
}

function isVideoOutlineShape(value: unknown): value is VideoOutline {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o.mode !== "image" && o.mode !== "html") return false;
  if (typeof o.script !== "string" || o.script.length === 0) return false;
  if (typeof o.generatedAt !== "string") return false;
  if (!Array.isArray(o.scenes)) return false;
  for (const s of o.scenes) {
    if (!s || typeof s !== "object") return false;
    const sc = s as Record<string, unknown>;
    if (typeof sc.index !== "number" || !Number.isInteger(sc.index)) return false;
    if (typeof sc.title !== "string" || sc.title.length === 0) return false;
    if (typeof sc.narration !== "string" || sc.narration.length === 0) return false;
    if (typeof sc.prompt !== "string" || sc.prompt.length === 0) return false;
    if (
      sc.durationSec != null &&
      (typeof sc.durationSec !== "number" ||
        !Number.isFinite(sc.durationSec) ||
        sc.durationSec < 0)
    ) {
      return false;
    }
  }
  return true;
}

/* ---------------------------------------------------------------------------
 * 聊天历史
 * ------------------------------------------------------------------------- */

export async function loadChatHistory(
  uuid: string,
): Promise<PersistedChatMessage[]> {
  if (!UUID_RE.test(uuid)) return [];
  const file = path.join(projectDir(uuid), CHAT_FILE);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[loadChatHistory] chat.json JSON parse failed for ${uuid}: ${detail}. Quarantining file.`,
    );
    await quarantineCorruptChatFile(uuid, file, "json_parse");
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(
      `[loadChatHistory] chat.json root is not an array for ${uuid}. Quarantining file.`,
    );
    await quarantineCorruptChatFile(uuid, file, "shape");
    return [];
  }

  const valid = parsed.filter(isValidChatMessage);
  const dropped = parsed.length - valid.length;
  if (dropped > 0) {
    console.warn(
      `[loadChatHistory] dropped ${dropped} invalid chat message(s) in ${uuid}`,
    );
  }
  return valid;
}

export async function appendChatMessage(
  uuid: string,
  message: PersistedChatMessage,
): Promise<PersistedChatMessage[]> {
  if (!UUID_RE.test(uuid)) {
    throw new Error("无效的项目 ID");
  }

  // 串行化同一个 uuid 的所有写 —— 读改写竞态的简易修复。
  const prev = chatLocks.get(uuid) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => doAppend(uuid, message));
  chatLocks.set(uuid, next);
  try {
    return await next;
  } finally {
    // 清理：只有当自己还是最新的 promise 时才删除，否则说明后续还有人在排队。
    if (chatLocks.get(uuid) === next) {
      chatLocks.delete(uuid);
    }
  }
}

async function doAppend(
  uuid: string,
  message: PersistedChatMessage,
): Promise<PersistedChatMessage[]> {
  const current = await loadChatHistory(uuid);
  const updated = [...current, message];
  const file = path.join(projectDir(uuid), CHAT_FILE);
  await writeAtomic(file, JSON.stringify(updated, null, 2) + "\n");
  return updated;
}

async function quarantineCorruptChatFile(
  uuid: string,
  file: string,
  reason: string,
): Promise<void> {
  const stamp = Date.now();
  const target = path.join(projectDir(uuid), `chat.json.corrupt-${reason}-${stamp}`);
  try {
    await rename(file, target);
    console.warn(
      `[loadChatHistory] moved corrupt chat.json to ${target} (uuid=${uuid})`,
    );
  } catch (err) {
    console.error(
      `[loadChatHistory] failed to quarantine corrupt chat.json for ${uuid}:`,
      err,
    );
  }
}

function isValidChatMessage(value: unknown): value is PersistedChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.length === 0) return false;
  if (m.role !== "user" && m.role !== "assistant") return false;
  if (typeof m.content !== "string") return false;
  if (typeof m.createdAt !== "string") return false;
  if (m.intent !== undefined && !isIntentAction(m.intent)) return false;
  if (m.error !== undefined && m.error !== true) return false;
  return true;
}

function isIntentAction(value: unknown): boolean {
  return typeof value === "string" && (INTENT_ACTIONS as readonly string[]).includes(value);
}
