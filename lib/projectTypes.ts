// 纯类型与常量定义 —— 此文件被服务端 DAO 与客户端组件共享，
// 严禁在这里 import 任何依赖 Node API 的库（例如 mysql2），
// 否则会把数据库驱动打包进客户端 bundle。

import type { VideoSize } from "./exportVideo";

export type ProjectType = "image" | "html";

export const PROJECT_TYPE_LABEL: Record<ProjectType, string> = {
  image: "图片轮播",
  html: "HTML 视频",
};

export interface ProjectSummary {
  uuid: string;
  title: string;
  type: ProjectType;
  /** 视频画幅（创建项目时设定） */
  videoSize?: VideoSize;
  /** ISO 8601 字符串，便于跨服务端/客户端序列化 */
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  storyboard: string;
  sourceCode: string;
}
