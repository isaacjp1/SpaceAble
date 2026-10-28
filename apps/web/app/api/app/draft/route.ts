import { z } from "zod";
import sample from "../../../../../../shared/fixtures/canonical-bedroom.json";
import { rateLimited, readJson } from "@/lib/meta";
import { apiError } from "@/lib/planner";
import { capturedRoomToScenario } from "@/lib/roomplan";
import { RequirementsSchema, RoomScenarioSchema } from "@/lib/schema";
import { defaultDoor, defaultReach } from "@/lib/simple";

const Body = z.strictObject({ scan: z.unknown().optional() });

/** iPhone app: a RoomPlan scan (or, without one, the sample room) → the draft room to check, with the
 * places the person probably needs to reach and the likeliest way in. Nothing is stored. */
export async function POST(req: Request) {
  const limited = rateLimited(req, "app", 30);
  if (limited) return limited;
  const body = await readJson(req, 2 * 1024 * 1024); // raw scans are larger than rooms
  if (body instanceof Response) return body;
  const parsed = Body.safeParse(body);
  if (!parsed.success) return apiError(422, "VALIDATION_ERROR", parsed.error.issues[0].message);

  let draft;
  try {
    draft = parsed.data.scan === undefined ? { scenario: RoomScenarioSchema.parse(sample), warnings: [] }
      : capturedRoomToScenario(parsed.data.scan, RequirementsSchema.parse({}));
  } catch (e) {
    return apiError(400, "SCAN_UNUSABLE", e instanceof Error ? e.message : "The scan couldn't be read.");
  }
  const { scenario, warnings } = draft;
  if (!scenario.doors.length) {
    return apiError(400, "SCAN_UNUSABLE", "We couldn't find the doorway. Scan again, and include the door or opening you come in through.");
  }
  return Response.json({ scenario, reach: defaultReach(scenario), start_door_id: defaultDoor(scenario), warnings });
}
