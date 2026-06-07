// 一键生成待办计数（client-safe）—— 整片音频只算 1 项，不按分镜重复计。

import type { OutlineScene } from "@/lib/outlineTypes";

/** 统计待生成任务数：每镜缺画面/HTML 各算 1；全片缺音频再 +1 */
export function countPendingGenerateTasks(
  scenes: OutlineScene[],
  isHtmlMode: boolean,
): number {
  let n = 0;
  for (const s of scenes) {
    if (isHtmlMode) {
      if (!s.htmlPath) n++;
    } else if (!s.imagePath) {
      n++;
    }
  }
  if (scenes.some((s) => !s.audioPath)) {
    n += 1;
  }
  return n;
}
