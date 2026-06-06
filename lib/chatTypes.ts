import type { IntentAction } from "./intents";
import type { VideoOutline } from "./outlineTypes";

/**
 * 聊天消息的持久化形态。
 *
 * 设计要点：
 *  - client-safe：本文件严禁 import 任何依赖 Node API 的库
 *  - createdAt 是 ISO 字符串，便于跨服务端/客户端序列化
 *  - intent 仅在 assistant 消息上设置（来自 LLM 分类结果），便于后续做分析 / 重试
 *  - error 仅在「LLM 调用或解析失败后写入的兜底 assistant 消息」上设置，UI 用它
 *    把失败消息渲染成琥珀色，提示用户这是降级结果
 *  - kind: "outline" 表示 assistant 消息附带了一份完整的视频大纲，UI 应当渲染为
 *    卡片（含分镜表格 + 完整大纲弹窗入口），而不是普通文本气泡
 */
export type PersistedChatMessage =
  | {
      id: string;
      role: "user";
      content: string;
      createdAt: string;
    }
  | {
      id: string;
      role: "assistant";
      kind: "text";
      content: string;
      createdAt: string;
      intent?: IntentAction;
      error?: true;
    }
  | {
      id: string;
      role: "assistant";
      kind: "outline";
      content: string;
      createdAt: string;
      intent: IntentAction;
      outline: VideoOutline;
    };
