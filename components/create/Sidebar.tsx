"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, Film, Loader2, Pencil, Plus, Search, Trash2, X, Code2 } from "lucide-react";
import { Logo } from "@/components/Logo";
import { WORKSPACE_HEADER_HEIGHT } from "@/lib/workspaceLayout";
import {
  PROJECT_TYPE_LABEL,
  type ProjectSummary,
  type ProjectType,
} from "@/lib/projectTypes";

type SidebarProps = {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  loadError: string | null;
  onSelectProject: (id: string) => void;
  /** 重命名回调（uuid -> 新名字）。错误处理在父级完成，这里只发起请求。 */
  onRenameProject: (uuid: string, nextTitle: string) => Promise<void> | void;
  /**
   * 删除回调。**必须已经过二次确认**（弹窗在 Sidebar 内部完成），
   * 父级负责：服务器删除 + 本地状态同步 + 激活项目切换。
   */
  onDeleteProject: (uuid: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** 打开"完整大纲内容"弹窗（带当前 live outline） */
  onOpenOutlineModal: () => void;
};

export function Sidebar({
  projects,
  activeProjectId,
  loadError,
  onSelectProject,
  onRenameProject,
  onDeleteProject,
  onOpenOutlineModal,
}: SidebarProps) {
  const [keyword, setKeyword] = useState("");
  const filtered = keyword.trim()
    ? projects.filter((p) =>
        p.title.toLowerCase().includes(keyword.trim().toLowerCase()),
      )
    : projects;

  // 二次确认 modal 的待删项目
  const [pendingDelete, setPendingDelete] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const closeDeleteModal = () => {
    if (deleting) return;
    setPendingDelete(null);
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    const res = await onDeleteProject(pendingDelete.uuid);
    setDeleting(false);
    if (!res.ok) {
      setDeleteError(res.error);
      return;
    }
    setPendingDelete(null);
  };

  // ESC 关闭删除弹窗
  useEffect(() => {
    if (!pendingDelete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDeleteModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pendingDelete, deleting]);

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-ink-200/70 bg-white">
      <div
        className="flex shrink-0 items-center border-b border-ink-200/70 px-5"
        style={{ height: WORKSPACE_HEADER_HEIGHT }}
      >
        <Link href="/" className="transition-opacity hover:opacity-80" title="返回首页">
          <Logo size="sm" />
        </Link>
      </div>

      <div className="px-5 pt-4">
        <Link
          href="/"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-gradient px-4 py-2.5 text-sm font-medium text-white shadow-glow transition hover:opacity-95"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          新建项目
        </Link>
      </div>

      <div className="mt-5 px-5">
        <h3 className="text-sm font-semibold text-ink-900">历史项目</h3>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-400" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="搜索项目名称"
            className="w-full rounded-lg border border-ink-200 bg-ink-50 py-2 pl-8 pr-3 text-xs text-ink-700 placeholder:text-ink-400 outline-none transition focus:border-brand-300 focus:bg-white"
          />
        </div>
      </div>

      <nav className="mt-3 flex-1 overflow-y-auto px-3 pb-3">
        {loadError ? (
          <div className="mx-2 mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
            <div className="mb-1 flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" />
              加载失败
            </div>
            {loadError}
          </div>
        ) : projects.length === 0 ? (
          <p className="mx-2 mt-6 text-center text-xs text-ink-400">
            还没有项目，点击上方
            <br />
            「新建项目」开始创作
          </p>
        ) : filtered.length === 0 ? (
          <p className="mx-2 mt-6 text-center text-xs text-ink-400">
            没有匹配的项目
          </p>
        ) : (
          <ul className="space-y-1">
            {filtered.map((p) => (
              <li key={p.uuid}>
                <ProjectItem
                  project={p}
                  active={p.uuid === activeProjectId}
                  onClick={() => onSelectProject(p.uuid)}
                  onRequestDelete={() => {
                    setDeleteError(null);
                    setPendingDelete(p);
                  }}
                  onCommitRename={(next) => onRenameProject(p.uuid, next)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="border-t border-ink-200/70 p-3">
        <button className="w-full rounded-lg border border-ink-200 bg-white py-2 text-xs font-medium text-ink-600 transition hover:border-ink-300 hover:bg-ink-50">
          查看全部项目 ({projects.length})
        </button>
      </div>

      {/* 删除二次确认弹窗 */}
      {pendingDelete && (
        <DeleteConfirmModal
          project={pendingDelete}
          deleting={deleting}
          error={deleteError}
          onClose={closeDeleteModal}
          onConfirm={confirmDelete}
        />
      )}
    </aside>
  );
}

/* ===========================================================================
 * 项目卡片
 * ========================================================================= */

type ProjectItemProps = {
  project: ProjectSummary;
  active: boolean;
  onClick: () => void;
  onRequestDelete: () => void;
  onCommitRename: (next: string) => Promise<void> | void;
};

function ProjectItem({
  project,
  active,
  onClick,
  onRequestDelete,
  onCommitRename,
}: ProjectItemProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(project.title);

  // 外部 title 变化（比如父级回退）时同步
  useEffect(() => {
    if (!isRenaming) setRenameValue(project.title);
  }, [project.title, isRenaming]);

  const commitRename = async () => {
    const next = renameValue.trim();
    setIsRenaming(false);
    if (next.length === 0 || next === project.title) {
      setRenameValue(project.title);
      return;
    }
    await onCommitRename(next);
  };

  return (
    <div
      className={clsx(
        "group relative flex items-center gap-2 rounded-xl px-2 py-2 transition",
        active ? "bg-brand-50 ring-1 ring-brand-200" : "hover:bg-ink-50",
      )}
    >
      {/* 文本（不再渲染封面方块） */}
      {isRenaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setRenameValue(project.title);
              setIsRenaming(false);
            }
          }}
          maxLength={80}
          onClick={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 rounded-md border border-brand-300 bg-white px-2 py-1 text-xs font-medium text-ink-900 outline-none focus:ring-2 focus:ring-brand-100"
        />
      ) : (
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 flex-1 text-left"
        >
          {/* 标题独占一行：不会被徽章挤掉 */}
          <div className="truncate text-xs font-medium text-ink-900">
            {project.title}
          </div>
          {/* 第二行：时间 + 徽章。徽章放右侧，flex-1 + truncate 给时间腾位 */}
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-400">
            <span className="min-w-0 flex-1 truncate">
              <TimeLabel iso={project.createdAt} />
            </span>
            <TypeBadge type={project.type} />
          </div>
        </button>
      )}

      {/* 右侧操作按钮（hover 出现，常显激活项） */}
      {!isRenaming && (
        <div
          className={clsx(
            "flex shrink-0 items-center gap-0.5 transition",
            active
              ? "opacity-100"
              : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
          )}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setRenameValue(project.title);
              setIsRenaming(true);
            }}
            title="重命名"
            aria-label="重命名"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-500 transition hover:bg-ink-100 hover:text-ink-700"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRequestDelete();
            }}
            title="删除项目"
            aria-label="删除项目"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-500 transition hover:bg-red-50 hover:text-red-600"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function TypeBadge({ type }: { type: ProjectType }) {
  const label = PROJECT_TYPE_LABEL[type];
  if (type === "html") {
    return (
      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-teal-50 px-1.5 py-px text-[10px] font-medium text-teal-700 ring-1 ring-inset ring-teal-200/70">
        <Code2 className="h-2.5 w-2.5" />
        {label}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md bg-indigo-50 px-1.5 py-px text-[10px] font-medium text-indigo-700 ring-1 ring-inset ring-indigo-200/70">
      <Film className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}

/* ===========================================================================
 * 删除二次确认弹窗
 * ========================================================================= */

function DeleteConfirmModal({
  project,
  deleting,
  error,
  onClose,
  onConfirm,
}: {
  project: ProjectSummary;
  deleting: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-project-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <div
        className="absolute inset-0 bg-ink-900/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="relative z-10 w-[min(440px,92vw)] overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-200/70 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-red-500" />
            <h2
              id="delete-project-title"
              className="text-sm font-semibold text-ink-900"
            >
              删除项目
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            aria-label="关闭"
            className="grid h-7 w-7 place-items-center rounded-md text-ink-500 transition hover:bg-ink-100 hover:text-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <p className="text-sm leading-relaxed text-ink-700">
            确定要删除项目
            <span className="mx-1 rounded-md bg-ink-100 px-1.5 py-0.5 font-mono text-[12px] text-ink-900">
              {project.title}
            </span>
            吗？
          </p>
          <div className="rounded-lg border border-red-200 bg-red-50/70 px-3 py-2 text-[12px] leading-relaxed text-red-700">
            此操作将<strong>永久删除</strong>该项目下所有资源：脚本大纲、生成画面、旁白音频、聊天记录。
            <strong>无法恢复</strong>。
          </div>
          {error && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-700">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-200/70 bg-ink-50/40 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={deleting}
            className="rounded-md border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 transition hover:border-ink-300 hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
            {deleting ? "正在删除…" : "确认删除"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ===========================================================================
 * 时间标签
 * ========================================================================= */

function TimeLabel({ iso }: { iso: string }) {
  const [label, setLabel] = useState(() => formatAbsolute(iso));

  useEffect(() => {
    const update = () => setLabel(formatRelative(iso));
    update();
    const id = setInterval(update, 60_000);
    return () => clearInterval(id);
  }, [iso]);

  return <span className="truncate">{label}</span>;
}

function formatAbsolute(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffSec = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (diffSec < 60) return "刚刚更新";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (sameDay(d, now)) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday))
    return `昨天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
