import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { META, metaError, notConfigured, rateLimited } from "@/lib/meta";
import { apiError } from "@/lib/planner";
import { MAX_VOICE_BYTES, MAX_VOICE_SECONDS, VOICE_RATES, wavInfo } from "@/lib/wav";

const KEYWORD = /^[\p{L}\p{N} '-]{1,40}$/u; // furniture names that bias recognition
const MAX_KEYWORDS = 20;

// Muse Voice Transcribe turns a recording into text the person reviews before anything else happens.
// The audio is held in memory for this request only: never written, logged or cached.
// Hosting platforms read this; the default function timeout is too short for these calls.
export const maxDuration = 60;

export async function POST(req: Request) {
  const limited = rateLimited(req);
  if (limited) return limited;
  const key = process.env.MODEL_API_KEY;
  if (!key) return notConfigured();
  const tooLong = `Recordings are limited to ${MAX_VOICE_SECONDS} seconds.`;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_VOICE_BYTES + 16 * 1024) {
    return apiError(413, "VALIDATION_ERROR", tooLong);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(400, "VALIDATION_ERROR", "Send a multipart form with a WAV recording.");
  }
  const file = form.get("audio");
  if (!(file instanceof File)) return apiError(400, "VALIDATION_ERROR", "Attach a recording.");
  if (file.size > MAX_VOICE_BYTES) return apiError(413, "VALIDATION_ERROR", tooLong);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = wavInfo(bytes);
  if (!info) return apiError(415, "VALIDATION_ERROR", "Only WAV recordings are supported.");
  if (info.format !== 1 || info.channels !== 1 || info.bits !== 16 || !VOICE_RATES.includes(info.rate)) {
    return apiError(422, "VALIDATION_ERROR", "The recording must be mono 16-bit PCM at 16 or 24 kHz.");
  }
  if (info.seconds > MAX_VOICE_SECONDS) return apiError(422, "VALIDATION_ERROR", tooLong);
  const keywords = [...new Set(form.getAll("keyword").map((k) => String(k).trim()).filter((k) => KEYWORD.test(k)))]
    .slice(0, MAX_KEYWORDS);

  const body = new FormData();
  body.append("request", new Blob([JSON.stringify({
    mode: "PUSH_TO_TALK", model: META.voice, audioEncoding: "WAV", keywords,
  })], { type: "application/json" }));
  body.append("audio", new Blob([bytes], { type: "audio/wav" }), "recording.wav");
  let res: Response;
  try {
    res = await fetch(`${META.baseURL}/asr/transcribe`, {
      method: "POST", headers: { authorization: `Bearer ${key}` }, body,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(30_000)]),
    });
  } catch (e) {
    // Same error contract as the SDK-based routes.
    return metaError(req.signal.aborted ? new APIUserAbortError()
      : e instanceof DOMException && e.name === "TimeoutError" ? new APIConnectionTimeoutError()
        : new APIConnectionError({ cause: e instanceof Error ? e : undefined }));
  }
  if (!res.ok) return metaError(APIError.generate(res.status, undefined, undefined, res.headers));
  const data = await res.json().catch(() => null);
  if (typeof data?.transcript !== "string") {
    return apiError(502, "UPSTREAM_UNAVAILABLE", "Meta's transcription reply was not understood.", true);
  }
  return Response.json({ model: META.voice, transcript: data.transcript.trim().slice(0, 1000) });
}
