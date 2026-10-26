import { forward } from "@/lib/planner";

export async function POST(req: Request) {
  return forward("/v1/planner/analyze", req, 15_000);
}
