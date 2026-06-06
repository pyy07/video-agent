/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 把数据目录排除在 dev 文件监听之外，否则每次新建/编辑项目都会触发整页 HMR。
  // 这里覆写默认的 ignored（默认值含 RegExp，schema 校验只接受字符串数组），
  // 因此把 node_modules / .next 也显式加进去补回默认覆盖范围。
  webpack(config) {
    config.watchOptions = {
      ...config.watchOptions,
      ignored: ["**/node_modules/**", "**/.next/**", "**/data/**"],
    };
    return config;
  },
};

export default nextConfig;

