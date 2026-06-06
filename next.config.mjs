import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Next.js 默认忽略 node_modules / .git / .next 的 RegExp */
const DEFAULT_WATCH_IGNORED =
  /^((?:[^/]*(?:\/|$))*)(\.(git|next)|node_modules)(\/((?:[^/]*(?:\/|$))*)(?:$|\/))?/;

/** 仅忽略项目根目录下的 data 目录（不能用 glob 形式的 data 段，否则路径含 data 时会误伤源码监听） */
const projectDataDir = path.join(__dirname, "data").replace(/\\/g, "/");
const escapedProjectDataDir = projectDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PROJECT_DATA_IGNORED = new RegExp(`^${escapedProjectDataDir}(?:/|$)`);

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 含原生二进制的包不能被打进 .next 分包，否则 spawn 路径会错
  serverExternalPackages: ["ffmpeg-static", "music-metadata"],
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: new RegExp(
          `${PROJECT_DATA_IGNORED.source}|(?:${DEFAULT_WATCH_IGNORED.source})`,
        ),
      };
    }
    return config;
  },
};

export default nextConfig;
