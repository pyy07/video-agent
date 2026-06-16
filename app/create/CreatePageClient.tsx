"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AIChat, AIChatHeader } from "@/components/create/AIChat";
import { Sidebar } from "@/components/create/Sidebar";
import { StoryboardList } from "@/components/create/StoryboardList";
import { Toolbar } from "@/components/create/Toolbar";
import { VideoPreview, type VideoPreviewHandle } from "@/components/create/VideoPreview";
import { OutlineModal } from "@/components/create/OutlineModal";
import { ExportModal } from "@/components/create/ExportModal";
import { VideoSizePicker } from "@/components/create/VideoSizePicker";
import {
  downloadBlob,
  startRecordingFromCanvas,
  startRecordingFromDisplayMedia,
  type RecordingHandle,
} from "@/lib/recorder";
import {
  bitrateForVideoSize,
  hasGeneratedSceneAssets,
  resolveVideoSize,
  type VideoSize,
} from "@/lib/exportVideo";
import { WORKSPACE_BOTTOM_DOCK_HEIGHT, WORKSPACE_HEADER_HEIGHT } from "@/lib/workspaceLayout";
import { countPendingGenerateTasks } from "@/lib/pendingGenerateTasks";
import {
  deleteProjectAction,
  generateProjectAudiosAction,
  getChatHistoryAction,
  loadStoryboardAction,
  regenerateSceneImageAction,
  renameProjectAction,
  updateProjectVideoSizeAction,
} from "@/app/actions";
import type { PersistedChatMessage } from "@/lib/chatTypes";
import type { VideoOutline } from "@/lib/outlineTypes";
import {
  PROJECT_TYPE_LABEL,
  type ProjectSummary,
  type ProjectType,
} from "@/lib/projectTypes";

type CreatePageClientProps = {
  mode: ProjectType;
  initialProjectId: string | null;
  initialOutline: VideoOutline | null;
  projects: ProjectSummary[];
  loadError: string | null;
};

const SPLITTER_WIDTH = 6;
const MIN_CHAT_PX = 280;
const MAX_CHAT_PX = 520;
const CHAT_RATIO_STORAGE_KEY = "video-agent:chat-split-ratio";
const DEFAULT_CHAT_RATIO = 0.36;

export default function CreatePageClient({
  mode,
  initialProjectId,
  initialOutline,
  projects: initialProjects,
  loadError,
}: CreatePageClientProps) {
  const [activeProjectId, setActiveProjectId] = useState<string | null>(
    initialProjectId,
  );
  // 项目列表客户端持有，方便删除/重命名后立刻同步 UI，不必等 server revalidate
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects);
  const [activeSceneId, setActiveSceneId] = useState<string | null>(null);
  /**
   * "查看完整大纲内容" 弹窗：现在挂在 CreatePageClient 一层，
   * 方便 AIChat 消息气泡 和 StoryboardList 头部按钮共用同一个 modal。
   * null = 关闭；非 null = 显示对应的大纲。
   */
  const [outlineModal, setOutlineModal] = useState<VideoOutline | null>(null);
  const [subtitleOn, setSubtitleOn] = useState(true);
  const [chatHistory, setChatHistory] = useState<PersistedChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [outline, setOutline] = useState<VideoOutline | null>(initialOutline);
  /**正在生成图片的分镜序号（null = 没有正在生成） */
  const [generatingSceneIndex, setGeneratingSceneIndex] = useState<number | null>(null);

  /**
   * 一键生成的进度状态：
   *  - current: 当前正在处理的"任务"序号（1-based，用于显示 X/Y）
   *  - total: 本次需要处理的"任务"总数（缺图 + 缺音的总条目数；同一分镜两个都缺算 2）
   *  - 不为 null 表示正在进行
   */
  const [bulkProgress, setBulkProgress] = useState<{ current: number; total: number } | null>(null);
  // 用 ref 提供"中断"信号，按钮再点一次即取消，避免在长任务里走到下一镜

  /**
   * 视频导出相关状态：
   *  - exportModalOpen: "选择共享标签页"弹窗是否打开
   *  - recordingMode: 是否正在录屏（控制 VideoPreview 行为 + UI 红点）
   *  - recordingHandle: recorder 句柄，持有视频/音频编码器、muxer 状态
   *  - exportError: 导出失败时的错误条（弹窗和 toast 通用）
   */
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [recordingMode, setRecordingMode] = useState(false);
  /** recorder 连上 canvas 后才允许全屏预览自动播放 */
  const [recordingCaptureReady, setRecordingCaptureReady] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const recordingHandleRef = useRef<RecordingHandle | null>(null);
  const recordingFrameBridgeRef = useRef<(() => void) | null>(null);
  // VideoPreview 通过 ref 暴露录制 canvas 和当前正在播放的 <audio>
  const videoPreviewRef = useRef<VideoPreviewHandle | null>(null);
  const bulkAbortRef = useRef<boolean>(false);
  /** 区分「首次进入页面」与「切换项目」，避免清空服务端预载的大纲导致预览闪空白 */
  const prevActiveProjectIdRef = useRef<string | null>(null);

  const project = useMemo(
    () =>
      projects.find((p) => p.uuid === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );
  const videoSize = useMemo(
    () => resolveVideoSize(outline, project),
    [outline, project],
  );
  const videoSizeLocked = hasGeneratedSceneAssets(outline);
  const scenes = outline?.scenes ?? [];
  const activeScene = useMemo(() => {
    if (!activeSceneId) return null;
    const m = activeSceneId.match(/^s-(\d+)$/);
    if (!m) return null;
    const idx = Number(m[1]);
    return scenes.find((s) => s.index === idx) ?? null;
  }, [activeSceneId, scenes]);

  // 切到新项目时：拉聊天历史和故事板；仅在真正切换项目时清空大纲
  useEffect(() => {
    const switchedProject =
      prevActiveProjectIdRef.current !== null &&
      prevActiveProjectIdRef.current !== activeProjectId;
    prevActiveProjectIdRef.current = activeProjectId;

    if (!activeProjectId) {
      setOutline(null);
      setActiveSceneId(null);
      setChatHistory([]);
      return;
    }

    if (switchedProject) {
      setOutline(null);
      setActiveSceneId(null);
      setChatHistory([]);
    }

    let cancelled = false;
    setChatLoading(true);

    // 并行加载聊天历史和大纲
    Promise.all([
      getChatHistoryAction(activeProjectId),
      loadStoryboardAction(activeProjectId),
    ])
      .then(([hist, outlineResult]) => {
        if (cancelled) return;
        setChatHistory(hist);
        if (outlineResult.ok) {
          setOutline(outlineResult.outline);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[CreatePageClient] load failed:", err);
        setChatHistory([]);
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);

  // 大纲变化时，确保 activeSceneId 始终指向一个合法场景
  useEffect(() => {
    if (!outline) {
      setActiveSceneId(null);
      return;
    }
    if (!activeSceneId && scenes.length > 0) {
      setActiveSceneId(`s-${scenes[0].index}`);
      return;
    }
    if (activeSceneId && !scenes.find((s) => `s-${s.index}` === activeSceneId)) {
      setActiveSceneId(scenes.length > 0 ? `s-${scenes[0].index}` : null);
    }
  }, [outline, activeSceneId, scenes]);

  // 接收 AIChat 的回调：更新历史；如果 action 返回了 outline，刷新大纲
  const handleNewHistory = useCallback(
    (
      messages: PersistedChatMessage[],
      nextOutline?: VideoOutline,
      renamedProjectTitle?: string,
    ) => {
      setChatHistory(messages);
      if (nextOutline) setOutline(nextOutline);
      if (renamedProjectTitle && activeProjectId) {
        setProjects((list) =>
          list.map((p) =>
            p.uuid === activeProjectId
              ? { ...p, title: renamedProjectTitle }
              : p,
          ),
        );
      }
    },
    [activeProjectId],
  );

  /**
   * 单个分镜"生成"按钮：只补缺失的画面/动画 + 音频，已经存在的资源**不重做**。
   * 重新生成（覆盖已有的）只能在「完整大纲内容」弹窗里做。
   *
   * 流程：
   *  1. 拉最新 outline（避免 UI 状态与服务端脱节）
   *  2. 找出该分镜实际缺失的项 → 串行调用对应的"仅 XX" action
   *     - image 模式：缺图补图、缺音补音
   *     - html 模式：缺动画补动画、缺音补音
   *  3. 全齐则 noop（按钮 UI 层就拦了，这里再兜底一次）
   */
  const handleGenerateScene = useCallback(async (sceneIndex: number) => {
    if (!activeProjectId || generatingSceneIndex !== null || bulkProgress !== null) return;
    setGeneratingSceneIndex(sceneIndex);
    try {
      // 1) 拉最新 outline
      const outlineRes = await loadStoryboardAction(activeProjectId);
      if (!outlineRes.ok) {
        console.error(`[handleGenerateScene] loadStoryboard failed:`, outlineRes.error);
        return;
      }
      setOutline(outlineRes.outline);
      const scene = outlineRes.outline.scenes.find((s) => s.index === sceneIndex);
      if (!scene) {
        console.error(`[handleGenerateScene] scene ${sceneIndex} not found in outline`);
        return;
      }

      const isHtmlMode = outlineRes.outline.mode === "html";
      const needVisual = isHtmlMode ? !scene.htmlPath : !scene.imagePath;
      const needAudio = !scene.audioPath;
      if (!needVisual && !needAudio) return; // 已齐全，不应走到这里

      // 2) 串行补缺失；先视觉资源后音频（沿用"画面先行"的心智模型）
      if (needVisual) {
        if (isHtmlMode) {
          const { generateSceneHtmlAction } = await import("@/app/actions");
          const res = await generateSceneHtmlAction(activeProjectId, sceneIndex);
          if (res.ok) {
            // 重新拉一次 outline（生成成功会同时落盘 htmlPath + audioPath）
            const fresh = await loadStoryboardAction(activeProjectId);
            if (fresh.ok) setOutline(fresh.outline);
          } else {
            console.error(`[handleGenerateScene] html scene ${sceneIndex} failed:`, res.error);
          }
        } else {
          const res = await regenerateSceneImageAction(activeProjectId, sceneIndex);
          if (res.ok) setOutline(res.outline);
          else console.error(`[handleGenerateScene] image scene ${sceneIndex} failed:`, res.error);
        }
      }
      if (needAudio) {
        const res = await generateProjectAudiosAction(activeProjectId);
        if (res.ok) setOutline(res.outline);
        else console.error("[handleGenerateScene] project audio failed:", res.error);
      }
    } catch (err) {
      console.error("[handleGenerateScene] failed:", err);
    } finally {
      setGeneratingSceneIndex(null);
    }
  }, [activeProjectId, generatingSceneIndex, bulkProgress]);

  /**
   * 一键生成：对每个缺失了视觉资源 / audio 的分镜按需补齐，已生成的跳过。
   *
   * 设计要点：
   *  - 客户端编排，逐镜串行（避免并发把 LLM/图片/音频服务打爆）
   *  - image 模式：先逐镜补画面，最后整片生成音频并切分
   *  - html 模式：任务以「动画」为粒度；音频在全部视觉任务完成后整片生成一次
   *  - 若存在缺失音频，最后追加 1 个整片音频任务（一次 TTS + 切分）
   *  - 每完成一项就 setOutline，UI 立即反映进度
   *  - generatingSceneIndex 同时被点亮，复用现有单镜"生成中…"卡片样式
   *  - 再次点击按钮（bulkProgress 非空时）触发中断，下一镜不再开始
   *  - 单镜按钮在 bulk 进行时被禁用（见 handleGenerateScene 头部守卫）
   */
  const handleBulkGenerate = useCallback(async () => {
    if (!activeProjectId || generatingSceneIndex !== null) return;
    // 二次点击：作为"取消"语义
    if (bulkProgress !== null) {
      bulkAbortRef.current = true;
      return;
    }

    // 用最新 outline 计算缺失项（不要直接用闭包里的 scenes，因为可能刚刚被刷新过）
    const fresh0 = await loadStoryboardAction(activeProjectId);
    const baseOutline = fresh0.ok ? fresh0.outline : outline;
    const baseScenes = fresh0.ok ? fresh0.outline.scenes : (outline?.scenes ?? []);
    if (fresh0.ok) setOutline(fresh0.outline);

    const isHtmlMode = baseOutline?.mode === "html";
    type Task = { sceneIndex: number; kind: "visual" };
    const tasks: Task[] = [];
    for (const sc of baseScenes) {
      if (isHtmlMode) {
        if (!sc.htmlPath) tasks.push({ sceneIndex: sc.index, kind: "visual" });
      } else if (!sc.imagePath) {
        tasks.push({ sceneIndex: sc.index, kind: "visual" });
      }
    }
    const needsProjectAudio = baseScenes.some((sc) => !sc.audioPath);
    const totalTasks = countPendingGenerateTasks(
      baseScenes,
      Boolean(isHtmlMode),
    );
    if (totalTasks === 0) return;

    bulkAbortRef.current = false;
    setBulkProgress({ current: 0, total: totalTasks });

    for (let i = 0; i < tasks.length; i++) {
      if (bulkAbortRef.current) break;
      const t = tasks[i];
      setBulkProgress({ current: i + 1, total: totalTasks });
      setGeneratingSceneIndex(t.sceneIndex);
      try {
        let res;
        if (isHtmlMode) {
          const { generateSceneHtmlAction } = await import("@/app/actions");
          res = await generateSceneHtmlAction(activeProjectId, t.sceneIndex);
          if (res.ok) {
            const fresh = await loadStoryboardAction(activeProjectId);
            if (fresh.ok) setOutline(fresh.outline);
            continue;
          }
        } else {
          res = await regenerateSceneImageAction(activeProjectId, t.sceneIndex);
        }
        if (res.ok && "outline" in res && res.outline) {
          setOutline(res.outline);
        } else if (!res.ok) {
          console.error(`[bulkGenerate] visual scene ${t.sceneIndex} failed:`, res.error);
        }
      } catch (err) {
        console.error(`[bulkGenerate] visual scene ${t.sceneIndex} threw:`, err);
      }
    }

    if (!bulkAbortRef.current && needsProjectAudio) {
      setBulkProgress({ current: tasks.length + 1, total: totalTasks });
      setGeneratingSceneIndex(null);
      try {
        const res = await generateProjectAudiosAction(activeProjectId);
        if (res.ok) {
          setOutline(res.outline);
        } else {
          console.error("[bulkGenerate] project audio failed:", res.error);
        }
      } catch (err) {
        console.error("[bulkGenerate] project audio threw:", err);
      }
    }

    setGeneratingSceneIndex(null);
    setBulkProgress(null);
    bulkAbortRef.current = false;
  }, [activeProjectId, generatingSceneIndex, bulkProgress, outline]);

  /**
   * 重命名：服务端已原子写 meta.json 并 revalidate 路径，这里只做客户端状态同步。
   * UI 已在 inline 编辑里即时回显，失败时再把服务端的最新值（next.title）写回。
   */
  const handleRenameProject = useCallback(
    async (uuid: string, nextTitle: string) => {
      const res = await renameProjectAction(uuid, nextTitle);
      if (res.ok) {
        setProjects((list) =>
          list.map((p) => (p.uuid === uuid ? { ...p, title: res.title } : p)),
        );
      } else {
        // 失败时回退到服务端原本的名字（避免客户端与服务端脱节）
        console.error(`[handleRenameProject] ${uuid} failed:`, res.error);
      }
    },
    [],
  );

  /**
   * 删除项目：服务端删完所有资源后，本地先从列表里移除；若删的是当前激活项，
   * 立即切到列表里"下一个"（同一索引，或上一个），并清空 outline/chat。
   * 切到新项目后，activeProjectId effect 会自动加载新项目的数据。
   */
  const handleDeleteProject = useCallback(
    async (uuid: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      const wasActive = uuid === activeProjectId;
      setProjects((list) => list.filter((p) => p.uuid !== uuid));

      // 服务端先删，避免切到新项目后再发现旧项目还在
      const res = await deleteProjectAction(uuid);
      if (!res.ok) {
        // 失败回滚：刷新整列（不细做重排序，简单 reload 也行）
        console.error(`[handleDeleteProject] ${uuid} failed:`, res.error);
        return res;
      }

      if (wasActive) {
        // 从更新后的列表里挑"下一个"作为激活项目
        const remaining = projects.filter((p) => p.uuid !== uuid);
        const nextActive = remaining[0]?.uuid ?? null;
        setActiveProjectId(nextActive);
        if (!nextActive) {
          setOutline(null);
          setChatHistory([]);
        }
      }
      return { ok: true };
    },
    [activeProjectId, projects],
  );

  /**
   * 从"分镜列表头部按钮"或"侧边栏"打开大纲弹窗：直接展示当前实时 outline。
   * 注意与 AIChat 消息气泡的区别——那边需要按消息版本决定用 live 还是历史快照。
   */
  const handleOpenOutlineModalFromSidebar = useCallback(() => {
    if (outline) setOutlineModal(outline);
  }, [outline]);

  /**
   * 视频导出按钮点击：打开"选择共享标签页"弹窗。
   * 大纲为空时按钮会被禁用，所以这里再次守卫一下。
   */
  const handleOpenExport = useCallback(() => {
    if (!outline || outline.scenes.length === 0) {
      setExportError("请先生成视频大纲再导出。");
      return;
    }
    setExportError(null);
    setExportModalOpen(true);
  }, [outline]);

  const projectType = project?.type ?? mode;

  /**
   * 弹窗点"开始录制"：
   *  - 图片轮播：隐藏 canvas 编码
   *  - HTML 视频：getDisplayMedia 采集预览区
   */
  const handleStartExport = useCallback(async (): Promise<void> => {
    setExportError(null);

    flushSync(() => {
      setExportModalOpen(false);
      setRecordingCaptureReady(false);
      setRecordingMode(true);
    });

    const isHtmlProject = projectType === "html";
    const recorderConfig = {
      frameRate: 30,
      width: videoSize.width,
      height: videoSize.height,
      videoBitrate: bitrateForVideoSize(videoSize.width, videoSize.height),
      withAudio: true,
    };

    try {
      await waitForCaptureRegion(
        () => videoPreviewRef.current?.getCaptureRegion() ?? null,
        isHtmlProject ? videoSize.width : 0,
        isHtmlProject ? videoSize.height : 0,
        5000,
      );

      let handle: RecordingHandle;

      if (isHtmlProject) {
        const region = videoPreviewRef.current?.getCaptureRegion();
        if (!region) {
          throw new Error("预览区域尚未就绪，请稍后再试。");
        }
        handle = await startRecordingFromDisplayMedia(region, recorderConfig);
        recordingFrameBridgeRef.current = null;
      } else {
        const canvas = videoPreviewRef.current?.getRecordingCanvas();
        if (!canvas) {
          throw new Error("录制画布尚未就绪，请稍后再试。");
        }
        handle = await startRecordingFromCanvas(canvas, recorderConfig);
        recordingFrameBridgeRef.current = () => handle.notifyFrameDrawn();
      }

      recordingHandleRef.current = handle;

      audioElementBridgeRef.current = (audioEl) => {
        handle.setAudioElement(audioEl);
      };
      handle.setAudioElement(videoPreviewRef.current?.getCurrentAudioEl() ?? null);

      setRecordingCaptureReady(true);
    } catch (err) {
      recordingHandleRef.current = null;
      recordingFrameBridgeRef.current = null;
      audioElementBridgeRef.current = null;
      setRecordingCaptureReady(false);
      setRecordingMode(false);
      throw err;
    }
  }, [projectType, videoSize]);

  const handleVideoSizeChange = useCallback(
    async (next: VideoSize) => {
      if (!activeProjectId || videoSizeLocked) return;
      const res = await updateProjectVideoSizeAction(activeProjectId, next);
      if (!res.ok) {
        setExportError(res.error);
        return;
      }
      setProjects((prev) =>
        prev.map((p) =>
          p.uuid === activeProjectId ? { ...p, videoSize: res.videoSize } : p,
        ),
      );
      setOutline((prev) => (prev ? { ...prev, videoSize: res.videoSize } : prev));
    },
    [activeProjectId, videoSizeLocked],
  );

  /**
   * audio 桥接：父级向 VideoPreview 注入回调，VideoPreview 每次切 audio 时
   * 通知父级，父级转给 recorder.setAudioElement。
   * 简单做法：把回调挂 ref 上，让 VideoPreview 通过 props 回调写到 ref。
   */
  const audioElementBridgeRef = useRef<((el: HTMLAudioElement | null) => void) | null>(null);
  const handleAudioElementChange = useCallback((el: HTMLAudioElement | null) => {
    audioElementBridgeRef.current?.(el);
  }, []);

  /**
   * 录屏取消回调：用户点录制覆盖层上的 X。
   */
  const handleRecordingCancel = useCallback(() => {
    const handle = recordingHandleRef.current;
    recordingHandleRef.current = null;
    audioElementBridgeRef.current = null;
    recordingFrameBridgeRef.current = null;
    setRecordingCaptureReady(false);
    setRecordingMode(false);
    if (handle) {
      try { handle.cancel(); } catch (e) { console.warn("[handleRecordingCancel] cancel failed:", e); }
    }
  }, []);

  /**
   * 录屏完成回调：所有分镜播完后由 VideoPreview 触发。
   *  1. 关闭录屏模式（让 VideoPreview 恢复正常 UI）
   *  2. finalize recorder 拿到 Blob
   *  3. 触发浏览器下载
   *  4. 失败时弹错误条
   */
  const handleRecordingComplete = useCallback(async () => {
    const handle = recordingHandleRef.current;
    recordingHandleRef.current = null;
    audioElementBridgeRef.current = null;
    recordingFrameBridgeRef.current = null;
    if (!handle) {
      console.warn("[handleRecordingComplete] no handle, skip finalize");
      setRecordingCaptureReady(false);
      setRecordingMode(false);
      return;
    }
    try {
      const { blob, width, height } = await handle.stop();
      const projectTitle = project?.title?.replace(/[^\w一-龥-]+/g, "_") || "video";
      const stamp = new Date()
        .toISOString()
        .replace(/[-:T]/g, "")
        .slice(0, 14);
      downloadBlob(blob, `${projectTitle}_${width}x${height}_${stamp}.mp4`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[handleRecordingComplete] failed:", msg);
      setExportError(`视频导出失败：${msg}`);
    } finally {
      setRecordingCaptureReady(false);
      setRecordingMode(false);
    }
  }, [project?.title]);

  const title = project?.title ?? "新建项目";
  const savedLabel = project
    ? `${PROJECT_TYPE_LABEL[project.type]}模式 · 创建于 ${formatCreatedLabel(project.createdAt)}`
    : `${PROJECT_TYPE_LABEL[mode]}模式`;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink-50">
      <Sidebar
        projects={projects}
        activeProjectId={activeProjectId}
        loadError={loadError}
        onSelectProject={(id) => {
          setActiveProjectId(id);
        }}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
        onOpenOutlineModal={handleOpenOutlineModalFromSidebar}
      />

      <SplitWorkspace
        sidebarWidth={SIDEBAR_WIDTH}
        chatHistory={chatHistory}
        chatLoading={chatLoading}
        projectType={projectType}
        title={title}
        savedLabel={savedLabel}
        subtitleOn={subtitleOn}
        onToggleSubtitle={() => setSubtitleOn((v) => !v)}
        scenes={scenes}
        activeScene={activeScene}
        activeSceneId={activeSceneId}
        onSelectScene={setActiveSceneId}
        onOpenOutlineModal={handleOpenOutlineModalFromSidebar}
        hasProject={Boolean(project)}
        loadError={loadError}
        projectId={activeProjectId}
        liveOutline={outline}
        onNewHistory={handleNewHistory}
        generatingSceneIndex={generatingSceneIndex}
        onGenerateScene={handleGenerateScene}
        bulkProgress={bulkProgress}
        onBulkGenerate={handleBulkGenerate}
        onOpenExport={handleOpenExport}
        exportDisabled={!outline || outline.scenes.length === 0}
        recordingMode={recordingMode}
        onRecordingComplete={handleRecordingComplete}
        onRecordingCancel={handleRecordingCancel}
        videoPreviewRef={videoPreviewRef}
        onAudioElementChange={handleAudioElementChange}
        videoSize={videoSize}
        videoSizeLocked={videoSizeLocked}
        onVideoSizeChange={handleVideoSizeChange}
      />

      {outlineModal && (
        <OutlineModal
          outline={outlineModal}
          projectId={activeProjectId}
          onClose={() => setOutlineModal(null)}
          onOutlineUpdated={(next) => {
            setOutlineModal(next);
            setOutline(next);
          }}
        />
      )}

      <ExportModal
        open={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        onStart={handleStartExport}
        sceneCount={outline?.scenes.length ?? 0}
        projectType={projectType}
        videoSize={videoSize}
      />

      {exportError && (
        <div className="fixed bottom-6 right-6 z-50 max-w-md rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700 shadow-soft">
          {exportError}
          <button
            type="button"
            onClick={() => setExportError(null)}
            className="ml-3 text-amber-900 hover:underline"
          >
            关闭
          </button>
        </div>
      )}

      {/* 全屏录制覆盖层：recordingMode=true 时铺满整个视口，只渲染 VideoPreview。
          canvas 在该模式自动进入渲染循环，recorder 抓流即可。 */}
      {recordingMode && outline && (
        <div
          className="fixed inset-0 z-[60] flex flex-col bg-black"
          role="dialog"
          aria-label="录制中"
        >
          <div className="relative min-h-0 flex-1">
            <VideoPreview
              key="recording"
              ref={videoPreviewRef}
              scene={scenes[0] ?? null}
              showSubtitle={subtitleOn}
              projectId={activeProjectId}
              allScenes={scenes}
              audioGeneratedAt={outline.audioGeneratedAt}
              projectType={projectType}
              recordingMode
              recordingCaptureReady={recordingCaptureReady}
              onRecordingFrameDrawn={() => recordingFrameBridgeRef.current?.()}
              onRecordingPlaybackStart={() => recordingHandleRef.current?.markPlaybackStart()}
              onRecordingComplete={handleRecordingComplete}
              onRecordingCancel={handleRecordingCancel}
              onAudioElementChange={handleAudioElementChange}
              fillContainer
              videoSize={videoSize}
            />
          </div>
          {projectType === "html" && (
            <div className="flex shrink-0 items-center justify-between gap-3 border-t border-white/10 bg-black px-4 py-2 text-xs text-white/75">
              <span className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-500" />
                录制中 · 播完自动下载
              </span>
              <button
                type="button"
                onClick={handleRecordingCancel}
                className="rounded-md px-2.5 py-1 text-white/90 transition hover:bg-white/10"
              >
                取消录制
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const SIDEBAR_WIDTH = 240;

function SplitWorkspace(props: {
  sidebarWidth: number;
  projectId: string | null;
  projectType: ProjectType;
  title: string;
  savedLabel: string;
  subtitleOn: boolean;
  onToggleSubtitle: () => void;
  scenes: VideoOutline["scenes"];
  activeScene: VideoOutline["scenes"][number] | null;
  activeSceneId: string | null;
  onSelectScene: (id: string) => void;
  hasProject: boolean;
  loadError: string | null;
  chatHistory: PersistedChatMessage[];
  chatLoading: boolean;
  liveOutline: VideoOutline | null;
  onNewHistory: (
    messages: PersistedChatMessage[],
    outline?: VideoOutline,
    projectTitle?: string,
  ) => void;
  generatingSceneIndex: number | null;
  onGenerateScene: (sceneIndex: number) => void;
  bulkProgress: { current: number; total: number } | null;
  onBulkGenerate: () => void;
  /** 打开"完整大纲内容"弹窗（带当前 live outline） */
  onOpenOutlineModal: () => void;
  /** 打开"视频导出"弹窗 */
  onOpenExport: () => void;
  /** 视频导出按钮是否禁用（大纲为空时） */
  exportDisabled: boolean;
  /** 是否处于录屏模式（传给 VideoPreview 渲染"录制中"红点） */
  recordingMode: boolean;
  /** 录屏结束回调：finalize recorder + 下载 MP4 */
  onRecordingComplete: () => void;
  /** 录屏取消：用户点 X，recorder.cancel() */
  onRecordingCancel: () => void;
  /** VideoPreview ref（录制时父级要从它拿 canvas 和当前 audio） */
  videoPreviewRef: React.MutableRefObject<VideoPreviewHandle | null>;
  /** VideoPreview 内部 audio 切换时通知父级 */
  onAudioElementChange: (audio: HTMLAudioElement | null) => void;
  videoSize: VideoSize;
  videoSizeLocked: boolean;
  onVideoSizeChange: (size: VideoSize) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [chatRatio, setChatRatio] = useState<number>(DEFAULT_CHAT_RATIO);
  const [hydrated, setHydrated] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number>(0);

  // 读 localStorage
  useEffect(() => {
    setHydrated(true);
    try {
      const raw = localStorage.getItem(CHAT_RATIO_STORAGE_KEY);
      if (raw) {
        const v = Number(raw);
        if (Number.isFinite(v) && v > 0 && v < 1) {
          setChatRatio(clampRatio(v));
        }
      }
    } catch {
      /* ignore */
    }
  }, []);

  // 监听容器宽度
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // 写 localStorage
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(CHAT_RATIO_STORAGE_KEY, String(chatRatio));
    } catch {
      /* ignore */
    }
  }, [chatRatio, hydrated]);

  const available = Math.max(0, containerWidth - SPLITTER_WIDTH);
  const chatWidthRaw = available * chatRatio;
  const chatWidth = Math.max(
    MIN_CHAT_PX,
    Math.min(MAX_CHAT_PX, Math.floor(chatWidthRaw)),
  );
  const mainWidth = Math.max(0, available - chatWidth);

  // 拖拽处理
  const dragStateRef = useRef<{ startX: number; startRatio: number } | null>(null);
  const onSplitterPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (containerWidth <= 0) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragStateRef.current = { startX: e.clientX, startRatio: chatRatio };
    },
    [chatRatio, containerWidth],
  );
  const onSplitterPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const state = dragStateRef.current;
      if (!state || containerWidth <= 0) return;
      const dx = e.clientX - state.startX;
      const newRatio = clampRatio(state.startRatio + dx / containerWidth);
      setChatRatio(newRatio);
    },
    [containerWidth],
  );
  const onSplitterPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (dragStateRef.current) {
        dragStateRef.current = null;
        try {
          (e.target as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <div
        className="flex shrink-0 overflow-hidden"
        style={{ height: WORKSPACE_HEADER_HEIGHT }}
      >
        <div className="min-w-0" style={{ width: mainWidth }}>
          <Toolbar
            title={props.title}
            savedLabel={props.savedLabel}
            subtitleOn={props.subtitleOn}
            onToggleSubtitle={props.onToggleSubtitle}
            onExportVideo={props.onOpenExport}
            exportDisabled={props.exportDisabled}
            videoSize={props.videoSize}
            videoSizeLocked={props.videoSizeLocked}
            onVideoSizeChange={props.onVideoSizeChange}
          />
        </div>
        <div
          aria-hidden
          className="shrink-0 border-b border-ink-200/70 bg-white"
          style={{ width: SPLITTER_WIDTH }}
        />
        <div
          className="min-w-0 border-l border-ink-200/70"
          style={{ width: chatWidth }}
        >
          <AIChatHeader />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
      <main
        className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
        style={{ width: mainWidth }}
      >
        <div className="flex min-h-0 flex-1 flex-col px-6">
          {props.hasProject ? (
            <div className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col gap-3">
              {!props.recordingMode ? (
                <div className="min-h-0 flex-1">
                  <VideoPreview
                    key={props.projectId ?? "empty"}
                    ref={props.videoPreviewRef}
                    scene={props.activeScene}
                    showSubtitle={props.subtitleOn}
                    projectId={props.projectId}
                    allScenes={props.scenes}
                    audioGeneratedAt={props.liveOutline?.audioGeneratedAt}
                    projectType={props.projectType}
                    recordingMode={false}
                    onRecordingComplete={props.onRecordingComplete}
                    onRecordingCancel={props.onRecordingCancel}
                    onAudioElementChange={props.onAudioElementChange}
                    fillContainer
                    videoSize={props.videoSize}
                  />
                </div>
              ) : (
                <div className="min-h-0 flex-1" aria-hidden />
              )}
              <div
                className="shrink-0 overflow-hidden"
                style={{ height: WORKSPACE_BOTTOM_DOCK_HEIGHT }}
              >
                <StoryboardList
                  dock
                  scenes={props.scenes}
                  activeSceneId={props.activeSceneId}
                  onSelectScene={props.onSelectScene}
                  hasOutline={Boolean(props.scenes.length > 0)}
                  generatingSceneIndex={props.generatingSceneIndex}
                  onGenerateScene={props.onGenerateScene}
                  projectId={props.projectId}
                  projectType={props.projectType}
                  bulkProgress={props.bulkProgress}
                  onBulkGenerate={props.onBulkGenerate}
                  onOpenOutlineModal={props.onOpenOutlineModal}
                  audioGeneratedAt={props.liveOutline?.audioGeneratedAt}
                />
              </div>
            </div>
          ) : (
            <div className="mx-auto flex h-full w-full max-w-5xl items-center justify-center">
              <EmptyState
                mode={props.projectType}
                hasError={Boolean(props.loadError)}
              />
            </div>
          )}
        </div>
      </main>

      <div
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(chatRatio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        onPointerDown={onSplitterPointerDown}
        onPointerMove={onSplitterPointerMove}
        onPointerUp={onSplitterPointerUp}
        onPointerCancel={onSplitterPointerUp}
        className="group relative shrink-0 cursor-col-resize bg-transparent hover:bg-brand-50/40 active:bg-brand-100"
        style={{ width: SPLITTER_WIDTH }}
      >
        <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-ink-200 group-hover:bg-brand-300 group-active:bg-brand-400" />
      </div>

      <aside
        className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-l border-ink-200/70"
        style={{ width: chatWidth }}
      >
        <AIChat
          key={props.projectId ?? "__no_project__"}
          projectId={props.projectId}
          initialHistory={props.chatHistory}
          loading={props.chatLoading}
          liveOutline={props.liveOutline}
          onNewHistory={props.onNewHistory}
          onOpenOutlineModal={props.onOpenOutlineModal}
          bottomDockHeight={WORKSPACE_BOTTOM_DOCK_HEIGHT}
          hideHeader
        />
      </aside>
      </div>
    </div>
  );
}

function clampRatio(r: number): number {
  // 最大 0.5（1:1 上限），最小留出 main 至少 200px 不被挤死
  return Math.max(0.15, Math.min(0.5, r));
}

function EmptyState({
  mode,
  hasError,
}: {
  mode: ProjectType;
  hasError: boolean;
}) {
  return (
    <div className="card flex min-h-[420px] flex-col items-center justify-center gap-3 px-8 py-12 text-center">
      <h3 className="text-lg font-semibold text-ink-900">
        {hasError ? "暂时无法加载项目" : "还没有任何项目"}
      </h3>
      <p className="max-w-md text-sm text-ink-500">
        {hasError
          ? "请检查 DATA_DIR 目录是否存在且当前进程可读写，刷新后重试。"
          : `回到首页，点击 ${PROJECT_TYPE_LABEL[mode]}模式 的"开始创作"按钮，即可创建你的第一个项目。`}
      </p>
      <Link
        href="/"
        className="mt-2 inline-flex items-center gap-2 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-medium text-white shadow-glow transition hover:opacity-95"
      >
        返回首页创建项目
      </Link>
    </div>
  );
}

function formatCreatedLabel(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 等待录制预览区挂载；HTML 模式要求区域比例与项目画幅一致 */
async function waitForCaptureRegion(
  getRegion: () => HTMLElement | null,
  expectedWidth: number,
  expectedHeight: number,
  maxMs: number,
): Promise<void> {
  const start = performance.now();
  const needAspect = expectedWidth > 0 && expectedHeight > 0;
  const expectedAspect = expectedWidth / expectedHeight;
  const aspectTol = 0.05;
  while (performance.now() - start < maxMs) {
    const el = getRegion();
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      if (needAspect) {
        if (width >= 320 && height >= 180) {
          const aspect = width / height;
          if (Math.abs(aspect - expectedAspect) <= aspectTol) {
            return;
          }
        }
      } else if (width >= 320 && height >= 180) {
        return;
      }
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  if (needAspect) {
    throw new Error(
      `预览区域尚未就绪（需要 ${expectedWidth}×${expectedHeight} 比例），请稍后再试。`,
    );
  }
  throw new Error("预览区域尚未就绪，请稍后再试。");
}
