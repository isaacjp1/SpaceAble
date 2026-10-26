"use client";

import { useRef, useState } from "react";
import { KINDS, type ApiError, type RoomScenario } from "@/lib/schema";
import { newFurniture, type Update } from "./Panels";

// Mirrors the server's normalized SAM response (lib/sam.ts).
type Detection = {
  id: string; label: string; box_px: [number, number, number, number]; confidence: number | null;
  mask: { path: string; x: number; y: number; sx: number; sy: number } | null;
};
type SegmentResponse = {
  model: string;
  image: { width: number; height: number };
  results: { concept: string; detections: Detection[]; complete: boolean; dropped_records: number }[];
};
type Photo = { blob: Blob; url: string; width: number; height: number; name: string };

const COLORS = ["#4f46e5", "#db2777", "#0891b2"];
const MAX_SIDE = 1600;
const button =
  "rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50";

/** Re-encode in the browser: bounds the size and drops EXIF (e.g. GPS) before upload. */
async function prepare(source: Blob, name: string): Promise<Photo> {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob>((ok, fail) =>
    canvas.toBlob((b) => (b ? ok(b) : fail(new Error("encode failed"))), "image/jpeg", 0.9));
  return { blob, url: URL.createObjectURL(blob), width, height, name };
}

export function PhotoPanel({ scenario, update, metaConfigured }: {
  scenario: RoomScenario; update: Update; metaConfigured: boolean;
}) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [concepts, setConcepts] = useState("bed, desk");
  const [result, setResult] = useState<SegmentResponse | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const list = [...new Set(concepts.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean))];

  const load = async (source: Blob, name: string) => {
    setError(null);
    try {
      const next = await prepare(source, name);
      if (photo) URL.revokeObjectURL(photo.url);
      setPhoto(next);
      setResult(null);
      setLinks({});
    } catch {
      setError("That file could not be read as an image.");
    }
  };

  const detect = async () => {
    if (!photo) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.set("image", photo.blob, "photo.jpg");
    for (const c of list) form.append("concept", c);
    try {
      const res = await fetch("/api/ai/segment", { method: "POST", body: form, signal: ctrl.signal });
      const body = await res.json();
      if (!res.ok) setError((body as ApiError).error?.message ?? `Error ${res.status}`);
      else {
        setResult(body);
        setLinks({});
      }
    } catch {
      if (!ctrl.signal.aborted) setError("Could not reach the SpaceAble server.");
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const link = (d: Detection, value: string) => {
    if (value !== "__new__") return setLinks({ ...links, [d.id]: value });
    const kind = (KINDS as readonly string[]).includes(d.label) ? (d.label as (typeof KINDS)[number]) : "other";
    const o = newFurniture(scenario, kind, d.label[0].toUpperCase() + d.label.slice(1), "ai-inferred");
    update((s) => { s.objects.push(o); });
    setLinks({ ...links, [d.id]: o.id });
  };

  const labelOf = (id: string) => scenario.objects.find((o) => o.id === id)?.label;
  const fs = photo ? Math.max(photo.width, photo.height) / 50 : 12;

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-600">
        Use a photo you have the right to share. It is resized in your browser (dropping location metadata),
        sent to Meta&apos;s SAM 3.1 for segmentation and not stored by SpaceAble; Meta&apos;s terms cover
        processing on their side. Detections only label the photo; plan sizes come from what you measure.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <button className={button} onClick={async () =>
          load(await (await fetch("/samples/hostel-twin-room.jpg")).blob(), "Sample: hostel twin room (CC0)")}>
          Use sample photo
        </button>
        <button className={button} onClick={() => fileInput.current?.click()}>Choose photo…</button>
        <input ref={fileInput} type="file" accept="image/jpeg,image/png" className="hidden" aria-hidden="true"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f, f.name); e.target.value = ""; }} />
        <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
          Look for (up to 3, comma separated)
          <input value={concepts} onChange={(e) => setConcepts(e.target.value)} maxLength={130}
            className="w-56 rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-900 focus:outline-2 focus:outline-indigo-500" />
        </label>
        <button className={`${button} border-indigo-500 text-indigo-800`}
          disabled={!metaConfigured || !photo || busy || list.length < 1 || list.length > 3} onClick={detect}>
          {busy ? "Detecting…" : "Detect with SAM 3.1"}
        </button>
        {busy && <button className={button} onClick={() => abort.current?.abort()}>Cancel</button>}
      </div>
      {!metaConfigured && <p className="text-xs text-slate-500">Photo detection needs MODEL_API_KEY on the server.</p>}
      {list.length > 3 && <p className="text-xs text-amber-800">Use at most 3 names; each is a separate SAM request.</p>}
      {error && <p role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800">{error}</p>}

      {photo && (
        <figure>
          {/* the overlay must cover exactly the image (not the caption) to stay aligned */}
          <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimizable asset */}
          <img src={photo.url} alt={`Room photo: ${photo.name}`} className="block w-full rounded" />
          {result && (
            <svg viewBox={`0 0 ${result.image.width} ${result.image.height}`} className="absolute inset-0 h-full w-full"
              aria-hidden="true">
              {result.results.flatMap((r, ci) => r.detections.map((d, n) => {
                const [l, t, rr, b] = d.box_px;
                const linked = links[d.id] && labelOf(links[d.id]);
                return (
                  <g key={d.id}>
                    {d.mask && (
                      <path d={d.mask.path} fill={COLORS[ci]} fillOpacity={0.35}
                        transform={`translate(${d.mask.x} ${d.mask.y}) scale(${d.mask.sx} ${d.mask.sy})`} />
                    )}
                    <rect x={l} y={t} width={rr - l} height={b - t} fill="none" stroke={COLORS[ci]} strokeWidth={fs / 5} />
                    <text x={l + fs / 3} y={t + fs * 1.1} fontSize={fs} fill="white" stroke={COLORS[ci]}
                      strokeWidth={fs / 6} paintOrder="stroke" fontWeight={600}>
                      {d.label} #{n + 1}{linked ? ` → ${linked}` : ""}
                    </text>
                  </g>
                );
              }))}
            </svg>
          )}
          </div>
          <figcaption className="mt-1 text-xs text-slate-500">{photo.name} · {photo.width}×{photo.height} px</figcaption>
        </figure>
      )}

      {result && (
        <div aria-live="polite" className="flex flex-col gap-2">
          <p className="text-xs text-slate-500">Segmented by Meta {result.model}. Link each detection to plan furniture to confirm what it is.</p>
          {result.results.map((r, ci) => (
            <div key={r.concept} className="rounded border border-slate-200 p-2">
              <p className="text-sm font-medium" style={{ color: COLORS[ci] }}>
                “{r.concept}”: {r.detections.length} found
              </p>
              {r.detections.length === 0 && r.complete && (
                <p className="text-xs text-slate-600">No {r.concept} found in this photo. Try another word, or carry on with the plan by hand.</p>
              )}
              {!r.complete && <p className="text-xs text-amber-800">SAM&apos;s response ended early; results may be partial.</p>}
              {r.dropped_records > 0 && (
                <p className="text-xs text-amber-800">{r.dropped_records} malformed record(s) were skipped.</p>
              )}
              <ul className="mt-1 flex flex-col gap-1">
                {r.detections.map((d, n) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm text-slate-700">
                    <span>{d.label} #{n + 1}{d.confidence !== null ? ` · ${Math.round(d.confidence * 100)}% confidence` : ""}</span>
                    <label className="ml-auto flex items-center gap-1 text-xs text-slate-600">
                      Plan furniture
                      <select value={links[d.id] ?? ""} onChange={(e) => link(d, e.target.value)}
                        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-sm text-slate-900">
                        <option value="">Not linked</option>
                        {scenario.objects.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                        <option value="__new__">Add as new furniture (measure it)</option>
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
