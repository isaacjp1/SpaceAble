// WAV helpers for Muse Voice Transcribe, which accepts only RIFF/WAVE, mono 16-bit PCM at 16 or
// 24 kHz. Pure except recordingToWav, which needs the browser's Web Audio API.

export const VOICE_RATE = 16_000;
export const VOICE_RATES = [16_000, 24_000];
export const MAX_VOICE_SECONDS = 60;
/** 60 s of 24 kHz audio plus the header and some room for extra chunks. */
export const MAX_VOICE_BYTES = 44 + 2 * 24_000 * MAX_VOICE_SECONDS + 1024;

/** Mono 16-bit PCM WAV with the standard 44-byte header; samples are clamped to [-1, 1]. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  tag(36, "data");
  v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return out;
}

export interface WavInfo { format: number; channels: number; rate: number; bits: number; seconds: number }

/** Format and length from the file's own chunks (never the client-declared type), or null. */
export function wavInfo(buf: Uint8Array): WavInfo | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number) => String.fromCharCode(...buf.subarray(at, at + 4));
  if (buf.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let fmt: Omit<WavInfo, "seconds"> | null = null;
  for (let i = 12; i + 8 <= buf.length;) {
    const id = tag(i);
    const size = v.getUint32(i + 4, true);
    if (id === "fmt " && size >= 16 && i + 24 <= buf.length) {
      fmt = { format: v.getUint16(i + 8, true), channels: v.getUint16(i + 10, true),
        rate: v.getUint32(i + 12, true), bits: v.getUint16(i + 22, true) };
    }
    if (id === "data") {
      if (!fmt || !fmt.rate || !fmt.channels || !fmt.bits) return null;
      const bytes = Math.min(size, buf.length - i - 8);
      return { ...fmt, seconds: bytes / (fmt.rate * fmt.channels * (fmt.bits / 8)) };
    }
    i += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}

/** Browser only: decode a MediaRecorder recording and resample it to 16 kHz mono WAV,
 * cut at MAX_VOICE_SECONDS. */
export async function recordingToWav(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const decoded = await new OfflineAudioContext(1, 1, 44_100).decodeAudioData(await blob.arrayBuffer());
  const length = Math.max(1, Math.min(Math.ceil(decoded.duration * VOICE_RATE), MAX_VOICE_SECONDS * VOICE_RATE));
  const ctx = new OfflineAudioContext(1, length, VOICE_RATE); // renders mono: mixes down and resamples
  const source = ctx.createBufferSource();
  source.buffer = decoded;
  source.connect(ctx.destination);
  source.start();
  return encodeWav((await ctx.startRendering()).getChannelData(0), VOICE_RATE);
}
