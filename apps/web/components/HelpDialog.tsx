"use client";

import { DISCLAIMER } from "./ValidationPanel";

export function HelpDialog({ ref }: { ref: React.Ref<HTMLDialogElement> }) {
  return (
    <dialog ref={ref} aria-labelledby="help-title"
      className="m-auto max-h-[85dvh] w-[min(42rem,92vw)] overflow-y-auto rounded-lg p-0 shadow-xl backdrop:bg-slate-900/40">
      <div className="flex flex-col gap-3 p-5 text-sm text-slate-700">
        <h2 id="help-title" className="text-lg font-semibold text-slate-900">How SpaceAble works</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Start from the sample bedroom, or set your own room size, door and furniture on the left. Measure what you can and tick “confirmed”.</li>
          <li>For each place you need to reach, select the furniture and choose <strong>Add approach zone</strong>, then pick the side you approach from.</li>
          <li>Set your route width (and a turning circle if you want one) under <strong>Your clearance needs</strong>, or tell Muse in a sentence (see below).</li>
          <li>Press <strong>Analyze</strong>. Every check is computed by the planner from your measurements, never by the AI.</li>
          <li>Press <strong>Optimize</strong> to search for verified rearrangements. You get the one with the fewest changes and the one with the widest route (one option when a layout is both). Preview one, compare it side by side, then <strong>Use this layout</strong>.</li>
          <li>Press <strong>Explain</strong> for a plain-language summary that may only quote the planner’s numbers.</li>
          <li>Or <strong>Ask or tell Muse</strong> (type, or press <strong>Speak</strong> and press again to stop). Ask a question, such as “Would a 100 by 40 cm bookshelf fit?”, and Meta Muse Spark runs planner checks to answer; each check becomes a what-if you can load and leave with <strong>Back to my room</strong>. Or tell it what to change, such as “Move the desk against the right wall” or “I need 36 inches”, and it changes your room and checks it; <strong>Undo</strong> puts it back. It asks for any measurement you didn’t give.</li>
          <li>Optionally open <strong>Photo</strong> to have SAM 3.1 outline furniture in a photo, and link what it finds to your plan.</li>
          <li><strong>Save JSON</strong> or <strong>Print summary</strong> to keep the result. Your latest room is also kept in this browser.</li>
        </ol>
        <h3 className="font-semibold text-slate-900">Keyboard</h3>
        <p>Tab to a piece of furniture on the plan, then use arrow keys to move it 5 cm (Shift for 20 cm), R to rotate and Delete to remove. Every value can also be typed in the panels.</p>
        <h3 className="font-semibold text-slate-900">Scanning a room</h3>
        <p>In the SpaceAble iPhone app, on an iPhone or iPad with a LiDAR scanner, <strong>Scan room</strong> measures a rectangular room with Apple’s RoomPlan and opens it here as a draft. Everything in it starts unconfirmed: check the room size and each piece, and measure door widths with a tape measure, because the scan measures the door frame, which is wider than the clear opening. The scan is converted on your phone and not uploaded.</p>
        <h3 className="font-semibold text-slate-900">What the checks assume</h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>A flat 2D plan: rectangles for furniture, no heights, knee or toe clearance.</li>
          <li>The person and device are modelled as a circle as wide as your route. This is not a simulation of how a wheelchair turns.</li>
          <li>Door swing and door maneuvering space are not modelled.</li>
          <li>“No route found” means none was found on the search grid, not that none exists.</li>
          <li><strong>ADA reference check</strong> compares your plan with 5 dimensional rules of the 2010 ADA Standards (route and door widths, turning circle, clear floor spaces, both sides of a bed) and lists what it doesn’t check. It is not a compliance determination, the ADA applies to public places rather than most homes, and nothing here checks any building code. It is no substitute for an occupational therapist.</li>
        </ul>
        <h3 className="font-semibold text-slate-900">Privacy</h3>
        <p>Rooms stay in your browser unless you export them. Photos are resized in your browser, sent to Meta’s API only when you press Detect, and not stored by SpaceAble. Voice recordings are sent to Meta’s API only when you stop recording, with your furniture names as hints, and are not stored either. What you said appears in the text box for you to check first.</p>
        <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">{DISCLAIMER}</p>
        <p className="text-xs text-slate-500">Uses Meta Muse Spark 1.3, SAM 3.1 and Muse Voice Transcribe (Meta Model API). Sample photo: Profpcde, Wikimedia Commons, CC0.</p>
        <form method="dialog" className="flex justify-end">
          <button className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            Close
          </button>
        </form>
      </div>
    </dialog>
  );
}
