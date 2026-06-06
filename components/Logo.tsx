import clsx from "clsx";

type LogoProps = {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  className?: string;
};

const SIZE_MAP = {
  sm: { box: "h-8 w-8", icon: "h-3.5 w-3.5", text: "text-base" },
  md: { box: "h-10 w-10", icon: "h-4 w-4", text: "text-lg" },
  lg: { box: "h-12 w-12", icon: "h-5 w-5", text: "text-xl" },
};

export function Logo({ size = "md", showWordmark = true, className }: LogoProps) {
  const s = SIZE_MAP[size];
  return (
    <div className={clsx("flex items-center gap-2.5", className)}>
      <div
        className={clsx(
          "relative grid place-items-center rounded-xl bg-brand-gradient shadow-glow",
          s.box,
        )}
      >
        <svg
          viewBox="0 0 24 24"
          fill="white"
          className={clsx("translate-x-[1px]", s.icon)}
          aria-hidden
        >
          <path d="M8 5.14v13.72c0 .79.87 1.27 1.54.84l10.5-6.86c.62-.41.62-1.32 0-1.72L9.54 4.3C8.87 3.87 8 4.35 8 5.14z" />
        </svg>
      </div>
      {showWordmark && (
        <span className={clsx("font-semibold tracking-tight text-ink-900", s.text)}>
          VideoAgent
        </span>
      )}
    </div>
  );
}
