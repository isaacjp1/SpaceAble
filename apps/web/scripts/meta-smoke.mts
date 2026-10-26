// Live smoke test for the two Meta capabilities. Makes real, billed API calls.
//   npm run smoke:meta -- [path/to/consented-room-photo.jpg] [concept]
// Reads MODEL_API_KEY from apps/web/.env.local. Prints what the API actually returned.
import { readFileSync } from "node:fs";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import OpenAI from "openai";

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error("META_NOT_CONFIGURED: set MODEL_API_KEY in apps/web/.env.local (see .env.example).");
  process.exit(2);
}
const client = new OpenAI({ baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1", apiKey: key });

// 1. Muse Spark: schema-constrained output (Chat Completions + response_format json_schema)
const muse = await client.chat.completions.create({
  model: process.env.META_MUSE_MODEL ?? "muse-spark-1.3",
  messages: [{
    role: "user",
    content: "Objects: bed, desk, dresser. Destinations: desk-approach, bed-approach. " +
      "Request: keep my bed where it is and make the route to my desk clearer. " +
      "Return constraints. Use null for any dimension the user did not state.",
  }],
  response_format: {
    type: "json_schema",
    json_schema: {
      name: "constraints",
      schema: {
        type: "object",
        properties: {
          locked_object_ids: { type: "array", items: { type: "string", enum: ["bed", "desk", "dresser"] } },
          required_destination_ids: { type: "array", items: { type: "string", enum: ["desk-approach", "bed-approach"] } },
          route_width_cm: { type: ["number", "null"] },
        },
        required: ["locked_object_ids", "required_destination_ids", "route_width_cm"],
        additionalProperties: false,
      },
    },
  },
});
const content = muse.choices[0]?.message.content ?? "";
console.log("Muse model:", muse.model, "| usage:", JSON.stringify(muse.usage));
console.log("Muse content:", content);
console.log("Muse parsed:", JSON.parse(content));

// 2. SAM 3.1: one concept, local image sent as a base64 data URL (never published)
const [imagePath, concept = "bed"] = process.argv.slice(2);
if (!imagePath) {
  console.log("SAM: skipped (pass a consented image path to test segmentation).");
  process.exit(0);
}
const mime = /\.png$/i.test(imagePath) ? "image/png" : "image/jpeg";
const imageUrl = `data:${mime};base64,${readFileSync(imagePath).toString("base64")}`;
const stream = await client.responses.create({
  model: process.env.META_SAM_MODEL ?? "sam-3.1",
  stream: true,
  metadata: { mask_encoding: "one_bit" },
  input: [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: concept },
      { type: "input_image", image_url: imageUrl, detail: "auto" },
    ],
  }],
});
const result = await parseImageStream(stream).finalResult;
console.log("SAM outcome:", result.outcome, "| diagnostics:", result.diagnostics.length);
const boxes = recordsOfKind(result.records, "box");
console.log(`SAM "${concept}": ${boxes.length} match(es)`);
for (const b of boxes) console.log("  box", b.objectId, b.left, b.top, b.right, b.bottom, b.confidence ?? "");
for (const m of recordsOfKind(result.records, "mask")) {
  const raster = decodeMaskToRaster(m.mask);
  console.log("  mask", m.objectId, `${m.mask.width}x${m.mask.height}`, "on-pixels:", raster.reduce((a, v) => a + v, 0));
}
