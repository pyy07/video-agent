import { UserRound } from "lucide-react";
import { Logo } from "@/components/Logo";

export function Header() {
  return (
    <header className="relative z-10 flex items-center justify-between px-8 py-6">
      <Logo size="md" />
      <button className="inline-flex items-center gap-2 rounded-xl border border-brand-200 bg-white/70 px-4 py-2 text-sm font-medium text-brand-700 backdrop-blur transition hover:border-brand-300 hover:bg-white">
        <UserRound className="h-4 w-4" />
        登录 / 注册
      </button>
    </header>
  );
}
