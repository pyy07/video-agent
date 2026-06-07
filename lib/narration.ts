// 旁白分句与字幕同步工具 —— client-safe（不依赖 Node API）。
// 用法：把整段 narration 切成多个短句（去掉句末标点），按"字数比例"分配音频播放时长，
// 在 VideoPreview 里用 currentTime 落到当前应展示的短句。

/**
 * 句末标点（中文 + 英文常见）。仅当出现在短句结尾时会被去掉。
 * 不包含逗号 / 顿号，因为它们用来切句但本身不出现在去标点后的短句结尾。
 */
const SENTENCE_ENDS = /[。？！…；.!?;]+$/u;

/**
 * 切句用的分隔符（中文 + 英文常见）。包含逗号 / 顿号 / 句号 / 问号 / 叹号 / 分号 / 冒号 / 省略号 / 破折号。
 * 用 sticky/global 在原文中扫描，保留原标点的位置以便分段。
 */
const SPLIT_RE = /[，,。.？?！!；;：:、…—]+/gu;

/** 单个字幕短句及其在整段旁白中的字数权重 */
export interface NarrationClause {
  /** 去掉句末标点后的可显示文本 */
  text: string;
  /** 该短句在整段旁白中所占的字数比例（0..1） */
  weight: number;
  /** 累计起点（0..1，左闭） */
  start: number;
  /** 累计终点（0..1，右开；最后一段为 1） */
  end: number;
}

/**
 * 把整段旁白切成多个短句，并按字数权重分配播放窗口。
 *
 * 步骤：
 *  1. 用标点切分，保留非空 token
 *  2. 去掉每段末尾的句末标点（保留中间字符）
 *  3. 用"去标点后的字符数"作为字数权重，归一化到 0..1
 *  4. 累加得到每段的 [start, end) 区间，VideoPreview 用 ratio 落到对应短句
 *
 * 边界处理：
 *  - 空字符串 → 返回空数组
 *  - 全是标点 → 返回空数组
 *  - 只有一句 → 一个 clause，weight=1，start=0, end=1
 */
export function splitNarration(narration: string): NarrationClause[] {
  if (!narration) return [];
  const raw = narration.trim();
  if (raw.length === 0) return [];

  // 按标点切分。split 会丢掉分隔符，正好是我们想要的（标点不进短句正文）。
  const tokens = raw
    .split(SPLIT_RE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    // 兜底：万一某个 token 末尾还残留句末标点（罕见），再 strip 一次
    .map((s) => s.replace(SENTENCE_ENDS, "").trim())
    .filter((s) => s.length > 0);

  if (tokens.length === 0) return [];

  const totalChars = tokens.reduce((sum, t) => sum + visualLength(t), 0);
  if (totalChars === 0) return [];

  let acc = 0;
  const clauses: NarrationClause[] = tokens.map((t, i) => {
    const w = visualLength(t) / totalChars;
    const start = acc;
    // 最后一段强制对齐到 1，避免浮点累计误差导致末尾留白
    const end = i === tokens.length - 1 ? 1 : start + w;
    acc = end;
    return { text: t, weight: w, start, end };
  });

  return clauses;
}

/**
 * 根据进度比例（0..1）落到对应短句的索引。
 * - ratio < 0  → 0
 * - ratio >= 1 → 最后一句
 * - 命中 [start, end) 区间的那一句
 * 返回 -1 表示 clauses 为空。
 */
export function clauseIndexAt(clauses: NarrationClause[], ratio: number): number {
  if (clauses.length === 0) return -1;
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  if (ratio >= 1) return clauses.length - 1;
  // 二分（短句数量通常 < 30，线性也够，但二分顺手稳）
  let lo = 0;
  let hi = clauses.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = clauses[mid];
    if (ratio < c.start) hi = mid - 1;
    else if (ratio >= c.end) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(clauses.length - 1, lo));
}

/** 字幕相对音频时钟的提前量（秒），补偿 TTS 略快于字数比例与 UI 刷新延迟 */
export const SUBTITLE_AUDIO_LEAD_SEC = 0.28;

/**
 * 根据镜内已播时长选取字幕短句（比进度条用更偏前的时钟，避免语音领先字幕）。
 */
export function subtitleClauseIndexAt(
  clauses: NarrationClause[],
  elapsedSec: number,
  speechDurationSec: number,
): number {
  if (clauses.length === 0 || speechDurationSec <= 0) return -1;
  const ratio = Math.min(
    1,
    Math.max(0, (elapsedSec + SUBTITLE_AUDIO_LEAD_SEC) / speechDurationSec),
  );
  return clauseIndexAt(clauses, ratio);
}

/**
 * 中英混排"视觉字数"：
 * 用 Intl.Segmenter 拿到字素簇数（CJK 字符算 1，emoji 不会被错分成 2）。
 * 不可用时回退 [...str].length（按 code point 分），仍然比 .length 更准。
 */
export function visualLength(s: string): number {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
      let n = 0;
      for (const _ of seg.segment(s)) n++;
      return n;
    } catch {
      // ignore, fall through
    }
  }
  return [...s].length;
}
