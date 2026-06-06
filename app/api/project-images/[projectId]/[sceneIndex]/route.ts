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

  // 去掉扩展名（如 "1.png" -> "1"），Next.js 把扩展名也当作参数一部分
  const cleanIndex = sceneIndex.replace(/\.[^.]+$/, "");
  const sceneIndexNum = Number(cleanIndex);
  if (!Number.isInteger(sceneIndexNum) || sceneIndexNum < 1) {
    return new Response("Invalid scene index", { status: 400 });
  }

  const filePath = path.join(dataRoot(), projectId, "images", `${sceneIndexNum}.png`);

  try {
    // 以 mtime + size 组成 ETag，文件被重新生成时会变化，浏览器自动刷新。
    // 用 no-cache（每次问服务端）+ ETag/Last-Modified（命中时 304）— 兼顾"重生即可见"和带宽。
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
          "Cache-Control": "no-cache, must-revalidate",
        },
      });
    }

    const buffer = await readFile(filePath);
    return new Response(buffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-cache, must-revalidate",
        ETag: etag,
        "Last-Modified": lastModified,
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return new Response("Image not found", { status: 404 });
    }
    console.error(`[/api/project-images] read failed:`, err);
    return new Response("Internal error", { status: 500 });
  }
}
