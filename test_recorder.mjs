import { Muxer, ArrayBufferTarget } from "mp4-muxer";

const m = new Muxer({
  target: new ArrayBufferTarget(),
  fastStart: "in-memory",
  video: { codec: "avc", width: 1280, height: 720, frameRate: 30 },
  audio: { codec: "aac", numberOfChannels: 2, sampleRate: 48000 },
  firstTimestampBehavior: "offset",
});
m.finalize();
console.log("Muxer smoke test OK, output buffer size:", m.target.buffer.byteLength);
