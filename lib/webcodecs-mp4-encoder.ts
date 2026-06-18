import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export interface RecordStreamToMP4Options {
  frameRate?: number;
  bitrate?: number;
  maxWidth?: number;
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
  onTimeUpdate?: (elapsedSec: number, remainingSec: number) => void;
}

function selectCodec(width: number, height: number) {
  const pixels = width * height;
  if (pixels <= 2_211_840) return "avc1.64002a";
  if (pixels <= 5_652_480) return "avc1.640032";
  return "avc1.640033";
}

function normalizeSize(width: number, height: number, maxWidth: number) {
  if (width <= maxWidth) {
    return {
      width: width % 2 === 0 ? width : width - 1,
      height: height % 2 === 0 ? height : height - 1,
      scale: 1,
    };
  }
  const scale = maxWidth / width;
  const scaledHeight = Math.round(height * scale);
  const nextWidth = maxWidth % 2 === 0 ? maxWidth : maxWidth - 1;
  const nextHeight = scaledHeight % 2 === 0 ? scaledHeight : scaledHeight - 1;
  return { width: nextWidth, height: nextHeight, scale };
}

export function isWebCodecsMP4Supported() {
  if (typeof window === "undefined") return false;
  return "VideoEncoder" in window && "MediaStreamTrackProcessor" in window;
}

class WebCodecsMP4Encoder {
  private muxer: Muxer<ArrayBufferTarget> | null = null;
  private encoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private frameCount = 0;
  private pendingFrames = 0;
  private pendingAudioFrames = 0;
  private finished = false;
  private scaleCanvas: OffscreenCanvas | null = null;
  private scaleCtx: OffscreenCanvasRenderingContext2D | null = null;
  private outputWidth = 0;
  private outputHeight = 0;
  private readonly options: Required<Pick<RecordStreamToMP4Options, "frameRate" | "bitrate" | "maxWidth">>;

  constructor(options: RecordStreamToMP4Options) {
    this.options = {
      frameRate: options.frameRate ?? 30,
      bitrate: options.bitrate ?? 8_000_000,
      maxWidth: options.maxWidth ?? 1920,
    };
  }

  async start(
    width: number,
    height: number,
    audioConfig?: { sampleRate: number; numberOfChannels: number },
  ) {
    const normalized = normalizeSize(width, height, this.options.maxWidth);
    this.outputWidth = normalized.width;
    this.outputHeight = normalized.height;

    if (normalized.scale < 1) {
      this.scaleCanvas = new OffscreenCanvas(this.outputWidth, this.outputHeight);
      this.scaleCtx = this.scaleCanvas.getContext("2d");
    }

    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: "avc",
        width: this.outputWidth,
        height: this.outputHeight,
      },
      ...(audioConfig
        ? {
            audio: {
              codec: "aac",
              sampleRate: audioConfig.sampleRate,
              numberOfChannels: audioConfig.numberOfChannels,
            },
          }
        : {}),
      fastStart: "in-memory",
      firstTimestampBehavior: "offset",
    });

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (this.muxer && !this.finished) {
          this.muxer.addVideoChunk(chunk, meta ?? undefined);
        }
        this.pendingFrames--;
      },
      error: (error) => {
        console.error("[WebCodecsMP4Encoder] encoder error", error);
      },
    });

    const config: VideoEncoderConfig = {
      codec: selectCodec(this.outputWidth, this.outputHeight),
      width: this.outputWidth,
      height: this.outputHeight,
      bitrate: this.options.bitrate,
      framerate: this.options.frameRate,
      latencyMode: "quality",
      avc: { format: "avc" },
    };

    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) {
      throw new Error("当前浏览器不支持 MP4(H.264) 导出。");
    }

    this.encoder.configure(config);

    if (audioConfig && "AudioEncoder" in window) {
      this.audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (this.muxer && !this.finished) {
            this.muxer.addAudioChunk(chunk, meta ?? undefined);
          }
          this.pendingAudioFrames--;
        },
        error: (error) => {
          console.error("[WebCodecsMP4Encoder] audio encoder error", error);
        },
      });
      this.audioEncoder.configure({
        codec: "mp4a.40.2",
        sampleRate: audioConfig.sampleRate,
        numberOfChannels: audioConfig.numberOfChannels,
        bitrate: 128_000,
      });
    }
  }

  encodeFrame(frame: VideoFrame) {
    if (!this.encoder || this.finished || this.encoder.state === "closed") {
      frame.close();
      return;
    }

    let nextFrame: VideoFrame | null = null;

    try {
      let frameToEncode = frame;
      if (this.scaleCanvas && this.scaleCtx) {
        this.scaleCtx.drawImage(
          frame as unknown as CanvasImageSource,
          0,
          0,
          this.outputWidth,
          this.outputHeight,
        );
        nextFrame = new VideoFrame(this.scaleCanvas, { timestamp: frame.timestamp });
        frameToEncode = nextFrame;
      }

      const keyFrame = this.frameCount % (this.options.frameRate * 2) === 0;
      this.pendingFrames++;
      this.encoder.encode(frameToEncode, { keyFrame });
      this.frameCount++;
    } finally {
      frame.close();
      nextFrame?.close();
    }
  }

  encodeAudioFrame(frame: AudioData) {
    if (!this.audioEncoder || this.finished || this.audioEncoder.state === "closed") {
      frame.close();
      return;
    }

    try {
      this.pendingAudioFrames++;
      this.audioEncoder.encode(frame);
    } finally {
      frame.close();
    }
  }

  async finish() {
    if (!this.encoder || !this.muxer) {
      throw new Error("MP4 编码器未启动。");
    }

    try {
      if (this.encoder.state !== "closed") {
        await this.encoder.flush();
      }

      let waits = 0;
      while (this.pendingFrames > 0 && waits < 100) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        waits++;
      }

      if (this.audioEncoder && this.audioEncoder.state !== "closed") {
        await this.audioEncoder.flush();
      }

      let audioWaits = 0;
      while (this.pendingAudioFrames > 0 && audioWaits < 100) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        audioWaits++;
      }

      this.finished = true;
      this.muxer.finalize();
      return new Blob([this.muxer.target.buffer], { type: "video/mp4" });
    } finally {
      this.cancel();
    }
  }

  cancel() {
    this.finished = true;
    try {
      if (this.encoder && this.encoder.state !== "closed") {
        this.encoder.close();
      }
    } catch {
      /* ignore */
    }
    try {
      if (this.audioEncoder && this.audioEncoder.state !== "closed") {
        this.audioEncoder.close();
      }
    } catch {
      /* ignore */
    }
    this.encoder = null;
    this.audioEncoder = null;
    this.muxer = null;
    this.scaleCanvas = null;
    this.scaleCtx = null;
  }
}

export async function recordStreamToMP4(
  stream: MediaStream,
  durationSec: number,
  options: RecordStreamToMP4Options = {},
) {
  if (!isWebCodecsMP4Supported()) {
    throw new Error("当前浏览器不支持 MP4 导出，请使用最新版 Chrome。");
  }

  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack) {
    throw new Error("录屏流中没有视频轨道。");
  }

  const settings = videoTrack.getSettings();
  const width = settings.width || 1920;
  const height = settings.height || 1080;
  const frameRate = options.frameRate ?? settings.frameRate ?? 30;
  const encoder = new WebCodecsMP4Encoder({
    frameRate,
    bitrate: options.bitrate,
    maxWidth: options.maxWidth,
  });

  const audioSettings = audioTrack?.getSettings();
  const canEncodeAudio =
    Boolean(audioTrack) && "AudioEncoder" in window && "MediaStreamTrackProcessor" in window;

  await encoder.start(
    width,
    height,
    canEncodeAudio
      ? {
          sampleRate:
            Number(audioSettings?.sampleRate) > 0 ? Number(audioSettings?.sampleRate) : 48_000,
          numberOfChannels:
            Number(audioSettings?.channelCount) > 0 ? Number(audioSettings?.channelCount) : 2,
        }
      : undefined,
  );

  const TrackProcessor = (
    window as unknown as {
      MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
        readable: ReadableStream<VideoFrame>;
      };
    }
  ).MediaStreamTrackProcessor;
  const AudioTrackProcessor = (
    window as unknown as {
      MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => {
        readable: ReadableStream<AudioData>;
      };
    }
  ).MediaStreamTrackProcessor;

  const processor = new TrackProcessor({ track: videoTrack });
  const reader = processor.readable.getReader();
  const audioProcessor =
    canEncodeAudio && audioTrack ? new AudioTrackProcessor({ track: audioTrack }) : null;
  const audioReader = audioProcessor ? audioProcessor.readable.getReader() : null;
  const startedAt = performance.now();
  const totalMs = durationSec * 1000;
  let lastTick = 0;

  try {
    let stopped = false;
    const shouldStop = (elapsedMs: number) => {
      if (stopped) return true;
      if (options.signal?.aborted) {
        stopped = true;
        throw new DOMException("Export aborted", "AbortError");
      }
      if (elapsedMs >= totalMs) {
        stopped = true;
        return true;
      }
      return false;
    };

    const videoLoop = async () => {
      while (!stopped) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;

        const elapsedMs = performance.now() - startedAt;
        if (shouldStop(elapsedMs)) {
          frame.close();
          break;
        }

        encoder.encodeFrame(frame);

        if (elapsedMs - lastTick >= 100) {
          lastTick = elapsedMs;
          const progress = Math.min(99, Math.round((elapsedMs / totalMs) * 100));
          options.onProgress?.(progress);
          options.onTimeUpdate?.(elapsedMs / 1000, Math.max(0, (totalMs - elapsedMs) / 1000));
        }
      }
    };

    const audioLoop = async () => {
      if (!audioReader) return;
      while (!stopped) {
        const { value: frame, done } = await audioReader.read();
        if (done || !frame) break;

        const elapsedMs = performance.now() - startedAt;
        if (shouldStop(elapsedMs)) {
          frame.close();
          break;
        }

        encoder.encodeAudioFrame(frame);
      }
    };

    await Promise.all([videoLoop(), audioLoop()]);

    const blob = await encoder.finish();
    options.onProgress?.(100);
    options.onTimeUpdate?.(durationSec, 0);
    return blob;
  } catch (error) {
    encoder.cancel();
    throw error;
  } finally {
    reader.releaseLock();
    audioReader?.releaseLock();
  }
}
