// Route behaviour with Meta mocked at the fetch layer: no paid inference in tests.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as explain } from "@/app/api/ai/explain/route";
import { POST as parseRequest } from "@/app/api/ai/parse-request/route";
import { POST as segmentRoute } from "@/app/api/ai/segment/route";

const scenario = JSON.parse(readFileSync(
  path.join(import.meta.dirname, "../../../shared/fixtures/canonical-bedroom.json"), "utf8"));
const json = (url: string, body: unknown) =>
  new Request(`http://app${url}`, { method: "POST", body: JSON.stringify(body) });
const completion = (content: string) => Response.json({
  id: "c1", object: "chat.completion", created: 0, model: "muse-spark-1.3",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
});
const proposal = {
  locked_object_ids: ["bed"], required_destination_ids: ["desk-approach"], route_width_cm: null,
  turning_diameter_cm: null, optimization_profile: "minimal_changes",
  clarifying_questions: ["What route width do you need?"], unsupported_requests: [],
};
const evidence = {
  requirements: { route_width_cm: 80, door_min_clear_width_cm: 80, turning_diameter_cm: null,
    optimization_profile: "minimal_changes" },
  before: { status: "fail", checks: [{ id: "route-door-1-to-desk-approach", status: "fail", required: true,
    measured_cm: null, required_cm: 80, message: "No verified 80 cm route from door-1." }],
    widest_route_cm: null, warnings: [] },
  after: null, moves: [], option: null, search: null, limitations: [],
};

beforeEach(() => vi.stubEnv("MODEL_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/ai/parse-request", () => {
  it("returns META_NOT_CONFIGURED without a key, never a made-up proposal", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    const res = await parseRequest(json("/api/ai/parse-request", { scenario, userText: "keep my bed" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("META_NOT_CONFIGURED");
  });

  it("returns a validated proposal and keeps a missing width missing", async () => {
    const fetch = vi.fn().mockResolvedValue(completion(JSON.stringify(proposal)));
    vi.stubGlobal("fetch", fetch);
    const res = await parseRequest(json("/api/ai/parse-request",
      { scenario, userText: "Keep my bed where it is, but make the route to my desk clearer." }));
    expect(res.status).toBe(200);
    expect((await res.json()).proposal).toEqual(proposal);
    const sent = JSON.parse(fetch.mock.calls[0][1].body);
    expect(sent.response_format.type).toBe("json_schema");
    expect(JSON.stringify(sent.messages)).not.toContain("Sample Bedroom"); // title is not sent
  });

  it("rejects a proposal naming furniture that does not exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      completion(JSON.stringify({ ...proposal, locked_object_ids: ["piano"] }))));
    const res = await parseRequest(json("/api/ai/parse-request", { scenario, userText: "keep the piano" }));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: "VALIDATION_ERROR", message: expect.stringContaining("piano") });
  });

  it("maps an upstream 429 to a polite retryable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json(
      { error: { message: "slow down" } }, { status: 429, headers: { "retry-after-ms": "1" } })));
    const res = await parseRequest(json("/api/ai/parse-request", { scenario, userText: "keep my bed" }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toMatchObject({ code: "META_RATE_LIMITED", retryable: true });
  });
});

describe("POST /api/ai/explain", () => {
  it("falls back to the labelled template without a key", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    const body = await (await explain(json("/api/ai/explain", { evidence }))).json();
    expect(body).toMatchObject({ source: "template", note: expect.stringContaining("not configured") });
    expect(body.text).toContain("No verified 80 cm route");
  });

  it("discards a Muse draft with numbers the planner never produced", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion("Your route is now 120 cm wide.")));
    const body = await (await explain(json("/api/ai/explain", { evidence }))).json();
    expect(body).toMatchObject({ source: "template", note: expect.stringContaining("120") });
  });

  it("returns a grounded Muse explanation as Muse's", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion(
      "There is no verified 80 cm route from door-1 to the desk yet.")));
    const body = await (await explain(json("/api/ai/explain", { evidence }))).json();
    expect(body).toMatchObject({ source: "muse", model: "muse-spark-1.3" });
  });
});

describe("POST /api/ai/segment", () => {
  const form = (bytes: Uint8Array<ArrayBuffer>, concepts: string[]) => {
    const f = new FormData();
    f.set("image", new File([bytes], "photo.jpg"));
    for (const c of concepts) f.append("concept", c);
    return new Request("http://app/api/ai/segment", { method: "POST", body: f });
  };
  const jpg = new Uint8Array(readFileSync(path.join(import.meta.dirname, "../public/samples/hostel-twin-room.jpg")));

  it("returns META_NOT_CONFIGURED without a key", async () => {
    vi.stubEnv("MODEL_API_KEY", "");
    expect((await segmentRoute(form(jpg, ["bed"]))).status).toBe(503);
  });

  it("rejects non-images by their bytes and bounds the concepts", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await segmentRoute(form(new TextEncoder().encode("<svg/>"), ["bed"]))).status).toBe(415);
    expect((await segmentRoute(form(jpg, ["bed", "desk", "chair", "lamp"]))).status).toBe(422);
    expect((await segmentRoute(form(jpg, ["Segment the bed!"]))).status).toBe(422);
    expect(fetch).not.toHaveBeenCalled();
  });
});
