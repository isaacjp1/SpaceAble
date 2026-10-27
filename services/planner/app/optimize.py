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

from shapely.geometry import Point, Polygon

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
    """Placements for one movable object: (list with 'stay' first, truncated?)."""
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
                if (x, y, rot) == (o.x_cm, o.y_cm, o.rotation_deg):
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
                cost = (MOVE_PENALTY
                        + DISPLACEMENT_WEIGHT * math.dist(_centre(c.rect), _centre(stay.rect))
                        + ROTATION_PENALTY * (rot != o.rotation_deg)
                        + OFF_WALL_PENALTY * (not on_wall))
                out.append(Cand(c.obj, c.rect, c.approach, cost))
    out.sort(key=lambda c: (c.cost, c.obj.x_cm, c.obj.y_cm, c.obj.rotation_deg))
    return [stay] + out[:MAX_CANDIDATES_PER_OBJECT], len(out) > MAX_CANDIDATES_PER_OBJECT


def _compatible(chosen: list[Cand]) -> bool:
    """Movers must not overlap each other or each other's approach zones."""
    for a, b in combinations(chosen, 2):
        if (overlaps(a.rect, b.rect) or any(overlaps(a.rect, z) for z in b.approach)
                or any(overlaps(b.rect, z) for z in a.approach)):
            return False
    return True


def _connected(chosen, scenario, fixed_rects, fixed_targets, start, r) -> bool:
    """Necessary condition only: the entry's free-space component touches every target."""
    free = routing.free_space(scenario.room, fixed_rects + [c.rect for c in chosen], r)
    comp = routing.component_at(free, start)
    targets = fixed_targets + [z for c in chosen for z in c.approach]
    return comp is not None and all(comp.intersection(t).area > EPS for t in targets)


def _route_length(v: ValidationResult, required: set[str]) -> float:
    return sum(rt.length_cm or 0.0 for rt in v.routes if rt.destination_id in required)


def optimize(scenario: RoomScenario, options: OptimizeOptions) -> OptimizationResult:
    t0 = perf_counter()
    req = scenario.requirements
    required = set(req.required_destination_ids)
    baseline = analyze(scenario)
    warnings: list[str] = []
    if req.optimization_profile == "max_clearance":
        warnings.append("The max_clearance profile is not implemented yet; alternatives are "
                        "ranked by minimal changes.")
    tested = considered = 0
    exhaustive = False

    def done(status, message, alternatives=()) -> OptimizationResult:
        return OptimizationResult(
            status=status, message=message, alternatives=list(alternatives), baseline=baseline,
            warnings=warnings, search=SearchInfo(
                grid_spacing_cm=options.grid_spacing_cm, time_limit_s=options.time_limit_s,
                elapsed_s=round(perf_counter() - t0, 3), combinations_considered=considered,
                candidates_tested=tested, exhaustive=exhaustive))

    if baseline.status == "pass":
        length = _route_length(baseline, required)
        return done("solutions_found", "The current layout already passes; nothing needs to "
                    "move.", [
            Alternative(id="current", layout=Layout(), moves=[], validation=baseline,
                        cost=Cost(moved_objects=0, displacement_cm=0, route_length_cm=length,
                                  total_score=round(ROUTE_LENGTH_WEIGHT * length, 1)))])
    blocking = [c for c in baseline.checks if c.required and c.status in ("needs_input", "unknown")]
    if blocking:
        return done("needs_input", "Resolve these before optimizing: "
                    + " ".join(c.message for c in blocking))

    movers = [o for o in scenario.objects if o.movable and o.id not in req.locked_object_ids]
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

    found: list[Alternative] = []
    first = (0,) * len(lists)
    heap, seen = [(0.0, first)], {first}
    timed_out = False
    while heap and len(found) < options.max_alternatives:
        if perf_counter() - t0 > options.time_limit_s:
            timed_out = True
            break
        _, idx = heapq.heappop(heap)
        moved = sum(i > 0 for i in idx)
        if moved > MAX_MOVED_OBJECTS:
            continue  # every successor moves at least as many objects
        for k in range(len(idx)):
            nxt = idx[:k] + (idx[k] + 1,) + idx[k + 1:]
            if nxt[k] < len(lists[k]) and nxt not in seen:
                seen.add(nxt)
                heapq.heappush(heap, (sum(lists[j][i].cost for j, i in enumerate(nxt)), nxt))
        if moved == 0:
            continue  # the baseline already failed
        considered += 1
        chosen = [lists[k][i] for k, i in enumerate(idx)]
        if not _compatible(chosen) or not _connected(chosen, scenario, fixed_rects,
                                                     fixed_targets, start, r):
            continue
        positions = [ObjectPosition(object_id=c.obj.id, x_cm=c.obj.x_cm, y_cm=c.obj.y_cm,
                                    rotation_deg=c.obj.rotation_deg)
                     for k, c in enumerate(chosen) if idx[k] > 0]
        layout = Layout(object_positions=positions)
        tested += 1
        v = analyze(apply_layout(scenario, layout))
        if v.status != "pass":
            continue
        moves = [Move(object_id=c.obj.id, from_x_cm=by_id[c.obj.id].x_cm,
                      from_y_cm=by_id[c.obj.id].y_cm,
                      from_rotation_deg=by_id[c.obj.id].rotation_deg, to_x_cm=c.obj.x_cm,
                      to_y_cm=c.obj.y_cm, to_rotation_deg=c.obj.rotation_deg,
                      distance_cm=round(math.dist(_centre(c.rect),
                                                  _centre(footprint(by_id[c.obj.id]))), 1))
                 for k, c in enumerate(chosen) if idx[k] > 0]
        if any(_near_duplicate(moves, alt.moves) for alt in found):
            continue
        length = _route_length(v, required)
        score = sum(c.cost for c in chosen) + ROUTE_LENGTH_WEIGHT * length
        found.append(Alternative(
            id="", layout=layout, moves=moves, validation=v,
            cost=Cost(moved_objects=len(moves), displacement_cm=sum(m.distance_cm for m in moves),
                      route_length_cm=length, total_score=round(score, 1))))

    exhaustive = not heap and not timed_out and not truncated and len(movers) <= MAX_MOVED_OBJECTS
    found.sort(key=lambda a: a.cost.total_score)
    for n, alt in enumerate(found, 1):
        alt.id = f"alternative-{n}"
    if found:
        if timed_out:
            warnings.append("The search stopped at the time limit; other alternatives may exist.")
        return done("solutions_found", f"Found {len(found)} verified alternative"
                    f"{'s' if len(found) > 1 else ''}.", found)
    if exhaustive:
        return done("discretized_search_infeasible", "No verified layout among the "
                    f"{options.grid_spacing_cm:g} cm grid placements tried. A valid arrangement "
                    "off this grid may still exist; try a finer grid or adjust the requirements.")
    return done("no_solution_found_within_budget", "No verified solution was found within the "
                "search limits. Try moving a piece by hand, unlocking furniture, relaxing a "
                "requirement, or allowing more search time.")


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
