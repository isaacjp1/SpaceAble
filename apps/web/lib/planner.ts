// Server-only: forwards planner calls to the FastAPI service with size limits and timeouts.

export const PLANNER_URL = process.env.PLANNER_API_URL ?? "http://127.0.0.1:8000";
export const MAX_BODY_BYTES = 512 * 1024;

/** The shared secret proves the call comes from this server (set the same value on both). */
export const plannerHeaders = (): Record<string, string> => ({
  "content-type": "application/json",
  ...(process.env.PLANNER_SHARED_SECRET ? { "x-planner-secret": process.env.PLANNER_SHARED_SECRET } : {}),
});

export function apiError(status: number, code: string, message: string, retryable = false) {
  return Response.json({ error: { code, message, details: {}, retryable } }, { status });
}

export async function forward(path: string, req: Request, timeoutMs: number): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  const body = declared > MAX_BODY_BYTES ? "" : await req.text();
  if (declared > MAX_BODY_BYTES || new TextEncoder().encode(body).length > MAX_BODY_BYTES) {
    return apiError(413, "VALIDATION_ERROR", `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
  }
  let res: Response;
  try {
    res = await fetch(`${PLANNER_URL}${path}`, {
      method: "POST",
      headers: plannerHeaders(),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof DOMException && e.name === "TimeoutError";
    return timedOut
      ? apiError(504, "UPSTREAM_UNAVAILABLE", `The planner did not answer within ${timeoutMs / 1000} s.`, true)
      : apiError(503, "UPSTREAM_UNAVAILABLE", "The planner service is not reachable. Is it running?", true);
  }
  // Pass the planner's typed body (including its 422 error contract) through unchanged.
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}
