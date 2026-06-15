/**
 * WebCodecs + mp4-muxer 录屏引擎。
 *
 * 两种视频采集方式：
 *  - 图片轮播：隐藏 canvas 逐帧绘制 → captureStream
 *  - HTML 动画：getDisplayMedia 采标签页，按预览区 DOM 矩形裁切，固定输出项目画幅（如 1920×1080）
 *
 * 音轨统一走 Web Audio API 混流 HTMLAudioElement。
 */
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { bitrateForExportSize } from "./exportVideo";

/** 录屏引擎配置 */
export interface RecorderConfig {
  frameRate?: number;
  videoBitrate?: number;
  withAudio?: boolean;
  /** 目标输出宽度（像素） */
  width?: number;
  /** 目标输出高度（像素） */
  height?: number;
}

/** 录屏引擎的对外句柄 */
export interface RecordingHandle {
  stop(): Promise<{ blob: Blob; durationMs: number; width: number; height: number }>;
  cancel(): void;
  setAudioElement(audioEl: HTMLAudioElement | null): void;
  /** canvas 手动出帧时调用；标签页采集模式下为空操作 */
  notifyFrameDrawn(): void;
}

type BuildRecordingParams = {
  /** 直连视频轨（canvas captureStream） */
  videoTrack?: MediaStreamTrack;
  /** 标签页采集：每帧从 tab 画面裁切预览区，合成到固定画幅 */
  tabComposite?: {
    tabTrack: MediaStreamTrack;
    getCropRect: () => DOMRectReadOnly;
  };
  width: number;
  height: number;
  config: RecorderConfig;
  /** canvas 手动 requestFrame；为 null 表示视频轨自行出帧 */
  requestManualFrame: (() => void) | null;
  onCleanup: () => void;
};

/** Chrome 扩展的 getDisplayMedia 约束 */
type DisplayMediaConstraints = MediaStreamConstraints & {
  preferCurrentTab?: boolean;
  selfBrowserSurface?: "include" | "exclude";
  surfaceSwitching?: "include" | "exclude";
};

/** 将预览区 DOM 矩形映射到标签页视频帧像素坐标 */
function mapDomRectToFrameRect(
  rect: DOMRectReadOnly,
  frameW: number,
  frameH: number,
): { x: number; y: number; w: number; h: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scaleX = frameW / vw;
  const scaleY = frameH / vh;
  const x = Math.max(0, Math.round(rect.left * scaleX));
  const y = Math.max(0, Math.round(rect.top * scaleY));
  const w = Math.max(1, Math.min(frameW - x, Math.round(rect.width * scaleX)));
  const h = Math.max(1, Math.min(frameH - y, Math.round(rect.height * scaleY)));
  return { x, y, w, h };
}

async function buildRecordingHandle(params: BuildRecordingParams): Promise<RecordingHandle> {
  const { videoTrack, tabComposite, width, height, config, requestManualFrame, onCleanup } =
    params;
  if (!videoTrack && !tabComposite) {
    throw new Error("recorder_no_source: 未指定视频来源");
  }
  if (videoTrack && tabComposite) {
    throw new Error("recorder_dual_source: 不能同时指定直连轨与标签页合成");
  }

  const frameRate = config.frameRate ?? 30;
  const outputWidth = width;
  const outputHeight = height;
  if (outputWidth < 2 || outputHeight < 2) {
    throw new Error(`recorder_invalid_size: 无效输出尺寸 ${outputWidth}×${outputHeight}`);
  }
  const videoBitrate =
    config.videoBitrate ?? bitrateForExportSize(outputWidth, outputHeight);
  const withAudio = config.withAudio !== false;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: "in-memory",
    video: { codec: "avc", width: outputWidth, height: outputHeight, frameRate },
    audio: withAudio ? { codec: "aac", numberOfChannels: 2, sampleRate: 48_000 } : undefined,
    firstTimestampBehavior: "offset",
  });

  let videoChunkCount = 0;
  const origAddVideoChunk = muxer.addVideoChunk.bind(muxer);
  const origAddVideoChunkRaw = muxer.addVideoChunkRaw.bind(muxer);
  muxer.addVideoChunk = (sample, meta, timestamp, compositionTimeOffset) => {
    videoChunkCount++;
    return origAddVideoChunk(
      sample,
      ensureVideoMetaColorSpace(meta),
      timestamp,
      compositionTimeOffset,
    );
  };
  muxer.addVideoChunkRaw = (data, type, timestamp, duration, meta, compositionTimeOffset) => {
    videoChunkCount++;
    return origAddVideoChunkRaw(
      data,
      type,
      timestamp,
      duration,
      ensureVideoMetaColorSpace(meta),
      compositionTimeOffset,
    );
  };

  const VIDEO_COLOR_SPACE: VideoColorSpace = new VideoColorSpace({
    primaries: "bt709",
    transfer: "iec61966-2-1",
    matrix: "rgb",
    fullRange: true,
  });

  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta, chunk.timestamp);
    },
    error: (e) => {
      console.error("[recorder] VideoEncoder error:", e);
    },
  });
  const encoderConfig: VideoEncoderConfig = {
    codec: "avc1.640033",
    width: outputWidth,
    height: outputHeight,
    bitrate: videoBitrate,
    framerate: frameRate,
    latencyMode: "quality",
    bitrateMode: "variable",
    hardwareAcceleration: "prefer-hardware",
    colorSpace: VIDEO_COLOR_SPACE,
  };
  try {
    videoEncoder.configure(encoderConfig);
  } catch {
    try {
      videoEncoder.configure({
        ...encoderConfig,
        hardwareAcceleration: "no-preference",
      });
    } catch {
      videoEncoder.configure({
        ...encoderConfig,
        latencyMode: "realtime",
        hardwareAcceleration: "no-preference",
      });
    }
  }

  const sourceTrack = tabComposite?.tabTrack ?? videoTrack!;
  const videoProcessor = new MediaStreamTrackProcessor({ track: sourceTrack });
  const videoReader = videoProcessor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;

  let outputCanvas: HTMLCanvasElement | null = null;
  let outputCtx: CanvasRenderingContext2D | null = null;
  if (tabComposite) {
    outputCanvas = document.createElement("canvas");
    outputCanvas.width = outputWidth;
    outputCanvas.height = outputHeight;
    outputCtx = outputCanvas.getContext("2d", { alpha: false });
    if (!outputCtx) {
      throw new Error("recorder_no_canvas: 无法创建合成画布");
    }
  }

  let encoderClosed = false;
  let audioContext: AudioContext | null = null;
  let mediaDest: MediaStreamAudioDestinationNode | null = null;
  let elementSource: MediaElementAudioSourceNode | null = null;
  let audioEncoder: AudioEncoder | null = null;
  let audioReader: ReadableStreamDefaultReader<AudioData> | null = null;
  let audioProcessor: MediaStreamTrackProcessor | null = null;
  let audioStopped = false;
  let audioPumpPromise: Promise<void> = Promise.resolve();
  let audioChunkCount = 0;
  let connectedAudioEl: HTMLAudioElement | null = null;

  const startAudioPumpFor = (audioTrack: MediaStreamTrack) => {
    audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
    audioReader = audioProcessor.readable.getReader() as ReadableStreamDefaultReader<AudioData>;
    audioStopped = false;
    const pump = async () => {
      try {
        while (!audioStopped) {
          const { value: data, done } = await audioReader!.read();
          if (done) break;
          if (!data) continue;
          if (encoderClosed || !audioEncoder || audioEncoder.state === "closed") {
            data.close();
            break;
          }
          try {
            audioEncoder.encode(data);
          } catch (e) {
            if (e instanceof DOMException && e.name === "InvalidStateError") {
              data.close();
              break;
            }
            console.error("[recorder] audio encode failed:", e);
          } finally {
            data.close();
          }
        }
      } catch {
        // 静默
      }
    };
    audioPumpPromise = pump();
  };

  const stopCurrentAudioPump = async () => {
    audioStopped = true;
    if (audioReader) {
      try { await audioReader.cancel(); } catch { /* ignore */ }
      audioReader.releaseLock();
      audioReader = null;
    }
    if (audioProcessor) {
      try { await audioProcessor.readable.cancel(); } catch { /* ignore */ }
      audioProcessor = null;
    }
    if (audioPumpPromise) {
      try { await audioPumpPromise; } catch { /* ignore */ }
    }
  };

  const disconnectElementSource = () => {
    if (elementSource) {
      try { elementSource.disconnect(); } catch { /* ignore */ }
      elementSource = null;
    }
    connectedAudioEl = null;
  };

  if (withAudio) {
    audioContext = new AudioContext({ sampleRate: 48_000 });
    await audioContext.resume();

    mediaDest = audioContext.createMediaStreamDestination();
    const destTrack = mediaDest.stream.getAudioTracks()[0];
    if (!destTrack) {
      throw new Error("recorder_no_audio_track: MediaStreamDestination returned no audio track");
    }

    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => {
        audioChunkCount++;
        muxer.addAudioChunk(chunk, meta, chunk.timestamp);
      },
      error: (e) => {
        console.error("[recorder] AudioEncoder error:", e);
      },
    });
    audioEncoder.configure({
      codec: "mp4a.40.2",
      numberOfChannels: 2,
      sampleRate: 48_000,
      bitrate: 128_000,
    });

    startAudioPumpFor(destTrack);
  }

  const setAudioElement = (audioEl: HTMLAudioElement | null) => {
    if (!withAudio || !audioContext || !mediaDest) return;

    if (!audioEl) {
      disconnectElementSource();
      return;
    }

    if (connectedAudioEl === audioEl && elementSource) {
      void audioContext.resume();
      return;
    }

    disconnectElementSource();

    void audioContext.resume().then(() => {
      try {
        elementSource = audioContext!.createMediaElementSource(audioEl);
        elementSource.connect(mediaDest!);
        elementSource.connect(audioContext!.destination);
        connectedAudioEl = audioEl;
      } catch (e) {
        console.error("[recorder] createMediaElementSource failed:", e);
      }
    });
  };

  const keyframeIntervalFrames = frameRate;
  const frameDurationUs = Math.round(1_000_000 / frameRate);
  let videoStopped = false;
  let frameCount = 0;
  /** 保留 captureStream 原始时间戳，避免出帧抖动时被强行拉成固定 30fps 导致导出卡顿 */
  let recordingOriginTs: number | null = null;

  const videoPumpWithKeyframes = async () => {
    try {
      while (!videoStopped) {
        const { value: frame, done } = await videoReader.read();
        if (done) break;
        if (!frame) continue;
        if (encoderClosed || videoEncoder.state === "closed") {
          frame.close();
          break;
        }
        const isKeyFrame = frameCount % keyframeIntervalFrames === 0;
        const rawTs = frame.timestamp;
        if (recordingOriginTs === null) {
          recordingOriginTs = rawTs;
        }
        const normalizedTs = Math.max(0, rawTs - recordingOriginTs);
        const duration = frame.duration ?? frameDurationUs;

        let encodeFrame: VideoFrame;
        if (tabComposite && outputCanvas && outputCtx) {
          const rect = tabComposite.getCropRect();
          const { x, y, w, h } = mapDomRectToFrameRect(
            rect,
            frame.displayWidth,
            frame.displayHeight,
          );
          outputCtx.fillStyle = "#000";
          outputCtx.fillRect(0, 0, outputWidth, outputHeight);
          outputCtx.drawImage(frame, x, y, w, h, 0, 0, outputWidth, outputHeight);
          frame.close();
          encodeFrame = new VideoFrame(outputCanvas, { timestamp: normalizedTs, duration });
        } else {
          encodeFrame = new VideoFrame(frame, { timestamp: normalizedTs, duration });
          frame.close();
        }

        try {
          videoEncoder.encode(encodeFrame, { keyFrame: isKeyFrame });
        } catch (e) {
          if (e instanceof DOMException && e.name === "InvalidStateError") {
            encodeFrame.close();
            break;
          }
          console.error("[recorder] encode failed:", e);
        } finally {
          encodeFrame.close();
        }
        frameCount++;
      }
    } catch {
      // 静默
    }
  };
  const videoPumpPromise = videoPumpWithKeyframes();

  const finalizeStop = async () => {
    encoderClosed = true;
    videoStopped = true;
    audioStopped = true;

    try { sourceTrack.stop(); } catch { /* ignore */ }

    try { await videoReader.cancel(); } catch { /* ignore */ }
    videoReader.releaseLock();
    try { await videoProcessor.readable.cancel(); } catch { /* ignore */ }

    await videoPumpPromise;

    disconnectElementSource();
    await stopCurrentAudioPump();

    try { await videoEncoder.flush(); } catch { /* ignore */ }
    try { videoEncoder.close(); } catch { /* ignore */ }
    if (audioEncoder) {
      try { await audioEncoder.flush(); } catch { /* ignore */ }
      try { audioEncoder.close(); } catch { /* ignore */ }
    }
    if (audioContext) {
      try { await audioContext.close(); } catch { /* ignore */ }
    }

    onCleanup();
  };

  return {
    notifyFrameDrawn: () => {
      if (requestManualFrame) {
        try {
          requestManualFrame();
        } catch (e) {
          console.warn("[recorder] requestFrame failed:", e);
        }
      }
    },
    setAudioElement,
    stop: async () => {
      const startedAt = performance.now();
      await finalizeStop();

      if (videoChunkCount === 0) {
        throw new Error(
          "recorder_no_video_frames: 未捕获到任何视频帧，请确认预览正在播放后再试。",
        );
      }
      if (withAudio && audioChunkCount === 0) {
        console.warn("[recorder] no audio chunks encoded; output may be silent");
      }
      muxer.finalize();
      const target = muxer.target as ArrayBufferTarget;
      const blob = new Blob([target.buffer], { type: "video/mp4" });
      return { blob, durationMs: performance.now() - startedAt, width: outputWidth, height: outputHeight };
    },
    cancel: () => {
      void finalizeStop();
    },
  };
}

/** 图片轮播：canvas 逐帧绘制后 captureStream */
export async function startRecordingFromCanvas(
  canvas: HTMLCanvasElement,
  config: RecorderConfig = {},
): Promise<RecordingHandle> {
  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) {
    throw new Error(
      `recorder_invalid_canvas: canvas has no intrinsic size (${width}x${height})`,
    );
  }

  const videoStream = canvas.captureStream(0);
  const videoTrack = videoStream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("recorder_no_video_track: canvas.captureStream() returned no video track");
  }

  const canvasCaptureTrack = videoTrack as CanvasCaptureMediaStreamTrack;

  return buildRecordingHandle({
    videoTrack,
    width,
    height,
    config: {
      ...config,
      width,
      height,
      videoBitrate: config.videoBitrate ?? bitrateForExportSize(width, height),
    },
    requestManualFrame: () => canvasCaptureTrack.requestFrame(),
    onCleanup: () => {
      try { videoTrack.stop(); } catch { /* ignore */ }
    },
  });
}

/**
 * HTML 动画：getDisplayMedia 采当前标签页，按预览区 DOM 裁切，固定输出项目画幅。
 */
export async function startRecordingFromDisplayMedia(
  cropElement: HTMLElement,
  config: RecorderConfig = {},
): Promise<RecordingHandle> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("当前浏览器不支持标签页录制，请使用 Chrome 或 Edge 导出 HTML 视频。");
  }

  const targetW = config.width ?? 1920;
  const targetH = config.height ?? 1080;
  const targetAspect = targetW / targetH;

  const cropRect = cropElement.getBoundingClientRect();
  const cropW = Math.max(1, cropRect.width);
  const cropH = Math.max(1, cropRect.height);
  const cropAspect = cropW / cropH;
  if (Math.abs(cropAspect - targetAspect) > 0.05) {
    throw new Error(
      `预览区域比例 ${Math.round(cropW)}×${Math.round(cropH)} 与项目画幅 ${targetW}×${targetH} 不一致。`,
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser",
        frameRate: { ideal: config.frameRate ?? 30 },
      },
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: "include",
      surfaceSwitching: "exclude",
    } as DisplayMediaConstraints);
  } catch (e) {
    if (e instanceof DOMException && e.name === "NotAllowedError") {
      throw new Error("你取消了标签页共享。HTML 视频导出需要允许录制当前标签页。");
    }
    throw e;
  }

  const tabTrack = stream.getVideoTracks()[0];
  if (!tabTrack) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("未获取到视频轨，请重新尝试导出。");
  }

  if ("contentHint" in tabTrack) {
    try {
      (tabTrack as MediaStreamTrack & { contentHint: string }).contentHint = "detail";
    } catch {
      /* ignore */
    }
  }

  const videoBitrate =
    config.videoBitrate ?? bitrateForExportSize(targetW, targetH);

  return buildRecordingHandle({
    tabComposite: {
      tabTrack,
      getCropRect: () => cropElement.getBoundingClientRect(),
    },
    width: targetW,
    height: targetH,
    config: { ...config, width: targetW, height: targetH, videoBitrate },
    requestManualFrame: null,
    onCleanup: () => {
      stream.getTracks().forEach((t) => t.stop());
    },
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ensureVideoMetaColorSpace(
  meta: EncodedVideoChunkMetadata | undefined,
): EncodedVideoChunkMetadata {
  const DEFAULT_CS: VideoColorSpace = new VideoColorSpace({
    primaries: "bt709",
    transfer: "iec61966-2-1",
    matrix: "rgb",
    fullRange: true,
  });
  if (!meta) {
    return { decoderConfig: { codec: "avc1.640033", colorSpace: DEFAULT_CS } };
  }
  if (!meta.decoderConfig) {
    return {
      ...meta,
      decoderConfig: { codec: "avc1.640033", colorSpace: DEFAULT_CS },
    };
  }
  if (!meta.decoderConfig.colorSpace) {
    return {
      ...meta,
      decoderConfig: { ...meta.decoderConfig, colorSpace: DEFAULT_CS },
    };
  }
  return meta;
}

export function supportsDisplayMediaCrop(): boolean {
  return (
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getDisplayMedia)
  );
}
