// 视频大纲相关类型 —— client-safe。
// 此文件严禁 import 任何 Node 依赖。

import type { VideoSize } from "./exportVideo";
import type { ProjectType } from "./projectTypes";

export interface OutlineScene {
  /** 1-based，与显示顺序一致 */
  index: number;
  /** 分镜标题（短） */
  title: string;
  /** 该镜的旁白文本（与逐字稿对应段一致） */
  narration: string;
  /**
   * 画面提示词：
   *  - image 模式：最终英文图片 prompt（全局风格 + 本镜 subject，已拼装）
   *  - html 模式：中文网页动画规格（元素 / 动作 / 缓动 / 时长）
   */
  prompt: string;
  /**
   * 生成的图片路径（相对于项目目录的路径，如 "images/1.png"）。
   * 仅在图片生成完成后填充。
   */
  imagePath?: string;
  /**
   * 生成的音频路径（相对于项目目录的路径，如 "audio/1.mp3"）。
   * 仅在音频生成完成后填充。
   */
  audioPath?: string;
  /**
   * 生成的 HTML 路径（相对于项目目录的路径，如 "scenes/1.html"）。
   * 仅在 HTML 模式下分镜动画生成完成后填充。
   */
  htmlPath?: string;
}

export interface VideoOutline {
  mode: ProjectType;
  /** 完整逐字稿（与 scenes 拆分的总集） */
  script: string;
  /**
   * 视频画幅（生成大纲时写入，HTML/图片生成与导出均以此为准）
   */
  videoSize?: VideoSize;
  /**
   * 全局画面风格（仅 image 模式）。
   * 归一化后的英文 prose；各分镜 prompt 由 buildSceneImagePrompt 与其拼接，勿重复堆叠。
   */
  globalStylePrompt?: string;
  /** 6..30 个分镜 */
  scenes: OutlineScene[];
  /** ISO 字符串 */
  generatedAt: string;
  /** 最近一次整片音频生成时间（ISO），用于前端 cache bust */
  audioGeneratedAt?: string;
}
