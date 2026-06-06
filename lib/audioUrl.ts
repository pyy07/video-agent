/**
 * 分镜音频 URL 构造（client-safe）。
 * 用 audioGeneratedAt 做 cache bust，避免浏览器复用旧 mp3。
 */

export function projectAudioUrl(
  projectId: string,
  sceneIndex: number,
  audioGeneratedAt?: string,
): string {
  const base = `/api/project-audio/${projectId}/${sceneIndex}.mp3`;
  if (audioGeneratedAt) {
    return `${base}?v=${encodeURIComponent(audioGeneratedAt)}`;
  }
  return base;
}

/** 整片录音 full.mp3（预览连续播放用） */
export function projectFullAudioUrl(
  projectId: string,
  audioGeneratedAt?: string,
): string {
  const base = `/api/project-audio/${projectId}/full.mp3`;
  if (audioGeneratedAt) {
    return `${base}?v=${encodeURIComponent(audioGeneratedAt)}`;
  }
  return base;
}
