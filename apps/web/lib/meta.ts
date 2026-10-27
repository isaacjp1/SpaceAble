// Server-only: Meta Model API client, error mapping and a small abuse guard.
import { ResponsesStreamError } from "@meta-sam/parser";
import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { apiError } from "./planner";

export const META = {
  baseURL: process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
  muse: process.env.META_MUSE_MODEL ?? "muse-spark-1.3",
  sam: process.env.META_SAM_MODEL ?? "sam-3.1",
  voice: process.env.META_VOICE_MODEL ?? "muse-voice-transcribe-1.0",
};

/** A client per request (picks up key rotation); null when no key is configured. */
export function metaClient(): OpenAI | null {
  const apiKey = process.env.MODEL_API_KEY;
  return apiKey ? new OpenAI({ baseURL: META.baseURL, apiKey, maxRetries: 1, timeout: 90_000 }) : null;
}

export const notConfigured = () =>
  apiError(503, "META_NOT_CONFIGURED", "AI features need MODEL_API_KEY on the server. Manual planning still works.");

/** Map SDK/parser failures to the error contract. Logs the error class only, never content. */
export function metaError(e: unknown): Response {
  if (e instanceof APIUserAbortError) return apiError(499, "UPSTREAM_UNAVAILABLE", "Request cancelled.");
  if (e instanceof APIConnectionTimeoutError) {
    return apiError(504, "UPSTREAM_UNAVAILABLE", "Meta's API did not answer in time.", true);
  }
  if (e instanceof APIConnectionError) return apiError(503, "UPSTREAM_UNAVAILABLE", "Could not reach Meta's API.", true);
  if (e instanceof APIError) {
    if (e.status === 429) {
      return apiError(429, "META_RATE_LIMITED", "Meta's API is rate limiting requests. Wait a minute and try again.", true);
    }
    if (e.status === 401 || e.status === 403) {
      return apiError(502, "META_NOT_CONFIGURED", "Meta rejected the configured API key.");
    }
    const status = e.status ?? 500;
    return apiError(502, "UPSTREAM_UNAVAILABLE", `Meta's API returned an error (${status}).`, status >= 500);
  }
  if (e instanceof ResponsesStreamError) {
    return apiError(502, "UPSTREAM_UNAVAILABLE", `The segmentation stream failed (${e.code}).`, true);
  }
  console.error("[ai] unexpected error:", e instanceof Error ? e.name : typeof e);
  return apiError(500, "INTERNAL_ERROR", "Unexpected error while calling Meta's API.");
}

// Limit: per-instance memory; use a shared store (e.g. Redis) if deployed on many instances.
const hits = new Map<string, number[]>();
/** Sliding-window limit per client IP and bucket. Returns the 429 response when exceeded. */
export function rateLimited(req: Request, bucket = "ai", max = 20, windowMs = 60_000): Response | null {
  const key = `${bucket}:${req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local"}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (recent.length <= max) return null;
  return bucket === "ai"
    ? apiError(429, "META_RATE_LIMITED", "Too many AI requests from this browser. Wait a minute.", true)
    : apiError(429, "RATE_LIMITED", "Too many planner requests from this browser. Wait a minute.", true);
}

/** Parse a JSON body with a size cap; returns the error response on failure. */
export async function readJson(req: Request, maxBytes: number): Promise<unknown | Response> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) {
    return apiError(413, "VALIDATION_ERROR", `Request body exceeds ${maxBytes} bytes.`);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > maxBytes) {
    return apiError(413, "VALIDATION_ERROR", `Request body exceeds ${maxBytes} bytes.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return apiError(400, "VALIDATION_ERROR", "Request body is not valid JSON.");
  }
}
