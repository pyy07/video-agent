// 共用的分镜封面色板。HTML / 图片模式下都用同一组渐变 —— 后续接入真实
// 画面生成时这里会被替换为生成的图像 URL。
const SCENE_COVERS: readonly string[] = [
  "linear-gradient(160deg, #0b1024 0%, #1e1b4b 50%, #312e81 100%)",
  "linear-gradient(160deg, #0c4a6e 0%, #0369a1 60%, #0ea5e9 100%)",
  "linear-gradient(160deg, #3730a3 0%, #4f46e5 60%, #818cf8 100%)",
  "linear-gradient(160deg, #4c1d95 0%, #6d28d9 55%, #a78bfa 100%)",
  "linear-gradient(160deg, #064e3b 0%, #047857 60%, #34d399 100%)",
  "linear-gradient(160deg, #134e4a 0%, #0f766e 55%, #2dd4bf 100%)",
];

export function pickSceneCover(index: number): string {
  const i = ((index - 1) % SCENE_COVERS.length + SCENE_COVERS.length) % SCENE_COVERS.length;
  return SCENE_COVERS[i];
}
