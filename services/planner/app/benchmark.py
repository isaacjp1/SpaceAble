"""Synthetic benchmark with independent verification of every reported result.

    python -m app.benchmark                     # print the table
    python -m app.benchmark --write ../../docs/benchmark.md --repeat

Synthetic rooms only: results say nothing about performance in real homes.
"""

import argparse
import json
import os
import platform
import random
from datetime import date
from itertools import combinations
from pathlib import Path

from shapely.geometry import LineString, Point, box
from shapely.ops import unary_union

from . import routing
from .analyze import analyze
from .geometry import footprint, overlaps
from .models import EPS, OptimizeOptions, RoomScenario, ValidationResult, apply_layout
from .optimize import optimize

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures"
NAMED = ["canonical-bedroom", "feasible-bedroom", "locked-impossible", "narrow-corridor",
         "wide-corridor", "impossible-turn", "unconfirmed-input"]
PROCEDURAL_SEEDS = range(1, 15)


def named(name: str) -> RoomScenario:
    return RoomScenario.model_validate(json.loads((FIXTURES / f"{name}.json").read_text()))


def procedural(seed: int) -> RoomScenario:
    """A random bedroom: locked bed flush to a wall, movable desk (required approach) and others."""
    rng = random.Random(seed)
    W, H = rng.randrange(320, 521, 10), rng.randrange(300, 451, 10)
    door = {"id": "door-1", "wall": "left", "offset_cm": rng.randrange(10, H - 100, 5),
            "clear_width_cm": rng.choice([80, 85, 90]), "confirmed": True}
    placed: list[dict] = []

    def place(id, kind, w, h, wall_flush=False, tries=300):
        for _ in range(tries):
            rot = rng.choice([0, 90])
            fw, fh = (h, w) if rot == 90 else (w, h)
            if fw > W or fh > H:
                continue
            x, y = rng.randrange(0, int(W - fw) + 1, 5), rng.randrange(0, int(H - fh) + 1, 5)
            if wall_flush:  # against the top, right or bottom wall (the door is on the left)
                x, y = rng.choice([(x, 0), (W - fw, y), (x, H - fh)])
            o = {"id": id, "label": id.capitalize(), "kind": kind, "x_cm": x, "y_cm": y,
                 "width_cm": w, "height_cm": h, "rotation_deg": rot, "movable": True,
                 "confirmed": True}
            rect = box(x, y, x + fw, y + fh)
            if not any(overlaps(rect, box(p["x_cm"], p["y_cm"], *_far(p))) for p in placed):
                placed.append(o)
                return

    place("bed", "bed", 140, 200, wall_flush=True)
    place("desk", "desk", 120, 60)
    for id, kind, w, h in [("dresser", "dresser", 100, 50), ("chair", "chair", 50, 50),
                           ("nightstand", "nightstand", 45, 40)]:
        place(id, kind, w, h)
    ids = {p["id"] for p in placed}
    dests = [{"id": "desk-approach", "object_id": "desk", "side": "bottom",
              "approach_width_cm": 80, "approach_depth_cm": 90, "required": True}]
    dests = dests if "desk" in ids else []
    return RoomScenario.model_validate({
        "id": f"procedural-{seed}", "title": f"Procedural bedroom (seed {seed})",
        "room": {"width_cm": W, "height_cm": H}, "doors": [door], "objects": placed,
        "destinations": dests,
        "requirements": {
            "route_width_cm": rng.choice([75, 80, 90]), "door_min_clear_width_cm": 80,
            "turning_diameter_cm": rng.choice([None, None, 150]),
            "required_destination_ids": [d["id"] for d in dests],
            "locked_object_ids": ["bed"] if "bed" in ids else []}})


def _far(p: dict) -> tuple[float, float]:
    w, h = p["width_cm"], p["height_cm"]
    if p["rotation_deg"] == 90:
        w, h = h, w
    return p["x_cm"] + w, p["y_cm"] + h


def verify_validation(s: RoomScenario, v: ValidationResult) -> list[str]:
    """Re-derive what a passing result claims, with different code than analyze() uses."""
    problems = []
    req = s.requirements
    W, H = s.room.width_cm, s.room.height_cm
    rects = {o.id: footprint(o) for o in s.objects}
    if v.status == "pass":
        room = box(0, 0, W, H).buffer(EPS)
        problems += [f"{i} outside room" for i, r in rects.items() if not room.covers(r)]
        problems += [f"{a}/{b} overlap" for a, b in combinations(rects, 2)
                     if rects[a].intersection(rects[b]).area > EPS]
    r = (req.route_width_cm or 0) / 2
    obstacles = unary_union(list(rects.values())) if rects else None
    for route in v.routes:
        if route.status != "pass" or route.destination_id not in req.required_destination_ids:
            continue
        line = LineString(route.polyline) if len(route.polyline) > 1 else Point(route.polyline[0])
        if obstacles is not None and line.distance(obstacles) < r - 1e-6:
            problems.append(f"{route.destination_id}: route closer than {r} cm to furniture")
        if min(min(x, W - x, y, H - y) for x, y in route.polyline) < r - 1e-6:
            problems.append(f"{route.destination_id}: route closer than {r} cm to a wall")
        start = routing.entry_point(s.start_door(), s.room, r)
        if tuple(route.polyline[0]) != tuple(start):
            problems.append(f"{route.destination_id}: route does not start at the entry point")
        target = box(*route.target_rect)
        if not target.buffer(1e-6).covers(Point(route.polyline[-1])):
            problems.append(f"{route.destination_id}: route does not end in the approach zone")
        comp = routing.component_at(routing.free_space(s.room, list(rects.values()), r), start)
        # invariant (a verified path implies connectivity); expected never to fire
        if comp is None or comp.intersection(target).area <= EPS:
            problems.append(f"{route.destination_id}: grid pass without polygon connectivity")
    return problems


def run(scenarios: list[RoomScenario], time_limit_s: float) -> list[dict]:
    rows = []
    for s in scenarios:
        res = optimize(s, OptimizeOptions(time_limit_s=time_limit_s))
        problems = [f"baseline: {p}" for p in verify_validation(s, res.baseline)]
        locked = s.requirements.locked_object_ids
        fixed = {o.id for o in s.objects if not o.movable or o.id in locked}
        for alt in res.alternatives:
            moved = apply_layout(s, alt.layout)
            again = analyze(moved)
            volatile = {"elapsed_ms"}
            if again.model_dump(exclude=volatile) != alt.validation.model_dump(exclude=volatile):
                problems.append(f"{alt.id}: re-analysis differs")
            if alt.validation.status != "pass":
                problems.append(f"{alt.id}: reported but not passing")
            problems += [f"{alt.id}: moved fixed/locked {m.object_id}" for m in alt.moves
                         if m.object_id in fixed]
            problems += [f"{alt.id}: {p}" for p in verify_validation(moved, alt.validation)]
        results = [res.baseline] + [a.validation for a in res.alternatives]
        best = res.alternatives[0] if res.alternatives else None
        rows.append({
            "fixture": s.id,
            "before": res.baseline.status,
            "search_status": res.status,
            "after": best.validation.status if best else "-",
            "alternatives": len(res.alternatives),
            "moved_objects": best.cost.moved_objects if best else "-",
            "route_length_cm": best.cost.route_length_cm if best else "-",
            "solver_time_s": res.search.elapsed_s,
            "validated": res.search.candidates_tested,
            "exhaustive": res.search.exhaustive,
            "hit_time_limit": res.status == "no_solution_found_within_budget"
                              or any("time limit" in w for w in res.warnings),
            "grid_misses": sum("finer grid" in w for v in results for w in v.warnings),
            "problems": problems,
        })
    return rows


def scenarios() -> list[RoomScenario]:
    return [named(n) for n in NAMED] + [procedural(seed) for seed in PROCEDURAL_SEEDS]


STABLE = ["fixture", "before", "search_status", "after", "moved_objects", "route_length_cm"]


def markdown(rows: list[dict], time_limit_s: float, repro: str) -> str:
    cols = ["fixture", "before", "search_status", "after", "alternatives", "moved_objects",
            "route_length_cm", "solver_time_s", "validated", "exhaustive", "hit_time_limit",
            "grid_misses"]
    lines = [
        "# SpaceAble benchmark",
        "",
        f"Generated {date.today().isoformat()} by `python -m app.benchmark` on "
        f"{platform.platform()}, Python {platform.python_version()}, {os.cpu_count()} CPUs.",
        "Analysis grid 5 cm; candidate grid 20 cm; optimizer time limit "
        f"{time_limit_s:g} s per room.",
        "",
        "**These are synthetic rooms.** They test that the engine is internally consistent and "
        "honest about failure. They say nothing about how well it does in real homes.",
        "",
        "| " + " | ".join(cols) + " | verification |",
        "|" + "---|" * (len(cols) + 1),
    ]
    for r in rows:
        cells = [str(r[c]) for c in cols]
        lines.append("| " + " | ".join(cells) + f" | {'OK' if not r['problems'] else 'MISMATCH'} |")
    problems = [f"- {r['fixture']}: {p}" for r in rows for p in r["problems"]]
    found = sum(r["search_status"] == "solutions_found" for r in rows)
    lines += [
        "",
        f"- Rooms: {len(rows)} ({len(NAMED)} named fixtures, "
        f"{len(PROCEDURAL_SEEDS)} procedural seeds).",
        f"- Verification mismatches: **{len(problems)}**. Every reported layout was re-analysed "
        "and its containment, overlaps, locked pieces and route clearance/start/end were "
        "re-checked independently.",
        f"- `solutions_found`: {found}/{len(rows)}. This includes rooms that already passed.",
        f"- Grid misses (polygon connected, no grid path, flagged with a finer-grid warning): "
        f"{sum(r['grid_misses'] for r in rows)}.",
        f"- Reproducibility: {repro}",
        "",
        "Column notes: `validated` is how many candidate layouts reached the full validator. "
        "`exhaustive` means every discrete combination was visited. Rows with `hit_time_limit` "
        "depend on machine speed and may differ between runs.",
    ]
    if problems:
        lines += ["", "## Mismatches", "", *problems]
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--time-limit", type=float, default=10.0)
    ap.add_argument("--write", type=Path, help="write the markdown report here")
    ap.add_argument("--repeat", action="store_true", help="run twice and compare stable columns")
    args = ap.parse_args()
    rooms = scenarios()
    rows = run(rooms, args.time_limit)
    repro = "not checked (run with --repeat)."
    if args.repeat:
        again = run(rooms, args.time_limit)
        diff = [a["fixture"] for a, b in zip(rows, again, strict=True)
                if [a[c] for c in STABLE] != [b[c] for c in STABLE]]
        repro = ("a second run gave identical results in the columns "
                 + ", ".join(f"`{c}`" for c in STABLE) + "." if not diff
                 else f"rows differing between two runs: {', '.join(diff)}.")
    report = markdown(rows, args.time_limit, repro)
    if args.write:
        args.write.write_text(report)
    print(report)
    if any(r["problems"] for r in rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
