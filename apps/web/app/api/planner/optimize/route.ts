import { rateLimited } from "@/lib/meta";
import { forward } from "@/lib/planner";

// Planner time limit is at most 30 s; leave headroom for the final validations.
export async function POST(req: Request) {
  return rateLimited(req, "optimize", 20) ?? forward("/v1/planner/optimize", req, 40_000);
}
