import { META, metaClient, metaError, notConfigured, rateLimited } from "@/lib/meta";
import { apiError } from "@/lib/planner";
import { CONCEPT, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE, imageInfo, segment } from "@/lib/sam";

// The photo is held in memory for this request only: never written, logged or cached.
// Hosting platforms read this; the default function timeout is too short for these calls.
export const maxDuration = 60;

export async function POST(req: Request) {
  const limited = rateLimited(req);
  if (limited) return limited;
  const client = metaClient();
  if (!client) return notConfigured();
  if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES + 64 * 1024) {
    return apiError(413, "VALIDATION_ERROR", "The photo is larger than 5 MB.");
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return apiError(400, "VALIDATION_ERROR", "Send a multipart form with an image and 1-3 concepts.");
  }
  const file = form.get("image");
  const concepts = [...new Set(form.getAll("concept").map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
  if (!(file instanceof File)) return apiError(400, "VALIDATION_ERROR", "Attach a photo.");
  if (file.size > MAX_IMAGE_BYTES) return apiError(413, "VALIDATION_ERROR", "The photo is larger than 5 MB.");
  if (concepts.length < 1 || concepts.length > 3 || !concepts.every((c) => CONCEPT.test(c))) {
    return apiError(422, "VALIDATION_ERROR", "Give 1 to 3 short object names, such as bed, desk.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const info = imageInfo(bytes);
  if (!info) return apiError(415, "VALIDATION_ERROR", "Only JPEG or PNG photos are supported.");
  if (!info.width || !info.height || Math.max(info.width, info.height) > MAX_IMAGE_SIDE) {
    return apiError(422, "VALIDATION_ERROR", `Photo sides must be between 1 and ${MAX_IMAGE_SIDE} px.`);
  }

  // A data URL keeps private photos off the public web (documented SAM input).
  const dataUrl = `data:${info.mime};base64,${Buffer.from(bytes).toString("base64")}`;
  try {
    const results = await Promise.all(concepts.map((c) => segment(client, dataUrl, c, req.signal)));
    return Response.json({ model: META.sam, image: { width: info.width, height: info.height }, results });
  } catch (e) {
    return metaError(e);
  }
}
