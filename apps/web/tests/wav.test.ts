import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import { encodeWav, wavInfo } from "@/lib/wav";

const tone = (seconds: number, rate = 16_000) =>
  Float32Array.from({ length: seconds * rate }, (_, i) => Math.sin(i / 10));

describe("WAV", () => {
  it("writes a mono 16-bit PCM header that the server accepts", () => {
    const wav = encodeWav(tone(1), 16_000);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe("WAVEfmt ");
    expect(wav.length).toBe(44 + 2 * 16_000);
    expect(wavInfo(wav)).toEqual({ format: 1, channels: 1, rate: 16_000, bits: 16, seconds: 1 });
  });

  it("clamps samples outside [-1, 1]", () => {
    const v = new DataView(encodeWav(Float32Array.of(2, -2, 0.5), 16_000).buffer);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([32767, -32767, 16383]);
  });

  it("finds the data chunk after extra chunks and rejects non-WAV bytes", () => {
    const plain = encodeWav(tone(1, 24_000), 24_000);
    const list = new Uint8Array([..."LIST"].map((c) => c.charCodeAt(0)).concat([4, 0, 0, 0, 1, 2, 3, 4]));
    const withList = new Uint8Array([...plain.subarray(0, 36), ...list, ...plain.subarray(36)]);
    expect(wavInfo(withList)).toMatchObject({ rate: 24_000, seconds: 1 });
    expect(wavInfo(new TextEncoder().encode("OggS not a wav file"))).toBeNull();
    expect(wavInfo(plain.subarray(0, 20))).toBeNull(); // truncated before the data chunk
  });
});

describe("headers", () => {
  it("lets this site, and only this site, use the microphone", async () => {
    const rules = await nextConfig.headers!();
    const policy = rules[0].headers.find((h) => h.key === "Permissions-Policy")?.value;
    expect(policy).toContain("microphone=(self)");
    expect(policy).toContain("camera=()");
  });
});
