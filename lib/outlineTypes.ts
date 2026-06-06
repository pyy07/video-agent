// 视频大纲相关类型 —— client-safe。
// 此文件严禁 import 任何 Node 依赖。

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
   *  - image 模式：英文图片生成提示词（subject / style / lighting / composition / palette）
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
   * 全局画面风格提示词（仅 image 模式有值）。
   * 由 AI 根据脚本内容自动生成，会 prepended 到每个分镜的 prompt 前面，
   * 确保整组画面风格一致。
   */
  globalStylePrompt?: string;
  /** 6..30 个分镜 */
  scenes: OutlineScene[];
  /** ISO 字符串 */
  generatedAt: string;
}
