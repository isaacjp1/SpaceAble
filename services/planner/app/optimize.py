"""Bounded best-first layout search. Every returned alternative passed `analyze`.

Each movable object gets a list of discrete placements: "stay" (cost 0) first, then
grid candidates sorted by cost. Combinations are visited in increasing total cost
with a heap over the product of those lists, i.e. the order a CP-SAT model with
no-good cuts would produce for this linear cost, without the solver dependency.
Cheap necessary conditions reject combinations early. Only `analyze` can accept one.
"""

import heapq
import math
from dataclasses import dataclass
from itertools import combinations
from time import perf_counter

from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union

from . import routing
from .analyze import analyze
from .geometry import approach_rect, dims, footprint, inside, overlaps
from .models import (
    EPS,
    Alternative,
    Cost,
    Furniture,
    Layout,
    Move,
    ObjectPosition,
    OptimizationResult,
    OptimizeOptions,
    RoomScenario,
    SearchInfo,
    ValidationResult,
    apply_layout,
    without_unplaced,
)

# Initial engineering defaults, not accessibility science.
MOVE_PENALTY = 100.0  # per moved object
DISPLACEMENT_WEIGHT = 0.2  # per cm of footprint-centre displacement
ROTATION_PENALTY = 10.0  # orientation changed
OFF_WALL_PENALTY = 20.0  # moved piece touches no wall (a preference, never a requirement)
ROUTE_LENGTH_WEIGHT = 0.05  # per cm of required route, applied after validation
MAX_CANDIDATES_PER_OBJECT = 120
MAX_MOVED_OBJECTS = 3
DIVERSITY_CM = 60.0  # alternatives must differ by more than this for some object
# Limit: the widest-route option is the widest of the first POOL verified layouts found in cost
# order, not the widest possible one. Raise it, or search by width, if that matters. The search
# stops sooner once a layout reaches the widest route any layout could have, or, when the current
# layout passes, after POOL layouts in a row that looked wider turned out not to be.
POOL = 12
FEWEST_POOL = 3  # the fewest-changes option is the cheapest of at least this many verified layouts


@dataclass(frozen=True)
class Cand:
    obj: Furniture  # the object at this placement
    rect: Polygon
    approach: tuple[Polygon, ...]  # required approach zones attached to this object
    cost: float


def _centre(rect: Polygon) -> tuple[float, float]:
    x1, y1, x2, y2 = rect.bounds
    return (x1 + x2) / 2, (y1 + y2) / 2


def _grid(limit: float, size: float, step: float) -> list[float]:
    """Positions 0, step, 2*step, ... plus flush against the far wall."""
    top = limit - size
    if top < -EPS:
        return []
    return sorted({*(i * step for i in range(int(top // step) + 1)), max(top, 0.0)})


def _candidates(o, scenario, fixed_rects, fixed_zones, req_dests, start, r, grid):
    """Placements for one movable object: (list with 'stay' first, truncated?).

    A new piece (to_place) has no 'stay' and nothing to move from: placing it costs only the
    off-wall preference, so every combination places it and existing pieces move only if needed.
    """
    room = scenario.room
    dests = [d for d in req_dests if d.object_id == o.id]

    def cand(obj: Furniture, cost: float) -> Cand:
        return Cand(obj, footprint(obj), tuple(approach_rect(d, obj) for d in dests), cost)

    stay = cand(o, 0.0)
    w0, h0 = dims(o)
    rotations = [0, 90, 180, 270] if dests else ([0] if w0 == h0 else [0, 90])
    if o.rotation_deg not in rotations:
        rotations.append(o.rotation_deg)
    out = []
    for rot in rotations:
        w, h = dims(o.model_copy(update={"rotation_deg": rot}))
        for x in _grid(room.width_cm, w, grid):
            for y in _grid(room.height_cm, h, grid):
                if not o.to_place and (x, y, rot) == (o.x_cm, o.y_cm, o.rotation_deg):
                    continue
                c = cand(o.model_copy(update={"x_cm": x, "y_cm": y, "rotation_deg": rot}), 0.0)
                if (any(overlaps(c.rect, f) for f in fixed_rects)
                        or any(overlaps(c.rect, z) for z in fixed_zones)
                        or c.rect.distance(Point(start)) <= r  # would sit on the entry disk
                        # someone using this approach zone would stand in the doorway
                        or any(z.distance(Point(start)) < r for z in c.approach)
                        or any(not inside(z, room) or any(overlaps(z, f) for f in fixed_rects)
                               for z in c.approach)):
                    continue
                x1, y1, x2, y2 = c.rect.bounds
                on_wall = (x1 <= EPS or y1 <= EPS or x2 >= room.width_cm - EPS
                           or y2 >= room.height_cm - EPS)
                cost = OFF_WALL_PENALTY * (not on_wall)
                if not o.to_place:
                    cost += (MOVE_PENALTY
                             + DISPLACEMENT_WEIGHT * math.dist(_centre(c.rect), _centre(stay.rect))
                             + ROTATION_PENALTY * (rot != o.rotation_deg))
                out.append(Cand(c.obj, c.rect, c.approach, cost))
    out.sort(key=lambda c: (c.cost, c.obj.x_cm, c.obj.y_cm, c.obj.rotation_deg))
    # Limit: a new piece keeps the 120 cheapest spots (wall-flush first, then top-left first);
    # the search then reports a budget limit, never infeasibility, if that cut anything.
    return (([] if o.to_place else [stay]) + out[:MAX_CANDIDATES_PER_OBJECT],
            len(out) > MAX_CANDIDATES_PER_OBJECT)


def _compatible(chosen: list[Cand]) -> bool:
    """Movers must not overlap each other or each other's approach zones."""
    for a, b in combinations(chosen, 2):
        if (overlaps(a.rect, b.rect) or any(overlaps(a.rect, z) for z in b.approach)
                or any(overlaps(b.rect, z) for z in a.approach)):
            return False
    return True


def _touches_all(free, start, targets) -> bool:
    comp = routing.component_at(free, start)
    return comp is not None and all(comp.intersection(t).area > EPS for t in targets)


def _reaches(room, door, rects, targets, w: float) -> bool:
    """Necessary condition only: at route width w, the entry's free-space component touches every
    target. Fewer rects, fewer targets or a narrower w can only keep it true."""
    r = w / 2
    return _touches_all(routing.free_space(room, rects, r), routing.entry_point(door, room, r),
                        targets)


def _reach_limit(room, door, rects, targets, base: float) -> float:
    """Widest width, in 1 cm steps above base, at which `_reaches` holds (it must hold at base)."""
    steps = _last_true(lambda k: _reaches(room, door, rects, targets, base + k),
                       max(0, int(min(room.width_cm, room.height_cm) - base)))
    return base + steps


def _route_length(v: ValidationResult, required: set[str]) -> float:
    return sum(rt.length_cm or 0.0 for rt in v.routes if rt.destination_id in required)


def _last_true(pred, hi: int) -> int:
    """Largest k in [0, hi] with pred(k), given pred(0) and that pred only turns false."""
    lo = 0
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if pred(mid):
            lo = mid
        else:
            hi = mid - 1
    return lo


def widest_route(scenario: RoomScenario, grid_cm: float = 5.0) -> float | None:
    """Widest route width, in 1 cm steps above the required one, at which `analyze` passes.

    For a layout that already passes. A polygon test (the entry's free-space component
    touches every required approach zone) bounds the width; `analyze` must pass at the
    reported width, otherwise it is lowered until it does.
    """
    scenario = without_unplaced(scenario)  # as analyze does: an unplaced piece is not in the room
    req, room, door = scenario.requirements, scenario.room, scenario.start_door()
    if not req.route_width_cm or door is None or door.clear_width_cm is None:
        return None
    rects = [footprint(o) for o in scenario.objects]
    by_id = {o.id: o for o in scenario.objects}
    targets = [approach_rect(d, by_id[d.object_id]) for d in scenario.destinations
               if d.id in req.required_destination_ids]

    def passes(w: float) -> bool:
        wider = scenario.model_copy(update={
            "requirements": req.model_copy(update={"route_width_cm": w})})
        return analyze(wider, grid_cm).status == "pass"

    base = req.route_width_cm
    steps = round(_reach_limit(room, door, rects, targets, base) - base)
    if steps and not passes(base + steps):
        steps = _last_true(lambda k: passes(base + k), steps - 1)
    return round(base + steps, 2)


def optimize(scenario: RoomScenario, options: OptimizeOptions) -> OptimizationResult:
    t0 = perf_counter()
    req = scenario.requirements
    required = set(req.required_destination_ids)
    baseline = analyze(scenario)
    warnings: list[str] = []
    new = [o for o in scenario.objects if o.to_place]  # every option must place these
    placing = f" with a place for the new {', '.join(o.label for o in new)}" if new else ""
    tested = considered = 0
    exhaustive = False

    def done(status, message, alternatives=()) -> OptimizationResult:
        return OptimizationResult(
            status=status, message=message, alternatives=list(alternatives), baseline=baseline,
            warnings=warnings, search=SearchInfo(
                grid_spacing_cm=options.grid_spacing_cm, time_limit_s=options.time_limit_s,
                elapsed_s=round(perf_counter() - t0, 3), combinations_considered=considered,
                candidates_tested=tested, exhaustive=exhaustive))

    current = None
    if baseline.status == "pass" and not new:
        length = _route_length(baseline, required)
        baseline.widest_route_cm = widest_route(scenario)
        current = Alternative(id="current", layout=Layout(), moves=[], validation=baseline,
                              cost=Cost(moved_objects=0, displacement_cm=0, route_length_cm=length,
                                        total_score=round(ROUTE_LENGTH_WEIGHT * length, 1)),
                              best_for=["fewest_changes", "widest_route"])
        # It is the fewest-changes option; the search looks only for a wider route than this.
    blocking = [c for c in baseline.checks if c.required and c.status in ("needs_input", "unknown")
                # the baseline leaves new pieces out, and with them their destinations
                and not (new and c.id == "destinations-selected")]
    if blocking:
        return done("needs_input", "Resolve these before optimizing: "
                    + " ".join(c.message for c in blocking))

    movers = [o for o in scenario.objects if o.movable and o.id not in req.locked_object_ids]
    if not movers and current:
        return done("solutions_found", "The current layout already passes, and no furniture is "
                    "allowed to move.", [current])
    if not movers:
        return done("discretized_search_infeasible", "No furniture is allowed to move. Unlock a "
                    "piece or mark it movable, then optimize again.")

    # Removing furniture only enlarges free space, so a check that still fails with
    # every movable piece removed cannot be fixed by any placement of those pieces.
    mover_ids = {o.id for o in movers}
    owner = {d.id: d.object_id for d in scenario.destinations}
    stripped = scenario.model_copy(update={
        "objects": [o for o in scenario.objects if o.id not in mover_ids],
        "destinations": [d for d in scenario.destinations if d.object_id not in mover_ids],
        "requirements": req.model_copy(update={"required_destination_ids": [
            i for i in req.required_destination_ids if owner[i] not in mover_ids]})})
    fails = [c for c in analyze(stripped).checks if c.required and c.status == "fail"]
    if fails:
        return done("discretized_search_infeasible", "Moving furniture cannot fix this under the "
                    "current geometric model. Even with every movable piece removed: "
                    + " ".join(c.message for c in fails))

    r = req.route_width_cm / 2
    door = scenario.start_door()
    start = routing.entry_point(door, scenario.room, r)
    by_id = {o.id: o for o in scenario.objects}
    fixed_rects = [footprint(o) for o in scenario.objects if o.id not in mover_ids]
    # Every route starts at the entry, so fixed pieces crowding it rule out any placement.
    # (The stripped analysis misses this when all required destinations belong to movers.)
    if routing.component_at(routing.free_space(scenario.room, fixed_rects, r), start) is None:
        near = [o.id for o in scenario.objects
                if o.id not in mover_ids and footprint(o).distance(Point(start)) < r]
        return done("discretized_search_infeasible", "Moving furniture cannot fix this under the "
                    f"current geometric model: the entry point inside {door.id} has less than "
                    f"{2 * r:g} cm of clearance because of "
                    f"{', '.join(near) + ' (fixed or locked)' if near else 'the walls'}.")
    req_dests = [d for d in scenario.destinations if d.id in required]
    fixed_targets = [approach_rect(d, by_id[d.object_id]) for d in req_dests
                     if d.object_id not in mover_ids]
    lists, truncated = [], False
    for o in movers:
        cands, cut = _candidates(o, scenario, fixed_rects, fixed_targets, req_dests, start, r,
                                 options.grid_spacing_cm)
        lists.append(cands)
        truncated |= cut
    nowhere = [o.label for o, cands in zip(movers, lists, strict=True) if not cands]
    if nowhere:
        exhaustive = not truncated
        return done("discretized_search_infeasible", f"No spot for the new {', '.join(nowhere)} "
                    f"among the {options.grid_spacing_cm:g} cm grid placements tried: everywhere "
                    "it overlaps fixed furniture, a required approach zone or the doorway.")

    def reaches(chosen: list[Cand], w: float) -> bool:
        return _reaches(scenario.room, door, fixed_rects + [c.rect for c in chosen],
                        fixed_targets + [z for c in chosen for z in c.approach], w)

    # No layout can be wider than the best spot for the most constraining mover: every layout
    # puts each mover in one of its spots, and every other piece only narrows the route.
    ceiling = math.inf
    for cands in lists:
        top = 0.0
        for c in cands:
            if reaches([c], max(top + 1, 2 * r)):
                top = _reach_limit(scenario.room, door, fixed_rects + [c.rect],
                                   fixed_targets + list(c.approach), req.route_width_cm)
        ceiling = min(ceiling, top)
    is_new = [o.to_place for o in movers]  # a new piece's index 0 is a placement, not 'stay'

    found: list[Alternative] = []
    first = (0,) * len(lists)
    heap, seen = [(0.0, first)], {first}
    timed_out = False
    floor = baseline.widest_route_cm if current else None  # an option must be wider than this
    best = floor  # the widest so far
    misses = 0  # layouts analysed since the last one found
    # Every combination is checked at one width (with a passing current layout, only a wider one
    # is of use; that implies the required width), so grow each footprint for it once. Merging
    # pieces grown one by one gives the same polygon as free_space growing their union.
    gw = (2 * r if floor is None else floor + 1) / 2
    W, H = scenario.room.width_cm, scenario.room.height_cm
    inner = box(gw, gw, W - gw, H - gw) if min(W, H) > 2 * gw else Polygon()
    fixed_grown = routing.grow(unary_union(fixed_rects), gw)
    grown = [[routing.grow(c.rect, gw) for c in cands] for cands in lists]
    entry = routing.entry_point(door, scenario.room, gw)
    while heap and len(found) < POOL and (floor is None or misses < POOL):
        if perf_counter() - t0 > options.time_limit_s:
            timed_out = True
            break
        if best is not None and best >= ceiling and (current or len(found) >= FEWEST_POOL):
            break  # nothing can be wider, and the fewest-changes option is settled
        _, idx = heapq.heappop(heap)
        moved = sum(i > 0 for i, n in zip(idx, is_new, strict=True) if not n)
        if moved > MAX_MOVED_OBJECTS:
            continue  # every successor moves at least as many objects
        for k in range(len(idx)):
            nxt = idx[:k] + (idx[k] + 1,) + idx[k + 1:]
            if nxt[k] < len(lists[k]) and nxt not in seen:
                seen.add(nxt)
                heapq.heappush(heap, (sum(lists[j][i].cost for j, i in enumerate(nxt)), nxt))
        if moved == 0 and not new:
            continue  # the unmoved layout is the baseline, analysed above
        considered += 1
        chosen = [lists[k][i] for k, i in enumerate(idx)]
        if not _compatible(chosen):
            continue
        free = inner.difference(
            unary_union([fixed_grown] + [grown[k][i] for k, i in enumerate(idx)]))
        if not _touches_all(free, entry, fixed_targets + [z for c in chosen for z in c.approach]):
            continue
        changed = [c for k, c in enumerate(chosen) if idx[k] > 0 or is_new[k]]
        positions = [ObjectPosition(object_id=c.obj.id, x_cm=c.obj.x_cm, y_cm=c.obj.y_cm,
                                    rotation_deg=c.obj.rotation_deg) for c in changed]
        layout = Layout(object_positions=positions)
        tested += 1
        misses += 1
        moved_scenario = apply_layout(scenario, layout)
        v = analyze(moved_scenario)
        if v.status != "pass":
            continue
        moves = [_move(c, by_id[c.obj.id]) for c in changed]
        if any(_near_duplicate(moves, alt.moves) for alt in found):
            continue
        # Measure the widest route only if it could be the widest so far; the rest are measured
        # at the end if chosen as the fewest-changes option.
        if best is None or floor is not None or reaches(chosen, best):
            v.widest_route_cm = widest_route(moved_scenario)
            if floor is not None and v.widest_route_cm <= floor:
                continue
            best = max(best or 0.0, v.widest_route_cm)
        length = _route_length(v, required)
        score = sum(c.cost for c in chosen) + ROUTE_LENGTH_WEIGHT * length
        misses = 0
        found.append(Alternative(
            id="", layout=layout, moves=moves, validation=v,
            cost=Cost(moved_objects=sum(not m.placed for m in moves),
                      displacement_cm=sum(m.distance_cm for m in moves),
                      route_length_cm=length, total_score=round(score, 1))))

    exhaustive = not heap and not timed_out and not truncated and len(movers) <= MAX_MOVED_OBJECTS
    # One option per goal: the fewest changes (the current layout when it passes) and the widest
    # route, the cheaper one on a tie. One layout can be both.
    fewest = current or min(found, key=lambda a: a.cost.total_score, default=None)
    widest = max(found, key=lambda a: (a.validation.widest_route_cm or 0, -a.cost.total_score),
                 default=fewest)
    if fewest and fewest.validation.widest_route_cm is None:
        fewest.validation.widest_route_cm = widest_route(apply_layout(scenario, fewest.layout))
    if timed_out and fewest:
        warnings.append("The search stopped at the time limit; other alternatives may exist.")
    if current and widest is current:
        return done("solutions_found", "The current layout already passes. No layout with a "
                    f"route wider than its {baseline.widest_route_cm:g} cm was found among "
                    "those tried.", [current])
    if fewest:
        fewest.best_for = ["fewest_changes"] + (["widest_route"] if widest is fewest else [])
        widest.best_for = fewest.best_for if widest is fewest else ["widest_route"]
        picked = [fewest] if widest is fewest else [fewest, widest]
        for n, alt in enumerate((a for a in picked if a is not current), 1):
            alt.id = f"alternative-{n}"
        n = len(found)
        if current:
            message = (f"The current layout already passes; nothing needs to move. Found {n} "
                       f"verified layout{'s' if n > 1 else ''} with a route wider than its "
                       f"{baseline.widest_route_cm:g} cm; showing the widest.")
        else:
            message = f"Found {n} verified alternative{'s' if n > 1 else ''}{placing}."
            if n > 1:
                message += (" The one with the fewest changes also has the widest route."
                            if widest is fewest else " Showing the one with the fewest changes "
                            "and the one with the widest route.")
        return done("solutions_found", message, picked)
    if exhaustive:
        return done("discretized_search_infeasible", f"No verified layout{placing} among the "
                    f"{options.grid_spacing_cm:g} cm grid placements tried. A valid arrangement "
                    "off this grid may still exist; try a finer grid or adjust the requirements.")
    return done("no_solution_found_within_budget", f"No verified solution{placing} was found "
                "within the search limits. Try moving a piece by hand, unlocking furniture, "
                "relaxing a requirement, or allowing more search time.")


def _move(c: Cand, before: Furniture) -> Move:
    """The change for one piece; a new piece is placed, so it has no distance to report."""
    to = {"to_x_cm": c.obj.x_cm, "to_y_cm": c.obj.y_cm, "to_rotation_deg": c.obj.rotation_deg}
    if before.to_place:
        return Move(object_id=c.obj.id, from_x_cm=c.obj.x_cm, from_y_cm=c.obj.y_cm,
                    from_rotation_deg=c.obj.rotation_deg, **to, distance_cm=0, placed=True)
    return Move(object_id=c.obj.id, from_x_cm=before.x_cm, from_y_cm=before.y_cm,
                from_rotation_deg=before.rotation_deg, **to,
                distance_cm=round(math.dist(_centre(c.rect), _centre(footprint(before))), 1))


def _near_duplicate(a: list[Move], b: list[Move]) -> bool:
    """Same pieces moved, same orientations, and every piece within DIVERSITY_CM."""
    if {m.object_id for m in a} != {m.object_id for m in b}:
        return False
    other = {m.object_id: m for m in b}
    return all(m.to_rotation_deg == other[m.object_id].to_rotation_deg
               and math.dist((m.to_x_cm, m.to_y_cm),
                             (other[m.object_id].to_x_cm, other[m.object_id].to_y_cm))
               <= DIVERSITY_CM
               for m in a)
