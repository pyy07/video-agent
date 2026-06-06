export function BackgroundDecor() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg
        className="absolute left-0 top-1/3 h-[480px] w-full text-brand-200/50"
        viewBox="0 0 1440 480"
        fill="none"
        preserveAspectRatio="none"
      >
        <path
          d="M-100 240 Q 360 80 720 240 T 1540 240"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="4 8"
          fill="none"
        />
      </svg>

      <div className="absolute left-[8%] top-[42%] h-3 w-3 rotate-45 rounded-sm bg-brand-300/50" />
      <div className="absolute left-[14%] top-[68%] h-4 w-4 rounded-md border border-brand-300/60 bg-white/40" />
      <div className="absolute right-[10%] top-[28%] h-3 w-3 rounded-full bg-brand-300/60" />
      <div className="absolute right-[18%] top-[60%] h-6 w-6 rotate-12 rounded-lg border border-accent-300/60 bg-white/40 backdrop-blur" />
      <div className="absolute right-[5%] top-[44%] h-10 w-10 rotate-6 rounded-xl bg-gradient-to-br from-brand-200/50 to-brand-300/40" />

      <div
        className="absolute -left-24 -top-24 h-[520px] w-[520px] rounded-full bg-brand-200/20 blur-3xl"
        aria-hidden
      />
      <div
        className="absolute -right-32 top-10 h-[420px] w-[420px] rounded-full bg-accent-200/20 blur-3xl"
        aria-hidden
      />
    </div>
  );
}
