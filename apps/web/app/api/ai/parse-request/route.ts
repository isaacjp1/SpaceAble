import { z } from "zod";
import { checkProposal, constraintMessages, constraintSchema } from "@/lib/ai";
import { META, metaClient, metaError, notConfigured, rateLimited, readJson } from "@/lib/meta";
import { apiError } from "@/lib/planner";
import { RoomScenarioSchema } from "@/lib/schema";

const Body = z.strictObject({ scenario: RoomScenarioSchema, userText: z.string().trim().min(3).max(1000) });

// Muse proposes constraints for the user to review. Nothing is applied here.
export async function POST(req: Request) {
  const limited = rateLimited(req);
  if (limited) return limited;
  const client = metaClient();
  if (!client) return notConfigured();
  const body = await readJson(req, 128 * 1024);
  if (body instanceof Response) return body;
  const parsed = Body.safeParse(body);
  if (!parsed.success) return apiError(422, "VALIDATION_ERROR", parsed.error.issues[0].message);
  const { scenario, userText } = parsed.data;

  try {
    const completion = await client.chat.completions.create({
      model: META.muse,
      messages: constraintMessages(scenario, userText),
      response_format: {
        type: "json_schema",
        json_schema: { name: "spaceable_constraints", schema: constraintSchema(scenario) },
      },
      max_completion_tokens: 4000,
      reasoning_effort: "low", // a lookup-shaped task; accepted by the Meta API (verified 2026-10-26)
    }, { signal: req.signal });
    const choice = completion.choices[0];
    if (!choice?.message.content || choice.finish_reason === "length") {
      return apiError(502, "UPSTREAM_UNAVAILABLE", "Muse's reply was cut off before it finished. Try again.", true);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(choice.message.content);
    } catch {
      return apiError(502, "UPSTREAM_UNAVAILABLE", "Muse's reply was not valid JSON. Try again.", true);
    }
    const checked = checkProposal(raw, scenario, userText);
    if (!checked.ok) return apiError(502, "VALIDATION_ERROR", checked.error, true);
    return Response.json({ proposal: checked.proposal, model: completion.model });
  } catch (e) {
    return metaError(e);
  }
}
