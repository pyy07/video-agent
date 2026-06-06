import Link from "next/link";
import { ArrowRight, FolderOpen } from "lucide-react";

export function Hero() {
  return (
    <section className="relative z-10 pt-6 text-center">
      <h1 className="text-5xl font-bold tracking-tight text-ink-900">
        用{" "}
        <span className="bg-gradient-to-r from-brand-500 to-brand-700 bg-clip-text text-transparent">
          AI
        </span>{" "}
        创作精彩视频
      </h1>
      <p className="mt-4 text-base text-ink-500">
        从想法到视频，AI 帮你一站式完成
      </p>

      {/*
        进入创作页：纯跳转，**不**触发 createProjectAction。
        行为差别：
          - 「开始创作」是"创建新项目并跳转"（CreateModeCards 里的卡片按钮）
          - 本按钮是"直接进创作页"：带最近的项目进来，没有就看到 EmptyState 由用户决定
      */}
      <div className="mt-6 flex justify-center">
        <Link
          href="/create"
          className="group inline-flex items-center gap-1.5 rounded-full border border-ink-200/80 bg-white/70 px-4 py-1.5 text-xs font-medium text-ink-600 shadow-sm backdrop-blur transition hover:border-brand-300 hover:bg-white hover:text-brand-700"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          进入创作页
          <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
        </Link>
      </div>
    </section>
  );
}
