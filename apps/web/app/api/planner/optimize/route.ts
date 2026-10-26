import { forward } from "@/lib/planner";

// Planner time limit is at most 30 s; leave headroom for the final validations.
export async function POST(req: Request) {
  return forward("/v1/planner/optimize", req, 40_000);
}
