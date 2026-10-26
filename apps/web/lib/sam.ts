// Server-only: SAM 3.1 segmentation via Meta's official parser, normalized for the UI.
import {
  decodeMaskToSVGPath, parseImageStream, recordsOfKind, type ImageSegmentationResult,
} from "@meta-sam/parser";
import type OpenAI from "openai";
import { META } from "./meta";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 4096;
export const CONCEPT = /^[a-z][a-z -]{0,39}$/i; // short noun phrase, one per SAM request
const MAX_MASK_PATH_CHARS = 200_000;

/** Type and size from the file's own header bytes (never the client-declared MIME). */
export function imageInfo(buf: Uint8Array): { mime: "image/png" | "image/jpeg"; width: number; height: number } | null {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf.length >= 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(4) === 0x0d0a1a0a) {
    return { mime: "image/png", width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    for (let i = 2; i + 9 < buf.length;) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xff) { i++; continue; } // fill byte
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { mime: "image/jpeg", height: v.getUint16(i + 5), width: v.getUint16(i + 7) };
      }
      i += 2 + v.getUint16(i + 2);
    }
  }
  return null;
}

export interface Detection {
  id: string;
  label: string;
  box_px: [number, number, number, number]; // left, top, right, bottom (half-open) in image pixels
  confidence: number | null;
  mask: { path: string; x: number; y: number; sx: number; sy: number } | null; // path in raster units
}

export interface ConceptResult {
  concept: string;
  detections: Detection[];
  complete: boolean; // false: the stream ended early, results may be partial
  dropped_records: number; // malformed lines the parser had to skip
}

export function normalize(result: ImageSegmentationResult, concept: string): ConceptResult {
  const masks = new Map(recordsOfKind(result.records, "mask").map((m) => [m.objectId, m]));
  const detections = recordsOfKind(result.records, "box").map((b): Detection => {
    const m = masks.get(b.objectId);
    const path = m ? decodeMaskToSVGPath(m.mask) : "";
    return {
      id: `${concept}-${b.objectId}`,
      label: concept,
      box_px: [b.left, b.top, b.right, b.bottom],
      confidence: b.confidence ?? null,
      mask: m && path && path.length <= MAX_MASK_PATH_CHARS ? {
        path, x: m.bounds.left, y: m.bounds.top,
        sx: (m.bounds.right - m.bounds.left) / m.mask.width,
        sy: (m.bounds.bottom - m.bounds.top) / m.mask.height,
      } : null,
    };
  });
  return {
    concept,
    detections,
    complete: result.outcome.status === "completed",
    dropped_records: result.diagnostics.filter((d) => d.severity === "error").length,
  };
}

export async function segment(client: OpenAI, imageDataUrl: string, concept: string, signal: AbortSignal) {
  const stream = await client.responses.create({
    model: META.sam,
    stream: true,
    metadata: { mask_encoding: "one_bit", include_confidence: "true" },
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: concept },
        { type: "input_image", image_url: imageDataUrl, detail: "auto" },
      ],
    }],
  }, { signal });
  return normalize(await parseImageStream(stream).finalResult, concept);
}
