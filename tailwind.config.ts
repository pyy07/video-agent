import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#f3f1ff",
          100: "#ebe6ff",
          200: "#d9d0ff",
          300: "#bdaaff",
          400: "#9c7bff",
          500: "#7c4dff",
          600: "#6a36f5",
          700: "#5a26d8",
          800: "#4a21ae",
          900: "#3e1d8a",
        },
        accent: {
          50: "#ecfdf5",
          100: "#d1fae5",
          200: "#a7f3d0",
          300: "#6ee7b7",
          400: "#34d399",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
        },
        ink: {
          900: "#0f172a",
          800: "#1e293b",
          700: "#334155",
          600: "#475569",
          500: "#64748b",
          400: "#94a3b8",
          300: "#cbd5e1",
          200: "#e2e8f0",
          100: "#f1f5f9",
          50: "#f8fafc",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "PingFang SC",
          "Hiragino Sans GB",
          "Microsoft YaHei",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      boxShadow: {
        soft: "0 1px 2px 0 rgba(15, 23, 42, 0.04), 0 4px 12px -2px rgba(15, 23, 42, 0.06)",
        card: "0 4px 16px -4px rgba(99, 102, 241, 0.12), 0 2px 6px -2px rgba(15, 23, 42, 0.06)",
        glow: "0 8px 24px -8px rgba(124, 77, 255, 0.45)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #7c4dff 0%, #6a36f5 100%)",
        "accent-gradient": "linear-gradient(135deg, #34d399 0%, #10b981 100%)",
        "hero-gradient":
          "radial-gradient(1200px 600px at 50% -10%, #ede9fe 0%, transparent 60%), radial-gradient(800px 400px at 90% 20%, #dbeafe 0%, transparent 60%), linear-gradient(180deg, #fbfaff 0%, #f5f3ff 100%)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        float: {
          "0%, 100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-8px)" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.25s ease-out",
        float: "float 6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
