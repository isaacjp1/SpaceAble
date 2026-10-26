import { z } from "zod";
import { EvidenceSchema, checkExplanation, explainMessages, templateExplanation } from "@/lib/ai";
import { META, metaClient, metaError, rateLimited, readJson } from "@/lib/meta";
import { apiError } from "@/lib/planner";

const Body = z.strictObject({ evidence: EvidenceSchema });

// Always answers: Muse's text when it passes the grounding check, otherwise the labelled template.
export async function POST(req: Request) {
  const limited = rateLimited(req);
  if (limited) return limited;
  const body = await readJson(req, 64 * 1024);
  if (body instanceof Response) return body;
  const parsed = Body.safeParse(body);
  if (!parsed.success) return apiError(422, "VALIDATION_ERROR", parsed.error.issues[0].message);
  const { evidence } = parsed.data;
  const template = (note: string) => Response.json({ source: "template", text: templateExplanation(evidence), note });

  const client = metaClient();
  if (!client) return template("Meta API not configured; showing the built-in explanation.");
  try {
    const completion = await client.chat.completions.create({
      model: META.muse,
      messages: explainMessages(evidence),
      max_completion_tokens: 4000,
      reasoning_effort: "low",
    }, { signal: req.signal });
    const choice = completion.choices[0];
    const text = choice?.finish_reason === "length" ? "" : choice?.message.content?.trim() ?? "";
    if (!text) return template("Muse's reply was empty or cut off; showing the built-in explanation.");
    const check = checkExplanation(text, evidence);
    return check.ok
      ? Response.json({ source: "muse", model: completion.model, text })
      : template(`Muse's draft was discarded because ${check.reason}.`);
  } catch (e) {
    const { error } = await metaError(e).json();
    return template(`Meta API unavailable (${error.code}); showing the built-in explanation.`);
  }
}
