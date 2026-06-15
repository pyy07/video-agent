import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { injectSceneEmbedCss } from "@/lib/sceneEmbedCss";

/**
 * 暴露项目 HTML 动画文件。
 *
 * 用途：
 *  - 客户端通过 <iframe src="/api/project-scenes/<uuid>/<index>"> 直接嵌入
 *  - 不需要把 HTML 拷到 public/，避免项目间污染
 *  - 走 mtime+size ETag，"重新生成动画"后浏览器自动拉新版本
 */

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

  const cleanIndex = sceneIndex.replace(/\.[^.]+$/, "");
  const sceneIndexNum = Number(cleanIndex);
  if (!Number.isInteger(sceneIndexNum) || sceneIndexNum < 1) {
    return new Response("Invalid scene index", { status: 400 });
  }

  const filePath = path.join(
    dataRoot(),
    projectId,
    "scenes",
    `${sceneIndexNum}.html`,
  );

  try {
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

    const rawHtml = await readFile(filePath, "utf-8");
    const reqUrl = new URL(request.url);
    const embed = reqUrl.searchParams.get("embed") === "1";
    let lw = Number(reqUrl.searchParams.get("lw") ?? "1280");
    let lh = Number(reqUrl.searchParams.get("lh") ?? "720");
    let ds = Number(reqUrl.searchParams.get("ds") ?? "0");
    if (!Number.isFinite(lw) || lw < 1) lw = 1280;
    if (!Number.isFinite(lh) || lh < 1) lh = 720;
    if (!Number.isFinite(ds) || ds < 0) ds = 0;
    const html = embed ? injectSceneEmbedCss(rawHtml, lw, lh, ds) : rawHtml;
    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, must-revalidate",
        ETag: etag,
        "Last-Modified": lastModified,
        // 允许 iframe 嵌入（虽然默认就是同源）
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return new Response("Scene HTML not found", { status: 404 });
    }
    console.error(`[/api/project-scenes] read failed:`, err);
    return new Response("Internal error", { status: 500 });
  }
}
