// Live smoke test for the Meta capabilities. Makes real, billed API calls.
//   npm run smoke:meta -- [path/to/consented-room-photo.jpg] [concept] [path/to/speech.wav]
// Reads MODEL_API_KEY from apps/web/.env.local. Prints what the API actually returned.
import { readFileSync } from "node:fs";
import { decodeMaskToRaster, parseImageStream, recordsOfKind } from "@meta-sam/parser";
import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";

const key = process.env.MODEL_API_KEY;
if (!key) {
  console.error("META_NOT_CONFIGURED: set MODEL_API_KEY in apps/web/.env.local (see .env.example).");
  process.exit(2);
}
const baseURL = process.env.META_BASE_URL ?? "https://api.meta.ai/v1";
const client = new OpenAI({ baseURL, apiKey: key });
const args = process.argv.slice(2);
const wavPath = args.find((a) => /\.wav$/i.test(a));
const [imagePath, concept = "bed"] = args.filter((a) => a !== wavPath);

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

// 2. Muse Spark tool calling: one round of (possibly parallel) calls with canned results, then
// the answer. The full assistant message (including tool_calls) goes back into the history.
const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_layout",
      description: "Check the current layout against a route width. Returns pass/fail evidence.",
      parameters: {
        type: "object", properties: { route_width_cm: { type: "number" } },
        required: ["route_width_cm"], additionalProperties: false,
      },
      strict: true,
    },
  },
  {
    type: "function",
    function: {
      name: "find_layouts",
      description: "Search for verified rearrangements that keep the listed pieces in place.",
      parameters: {
        type: "object",
        properties: { locked_object_ids: { type: "array", items: { type: "string", enum: ["bed", "desk", "dresser"] } } },
        required: ["locked_object_ids"], additionalProperties: false,
      },
      strict: true,
    },
  },
];
const messages: ChatCompletionMessageParam[] = [
  { role: "system", content: "You answer questions about a room using only the tool results. Quote numbers exactly." },
  { role: "user", content: "I need a 91 cm route to my desk and the bed must stay put. Does my room work as it is, and if not, what could I move?" },
];
const toolResult = (name: string) => JSON.stringify(name === "check_layout"
  ? { status: "fail", checks: [{ id: "route-door-1-to-desk-approach", status: "fail", required_cm: 91 }] }
  : { status: "solutions_found", alternatives: [{ moves: [{ label: "Dresser", distance_cm: 35 }], widest_route_cm: 104 }] });
let t0 = Date.now();
const turn1 = await client.chat.completions.create({
  model: process.env.META_MUSE_MODEL ?? "muse-spark-1.3", messages, tools,
  reasoning_effort: "low", max_completion_tokens: 4000,
});
const m1 = turn1.choices[0].message;
const calls = (m1.tool_calls ?? []).flatMap((c) => c.type === "function" ? [c] : []);
console.log(`Tools turn 1: ${Date.now() - t0} ms | finish: ${turn1.choices[0].finish_reason} | message keys: ${Object.keys(m1)}`);
for (const c of calls) console.log(`  call ${c.function.name}(${c.function.arguments})`);
messages.push(m1, ...calls.map((c) => ({ role: "tool" as const, tool_call_id: c.id, content: toolResult(c.function.name) })));
t0 = Date.now();
const turn2 = await client.chat.completions.create({
  model: process.env.META_MUSE_MODEL ?? "muse-spark-1.3", messages, tools,
  reasoning_effort: "low", max_completion_tokens: 4000,
});
console.log(`Tools turn 2: ${Date.now() - t0} ms | finish: ${turn2.choices[0].finish_reason} | more calls: ${turn2.choices[0].message.tool_calls?.length ?? 0}`);
console.log("  answer:", turn2.choices[0].message.content);

// 3. Muse Voice Transcribe: mono 16-bit PCM WAV (16 or 24 kHz), multipart with a JSON request part
if (wavPath) {
  const form = new FormData();
  form.append("request", new Blob([JSON.stringify({
    mode: "PUSH_TO_TALK", model: "muse-voice-transcribe-1.0", audioEncoding: "WAV",
    keywords: ["wheelchair", "desk", "dresser"],
  })], { type: "application/json" }));
  form.append("audio", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "speech.wav");
  t0 = Date.now();
  const res = await fetch(`${baseURL}/asr/transcribe`, {
    method: "POST", headers: { authorization: `Bearer ${key}` }, body: form,
  });
  console.log(`Transcribe: ${res.status} in ${Date.now() - t0} ms |`, await res.text());
}

// 4. SAM 3.1: one concept, local image sent as a base64 data URL (never published)
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
