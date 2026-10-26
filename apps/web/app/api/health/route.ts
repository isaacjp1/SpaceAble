import { connection } from "next/server";
import { PLANNER_URL } from "@/lib/planner";

export async function GET() {
  await connection(); // always evaluated per request, never prerendered
  let planner: "ok" | "unreachable" = "unreachable";
  try {
    const res = await fetch(`${PLANNER_URL}/health`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) planner = "ok";
  } catch {}
  // Only whether a key exists is exposed, never the key itself.
  return Response.json({ status: "ok", planner, meta_configured: Boolean(process.env.MODEL_API_KEY) });
}
