import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dataRoot(): string {
  const fromEnv = process.env.DATA_DIR?.trim();
  return fromEnv
    ? path.resolve(fromEnv)
    : path.join(process.cwd(), "data", "projects");
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; sceneIndex: string }> },
) {
  const { projectId, sceneIndex } = await params;

  if (!UUID_RE.test(projectId)) {
    return new Response("Invalid project ID", { status: 400 });
  }

  // 去掉扩展名（如 "1.mp3" -> "1"）
  const cleanIndex = sceneIndex.replace(/\.[^.]+$/, "");
  const filePath =
    cleanIndex === "full"
      ? path.join(dataRoot(), projectId, "audio", "full.mp3")
      : (() => {
          const sceneIndexNum = Number(cleanIndex);
          if (!Number.isInteger(sceneIndexNum) || sceneIndexNum < 1) {
            return null;
          }
          return path.join(dataRoot(), projectId, "audio", `${sceneIndexNum}.mp3`);
        })();

  if (!filePath) {
    return new Response("Invalid scene index", { status: 400 });
  }

  try {
    // mtime + size ETag：重写旁白后音频文件被覆盖，浏览器自动拉新版本。
    const stats = await stat(filePath);
    const etag = `"${stats.size.toString(16)}-${stats.mtimeMs.toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();

    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Last-Modified": lastModified,
          "Cache-Control": "no-store",
        },
      });
    }

    const buffer = await readFile(filePath);
    return new Response(buffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        ETag: etag,
        "Last-Modified": lastModified,
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return new Response("Audio not found", { status: 404 });
    }
    console.error(`[/api/project-audio] read failed:`, err);
    return new Response("Internal error", { status: 500 });
  }
}
