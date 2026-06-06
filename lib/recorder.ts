/**
 * WebCodecs + mp4-muxer 录屏引擎。
 *
 * 用途：
 *  - 把预览画布（<canvas>）实时编码成 H.264 MP4 文件
 *  - 不依赖 ffmpeg.wasm / getDisplayMedia，纯 JS，零依赖、零系统弹窗
 *  - 音轨：调用方用 setAudioElement(<audio>) 切换当前正在播放的音频元素
 *
 * 链路：
 *   <canvas>（由调用方逐帧 draw）
 *     → canvas.captureStream(30)
 *     → MediaStreamTrack (video)
 *     → MediaStreamTrackProcessor.readable
 *     → VideoFrame
 *     → VideoEncoder (H.264 / avc, level 5.1 支持到 4K)
 *     → EncodedVideoChunk
 *     → Muxer.addVideoChunk()
 *     → ArrayBufferTarget.buffer
 *     → Blob (video/mp4) → 下载
 *
 * 音频轨（如果有）：
 *   HTMLAudioElement.captureStream()
 *     → AudioEncoder (AAC)
 *     → Muxer.addAudioChunk()
 *
 * 设计取舍：
 *  - 画布分辨率由调用方控制（默认 1920x1080），所以不会触发"AVC level 4.0
 *    不支持 4K"那种坑；encoder codec 仍写 high@5.1 留余量。
 *  - 帧率固定 30fps（业务上"录视频"够用，编码开销小）。
 *  - 不做码率自适应：固定 5Mbps，1~2 分钟视频体量可控。
 *  - 切换音轨用 MediaStream.addTrack / removeTrack，调用方在每个分镜
 *    playAudio 时调一次 setAudioElement(newAudioEl) 即可。
 */

import { Muxer, ArrayBufferTarget } from "mp4-muxer";

/** 录屏引擎配置 */
export interface RecorderConfig {
  /** 录制目标帧率（fps）。默认 30。 */
  frameRate?: number;
  /** 视频目标码率（bps）。默认 5_000_000。 */
  videoBitrate?: number;
  /** 是否录制音频轨。默认 true。 */
  withAudio?: boolean;
}

/** 录屏引擎的对外句柄。 */
export interface RecordingHandle {
  /** 停止采集并 finalize。返回 MP4 Blob 和耗时。 */
  stop(): Promise<{ blob: Blob; durationMs: number }>;
  /** 仅停止采集（不 finalize），用于出错时回滚。 */
  cancel(): void;
  /**
   * 切换音轨源。Preview 在每个分镜的 playAudio 里调一次。
   * 传 null 表示当前无音轨（分镜间过渡、HTML 模式未生成音频等）。
   */
  setAudioElement(audioEl: HTMLAudioElement | null): void;
  /**
   * 通知 recorder：canvas 刚画完一帧。
   * 配合 captureStream(0) 手动 requestFrame，保证隐藏 canvas 也能稳定出帧。
   */
  notifyFrameDrawn(): void;
}

/**
 * 从一个 <canvas> 元素开始录制。canvas 由调用方逐帧 draw，
 * 我们从 canvas.captureStream() 拿视频轨；音轨由 setAudioElement 注入。
 */
export async function startRecordingFromCanvas(
  canvas: HTMLCanvasElement,
  config: RecorderConfig = {},
): Promise<RecordingHandle> {
  const frameRate = config.frameRate ?? 30;
  const videoBitrate = config.videoBitrate ?? 5_000_000;
  const withAudio = config.withAudio !== false;

  const width = canvas.width;
  const height = canvas.height;
  if (!width || !height) {
    throw new Error(
      `recorder_invalid_canvas: canvas has no intrinsic size (${width}x${height}); ` +
        `set width/height attributes on the <canvas> before recording.`,
    );
  }

  // ---- 1. muxer ----
  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    fastStart: "in-memory",
    video: { codec: "avc", width, height, frameRate },
    audio: withAudio ? { codec: "aac", numberOfChannels: 2, sampleRate: 48_000 } : undefined,
    firstTimestampBehavior: "offset",
  });

  // 包装 addVideoChunk，保证每帧 meta 都带 colorSpace，并统计已编码帧数。
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

  // ---- 2. video encoder ----
  // H.264 High profile, level 5.1：覆盖到 4K（4096x2304）
  //
  // 关于 colorSpace：
  //   mp4-muxer 在 finalize() 阶段读 track.info.decoderConfig.colorSpace，
  //   如果 addVideoChunk 从未拿到带 decoderConfig 的 meta，decoderConfig
  //   始终是 null，访问 .colorSpace 就抛 "Cannot read properties of null"。
  //   修复：1) 在 VideoEncoder 配置里显式给 colorSpace=srgb（让首帧 meta
  //   带上完整的 decoderConfig）；2) output 回调里再兜一次：万一首帧 meta
  //   没有 decoderConfig 或没有 colorSpace，就手动注入。
  const VIDEO_COLOR_SPACE: VideoColorSpace = new VideoColorSpace({
    primaries: "bt709",
    transfer: "iec61966-2-1", // sRGB
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
  videoEncoder.configure({
    codec: "avc1.640033", // High@5.1
    width,
    height,
    bitrate: videoBitrate,
    framerate: frameRate,
    latencyMode: "realtime",
    colorSpace: VIDEO_COLOR_SPACE,
  });

  // ---- 3. canvas -> video track -> video frame pump ----
  // 用手动 requestFrame 模式（frameRate=0），由 Preview 每画完一帧调 notifyFrameDrawn。
  // 隐藏/offscreen canvas 在自动 capture 模式下可能不出帧，导致 muxer decoderConfig 为空。
  const videoStream = canvas.captureStream(0);
  const videoTrack = videoStream.getVideoTracks()[0];
  if (!videoTrack) {
    throw new Error("recorder_no_video_track: canvas.captureStream() returned no video track");
  }
  const canvasCaptureTrack = videoTrack as CanvasCaptureMediaStreamTrack;
  const videoProcessor = new MediaStreamTrackProcessor({ track: videoTrack });
  // 已知是 video track，readable 实际产 VideoFrame
  const videoReader = videoProcessor.readable.getReader() as ReadableStreamDefaultReader<VideoFrame>;

  // ---- 4. 音轨：Web Audio API 混流到单一 MediaStream，比 HTMLMediaElement.captureStream 更稳定 ----
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
  /** 已 createMediaElementSource 绑定的元素（同一元素不可重复绑定） */
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

    // 整片 mp3 连续播放时会多次回调同一 <audio>，不可重复 createMediaElementSource
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

  // ---- 5. 视频 pump（固定 CFR 时间戳，避免 requestFrame 不均匀导致播放卡顿） ----
  const keyframeIntervalFrames = frameRate * 2;
  const frameDurationUs = Math.round(1_000_000 / frameRate);
  let videoStopped = false;
  let frameCount = 0;

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
        const fixedTs = frameCount * frameDurationUs;
        const fixedFrame = new VideoFrame(frame, {
          timestamp: fixedTs,
          duration: frameDurationUs,
        });
        frame.close();
        try {
          videoEncoder.encode(fixedFrame, { keyFrame: isKeyFrame });
        } catch (e) {
          if (e instanceof DOMException && e.name === "InvalidStateError") {
            fixedFrame.close();
            break;
          }
          console.error("[recorder] encode failed:", e);
        } finally {
          fixedFrame.close();
        }
        frameCount++;
      }
    } catch {
      // 静默
    }
  };
  const videoPumpPromise = videoPumpWithKeyframes();

  // ---- 6. handle ----
  return {
    notifyFrameDrawn: () => {
      try {
        canvasCaptureTrack.requestFrame();
      } catch (e) {
        console.warn("[recorder] requestFrame failed:", e);
      }
    },
    setAudioElement,
    stop: async () => {
      const startedAt = performance.now();

      encoderClosed = true;
      videoStopped = true;
      audioStopped = true;

      try { videoTrack.stop(); } catch { /* ignore */ }

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

      if (videoChunkCount === 0) {
        throw new Error(
          "recorder_no_video_frames: 未捕获到任何视频帧，请确认录制画布正在渲染后再试。",
        );
      }
      if (withAudio && audioChunkCount === 0) {
        console.warn("[recorder] no audio chunks encoded; output may be silent");
      }
      muxer.finalize();
      const target = muxer.target as ArrayBufferTarget;
      const blob = new Blob([target.buffer], { type: "video/mp4" });
      return { blob, durationMs: performance.now() - startedAt };
    },
    cancel: () => {
      encoderClosed = true;
      videoStopped = true;
      audioStopped = true;
      disconnectElementSource();
      try { videoTrack.stop(); } catch { /* ignore */ }
      try { videoReader.cancel(); } catch { /* ignore */ }
      videoReader.releaseLock();
      try { videoEncoder.close(); } catch { /* ignore */ }
      try { audioEncoder?.close(); } catch { /* ignore */ }
      try { void audioContext?.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * 触发浏览器下载一个 Blob 为文件。
 */
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

/**
 * 兜底：保证传给 mp4-muxer 的 meta.decoderConfig 一定有 colorSpace。
 *
 * 为什么需要：mp4-muxer 在 finalize 走 videoSampleDescription 时会读
 * `track.info.decoderConfig.colorSpace`。如果首帧 addVideoChunk 的 meta
 * 缺失 decoderConfig（或 decoderConfig 没 colorSpace），muxer 会炸出
 * "Cannot read properties of null (reading 'colorSpace')"。
 *
 * 这里只补缺失的部分，不破坏 encoder 自带的 description（SPS/PPS）。
 */
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
