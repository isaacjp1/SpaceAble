import { rateLimited } from "@/lib/meta";
import { forward } from "@/lib/planner";

export async function POST(req: Request) {
  return rateLimited(req, "analyze", 120) ?? forward("/v1/planner/analyze", req, 15_000);
}
