import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VideoAgent — 用 AI 创作精彩视频",
  description:
    "VideoAgent 是一款 AI 视频创作平台，支持图片轮播与 HTML 视频两种模式，从脚本到导出一站式完成。",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
