import clsx from "clsx";
import { ArrowRight, Check, Loader2 } from "lucide-react";

type Theme = "brand" | "accent";

type ModeCardProps = {
  theme: Theme;
  title: string;
  description: string;
  features: string[];
  recommended?: boolean;
  illustration: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  error?: string | null;
  onCreate: () => void;
};

const THEME_CFG = {
  brand: {
    button:
      "bg-gradient-to-r from-brand-500 to-brand-700 shadow-glow hover:opacity-95",
    badge: "bg-brand-100 text-brand-700",
    check: "text-brand-600",
    glow: "from-brand-100/60 to-transparent",
  },
  accent: {
    button:
      "bg-gradient-to-r from-accent-400 to-accent-600 shadow-[0_8px_24px_-8px_rgba(16,185,129,0.5)] hover:opacity-95",
    badge: "bg-accent-100 text-accent-700",
    check: "text-accent-600",
    glow: "from-accent-100/60 to-transparent",
  },
} as const;

export function ModeCard({
  theme,
  title,
  description,
  features,
  recommended,
  illustration,
  loading = false,
  disabled = false,
  error = null,
  onCreate,
}: ModeCardProps) {
  const cfg = THEME_CFG[theme];
  const isDisabled = loading || disabled;

  return (
    <div
      className={clsx(
        "group relative flex flex-col rounded-3xl border border-ink-200/70 bg-white p-7 shadow-card transition",
        !isDisabled && "hover:-translate-y-1 hover:shadow-[0_18px_36px_-12px_rgba(99,102,241,0.18)]",
        disabled && !loading && "opacity-60",
      )}
    >
      <div
        className={clsx(
          "pointer-events-none absolute inset-0 -z-0 rounded-3xl bg-gradient-to-br opacity-60",
          cfg.glow,
        )}
      />

      <div className="relative z-10 flex items-start justify-between gap-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-semibold text-ink-900">{title}</h3>
            {recommended && (
              <span
                className={clsx(
                  "rounded-md px-2 py-0.5 text-xs font-medium",
                  cfg.badge,
                )}
              >
                推荐
              </span>
            )}
          </div>
          <p className="max-w-[260px] text-sm leading-relaxed text-ink-500">
            {description}
          </p>
        </div>

        <div className="shrink-0">{illustration}</div>
      </div>

      <ul className="relative z-10 mt-5 space-y-2.5">
        {features.map((f) => (
          <li key={f} className="flex items-center gap-2 text-sm text-ink-700">
            <Check className={clsx("h-4 w-4", cfg.check)} strokeWidth={3} />
            {f}
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={onCreate}
        disabled={isDisabled}
        className={clsx(
          "relative z-10 mt-7 inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-medium text-white transition",
          cfg.button,
          isDisabled
            ? "cursor-not-allowed opacity-80"
            : "active:scale-[0.99]",
        )}
      >
        {loading ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" />
            正在创建项目...
          </>
        ) : (
          <>
            开始创作
            <ArrowRight className="h-4 w-4" />
          </>
        )}
      </button>

      {error && (
        <p className="relative z-10 mt-3 text-xs leading-relaxed text-red-500">
          {error}
        </p>
      )}
    </div>
  );
}

export function ImageCarouselIllustration() {
  return (
    <div className="relative h-[110px] w-[110px]">
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-brand-200/70 to-brand-400/60 shadow-[0_8px_24px_-8px_rgba(124,77,255,0.4)]" />
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full p-4"
        fill="none"
      >
        <rect
          x="14"
          y="20"
          width="58"
          height="48"
          rx="8"
          fill="white"
          fillOpacity="0.85"
        />
        <circle cx="28" cy="34" r="4" fill="#7c4dff" />
        <path
          d="M14 60 L32 44 L48 56 L62 46 L72 56 L72 68 L14 68 Z"
          fill="#7c4dff"
          fillOpacity="0.85"
        />
      </svg>
      <div className="absolute -bottom-1 -right-1 grid h-9 w-9 place-items-center rounded-full bg-white shadow-card">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 translate-x-[1px]" fill="#7c4dff">
          <path d="M8 5.14v13.72c0 .79.87 1.27 1.54.84l10.5-6.86c.62-.41.62-1.32 0-1.72L9.54 4.3C8.87 3.87 8 4.35 8 5.14z" />
        </svg>
      </div>
    </div>
  );
}

export function HtmlVideoIllustration() {
  return (
    <div className="relative h-[110px] w-[110px]">
      <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-accent-200/70 to-accent-400/60 shadow-[0_8px_24px_-8px_rgba(16,185,129,0.4)]" />
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 h-full w-full p-4"
        fill="none"
      >
        <rect
          x="14"
          y="20"
          width="72"
          height="56"
          rx="8"
          fill="white"
          fillOpacity="0.9"
        />
        <rect x="14" y="20" width="72" height="12" rx="8" fill="white" fillOpacity="0.6" />
        <circle cx="22" cy="26" r="1.6" fill="#10b981" />
        <circle cx="28" cy="26" r="1.6" fill="#34d399" />
        <circle cx="34" cy="26" r="1.6" fill="#6ee7b7" />
        <text
          x="50"
          y="50"
          textAnchor="middle"
          fontSize="11"
          fontFamily="monospace"
          fill="#10b981"
          fontWeight="600"
        >
          {"</>"}
        </text>
        <rect x="58" y="56" width="4" height="10" rx="1" fill="#10b981" />
        <rect x="64" y="52" width="4" height="14" rx="1" fill="#34d399" />
        <rect x="70" y="48" width="4" height="18" rx="1" fill="#6ee7b7" />
      </svg>
    </div>
  );
}
