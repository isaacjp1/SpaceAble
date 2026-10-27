import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_BODY_BYTES, forward } from "@/lib/planner";

const post = (body: string) => new Request("http://app/api/planner/analyze", { method: "POST", body });

afterEach(() => vi.unstubAllGlobals());

describe("planner proxy", () => {
  it("maps a refused connection to 503 UPSTREAM_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const res = await forward("/v1/planner/analyze", post("{}"), 1000);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
  });

  it("maps a timeout to 504", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("t", "TimeoutError")));
    expect((await forward("/x", post("{}"), 1000)).status).toBe(504);
  });

  it("passes the planner's 422 error body through unchanged", async () => {
    const err = { error: { code: "VALIDATION_ERROR", message: "bad", details: {}, retryable: false } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(err, { status: 422 })));
    const res = await forward("/x", post("{}"), 1000);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual(err);
  });

  it("rejects oversized bodies without calling the planner", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await forward("/x", post("x".repeat(MAX_BODY_BYTES + 1)), 1000);
    expect(res.status).toBe(413);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("planner auth", () => {
  it("sends the shared secret when configured", async () => {
    vi.stubEnv("PLANNER_SHARED_SECRET", "s3cret");
    const fetchSpy = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await forward("/x", post("{}"), 1000);
    expect(fetchSpy.mock.calls[0][1].headers["x-planner-secret"]).toBe("s3cret");
    vi.unstubAllEnvs();
  });
});
