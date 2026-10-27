"use client";

import { useEffect, useRef, useState } from "react";
import type { ApiError } from "@/lib/schema";
import { MAX_VOICE_SECONDS, recordingToWav } from "@/lib/wav";

/** Tap to start, tap again to stop: no press-and-hold, which many people can't sustain.
 * Muse Voice Transcribe turns the recording into text that is handed back for review. */
export function MicButton({ keywords, disabled, onTranscript }: {
  keywords: string[]; disabled: boolean; onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  useEffect(() => {
    if (state !== "recording") return;
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    const cap = setTimeout(() => { if (recorder.current?.state === "recording") recorder.current.stop(); },
      MAX_VOICE_SECONDS * 1000);
    return () => { clearInterval(tick); clearTimeout(cap); };
  }, [state]);
  // release the microphone if the panel goes away mid-recording
  useEffect(() => () => recorder.current?.stream.getTracks().forEach((t) => t.stop()), []);

  const send = async (recording: Blob) => {
    setState("transcribing");
    try {
      const form = new FormData();
      form.append("audio", new Blob([await recordingToWav(recording)], { type: "audio/wav" }), "recording.wav");
      for (const k of keywords) form.append("keyword", k);
      const res = await fetch("/api/ai/transcribe", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) setError((body as ApiError).error?.message ?? `Error ${res.status}`);
      else if (!body.transcript) setError("No speech was recognised. Try again a little closer to the microphone.");
      else onTranscript(body.transcript);
    } catch {
      setError("The recording could not be turned into text. Try again, or type instead.");
    } finally {
      recorder.current = null;
      setState("idle");
    }
  };

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser can't record audio. Type your request instead.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked. Allow it in your browser settings, or type instead.");
      return;
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      void send(new Blob(chunks, { type: rec.mimeType }));
    };
    rec.start();
    recorder.current = rec;
    setSeconds(0);
    setState("recording");
  };
  const stop = () => { if (recorder.current?.state === "recording") recorder.current.stop(); };

  return (
    <>
      <button type="button" onClick={state === "recording" ? stop : start}
        disabled={disabled || state === "transcribing"}
        className={`min-h-11 rounded border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:opacity-50 ${
          state === "recording" ? "border-red-400 bg-red-50 text-red-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"}`}>
        {state === "recording" ? <><span aria-hidden="true">■ </span>Stop recording ({seconds} s)</>
          : state === "transcribing" ? "Transcribing…" : <><span aria-hidden="true">🎤 </span>Speak</>}
      </button>
      <span role="status" className="sr-only">
        {state === "recording" ? "Recording. Press Stop recording when you are done."
          : state === "transcribing" ? "Turning your words into text." : ""}
      </span>
      {error && <p role="alert" className="basis-full rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">{error}</p>}
    </>
  );
}
