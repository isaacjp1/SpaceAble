import { readFileSync } from "node:fs";
import path from "node:path";
import { parseImageStream, type ResponsesEvent } from "@meta-sam/parser";
import { describe, expect, it } from "vitest";
import { imageInfo, normalize } from "@/lib/sam";

// Official example output from the @meta-sam/parser README (protocol text only).
const README_OUTPUT = readFileSync(path.join(import.meta.dirname, "fixtures/sam-readme-output.txt"), "utf8");
const lane = { item_id: "message-1", output_index: 0, content_index: 0 };

async function* events(text: string, completed = true): AsyncIterable<ResponsesEvent> {
  if (text) yield { type: "response.output_text.delta", ...lane, delta: text };
  yield { type: "response.output_text.done", ...lane, text };
  if (completed) yield { type: "response.completed" };
}

describe("SAM normalization (official parser)", () => {
  it("turns the documented output into boxes and masks", async () => {
    const r = normalize(await parseImageStream(events(README_OUTPUT)).finalResult, "button");
    expect(r.complete).toBe(true);
    expect(r.dropped_records).toBe(0);
    expect(r.detections.map((d) => d.box_px)).toEqual([[211, 228, 271, 255], [155, 228, 203, 255]]);
    const mask = r.detections[0].mask!;
    expect(mask.path.startsWith("M")).toBe(true);
    expect([mask.x, mask.y, mask.sx, mask.sy]).toEqual([211, 228, 1, 1]);
  });

  it("reports zero matches as a completed, empty result", async () => {
    const r = normalize(await parseImageStream(events("")).finalResult, "piano");
    expect(r).toEqual({ concept: "piano", detections: [], complete: true, dropped_records: 0 });
  });

  it("flags a stream that ended without completion", async () => {
    const r = normalize(await parseImageStream(events(README_OUTPUT, false)).finalResult, "button");
    expect(r.complete).toBe(false);
  });
});

describe("imageInfo", () => {
  it("reads JPEG dimensions from the header", () => {
    const jpg = readFileSync(path.join(import.meta.dirname, "../public/samples/hostel-twin-room.jpg"));
    expect(imageInfo(new Uint8Array(jpg))).toEqual({ mime: "image/jpeg", width: 1280, height: 960 });
  });

  it("reads PNG dimensions and rejects other bytes", () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    expect(imageInfo(png)).toEqual({ mime: "image/png", width: 640, height: 480 });
    expect(imageInfo(new TextEncoder().encode("GIF89a not a photo"))).toBeNull();
  });
});
