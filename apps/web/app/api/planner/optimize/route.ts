import { rateLimited } from "@/lib/meta";
import { forward } from "@/lib/planner";

// Planner time limit is at most 30 s; leave headroom for the final validations.
// Hosting platforms read this; the default function timeout is too short for these calls.
export const maxDuration = 60;

export async function POST(req: Request) {
  return rateLimited(req, "optimize", 20) ?? forward("/v1/planner/optimize", req, 40_000);
}
