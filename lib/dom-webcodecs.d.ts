/**
 * 浏览器 WebCodecs / MediaStreamTrackProcessor 的最小类型声明。
 * 这些 API 在 TypeScript 标准 lib 里尚未稳定，自带 lib.dom.d.ts 只覆盖到 2024
 * 左右；本项目用到的部分在这里手动声明，让 tsc 编译通过。
 *
 * 来源参考：MDN + WebCodecs spec（Working Draft）。
 */

declare global {
  interface MediaStreamTrackProcessorInit {
    track: MediaStreamTrack;
  }

  interface MediaStreamTrackProcessorConstructor {
    new (init: MediaStreamTrackProcessorInit): MediaStreamTrackProcessor;
  }

  interface MediaStreamTrackProcessor {
    readonly readable: ReadableStream<VideoFrame | AudioData>;
  }

  // HTMLMediaElement.captureStream() — 标准 API 但部分 TS lib 版本未声明
  interface HTMLMediaElement {
    captureStream(): MediaStream;
  }

  // VideoColorSpace 在部分 TS lib 中已声明但要求 toJSON；这里兼容宽松写法
  interface VideoColorSpaceInit {
    primaries?: string;
    transfer?: string;
    matrix?: string;
    fullRange?: boolean;
  }

  interface VideoEncoderConfig {
    colorSpace?: VideoColorSpace;
  }

  // eslint-disable-next-line no-var
  var MediaStreamTrackProcessor: MediaStreamTrackProcessorConstructor;
}

export {};
