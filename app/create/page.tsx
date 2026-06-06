import { listProjects, loadStoryboard } from "@/lib/projects";
import type { VideoOutline } from "@/lib/outlineTypes";
import CreatePageClient from "./CreatePageClient";

export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageProps = {
  searchParams: Promise<{ mode?: string; id?: string }>;
};

export default async function CreatePage({ searchParams }: PageProps) {
  const { mode, id } = await searchParams;
  const safeMode = mode === "html" ? "html" : "image";

  let projects: Awaited<ReturnType<typeof listProjects>> = [];
  let loadError: string | null = null;
  try {
    projects = await listProjects();
  } catch (err) {
    loadError =
      err instanceof Error
        ? `加载项目列表失败：${err.message}`
        : "加载项目列表失败";
  }

  // 决定要预加载哪个项目的大纲：URL ?id= 优先，其次是列表的第一项
  const initialId = id ?? projects[0]?.uuid ?? null;
  let initialOutline: VideoOutline | null = null;
  if (initialId && UUID_RE.test(initialId)) {
    try {
      initialOutline = await loadStoryboard(initialId);
    } catch (err) {
      // 加载大纲失败不阻塞页面渲染
      console.error(`[CreatePage] loadStoryboard failed for ${initialId}:`, err);
    }
  }

  return (
    <CreatePageClient
      mode={safeMode}
      initialProjectId={initialId}
      initialOutline={initialOutline}
      projects={projects}
      loadError={loadError}
    />
  );
}
