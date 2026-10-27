"""Deterministic layout validation. The only place pass/fail is decided."""

from itertools import combinations, pairwise
from math import dist
from time import perf_counter

from shapely.geometry import Point

from . import routing
from .geometry import approach_rect, footprint, inside, overlaps
from .models import (
    EPS,
    Check,
    Destination,
    Door,
    RoomScenario,
    RouteEvidence,
    TurningZone,
    ValidationResult,
    without_unplaced,
)


def _r1(v: float) -> float:
    return round(v, 1)


def analyze(scenario: RoomScenario, grid_cm: float = 5.0) -> ValidationResult:
    t0 = perf_counter()
    unplaced = [o.id for o in scenario.objects if o.to_place]
    scenario = without_unplaced(scenario)  # new pieces with no position yet are not in the room
    room, req = scenario.room, scenario.requirements
    objs = {o.id: o for o in scenario.objects}
    fps = {i: footprint(o) for i, o in objs.items()}
    rects = list(fps.values())
    checks: list[Check] = []
    warnings: list[str] = []
    if unplaced:
        checks.append(Check(
            id="unplaced-objects", status="not_checked", required=False, object_ids=unplaced,
            message=f"Not placed yet: {', '.join(unplaced)}. Optimize looks for a place."))

    unconfirmed = [o.id for o in scenario.objects if not o.confirmed]
    unconfirmed += [d.id for d in scenario.doors if not d.confirmed]
    checks.append(Check(
        id="measurements-confirmed", status="needs_input" if unconfirmed else "pass",
        object_ids=unconfirmed,
        message=(f"Unconfirmed measurements: {', '.join(unconfirmed)}. "
                 "Results are provisional until they are confirmed." if unconfirmed
                 else "All dimensions are marked as confirmed by the user.")))

    outside = [i for i, f in fps.items() if not inside(f, room)]
    checks.append(Check(
        id="object-containment", status="fail" if outside else "pass", object_ids=outside,
        message=(f"Outside the room boundary: {', '.join(outside)}." if outside
                 else "All furniture lies inside the room.")))

    pairs = [(a, b) for a, b in combinations(fps, 2) if overlaps(fps[a], fps[b])]
    checks.append(Check(
        id="object-collision", status="fail" if pairs else "pass",
        object_ids=sorted({i for p in pairs for i in p}),
        message=("Overlapping furniture: " + "; ".join(f"{a} / {b}" for a, b in pairs) + "."
                 if pairs else "Furniture footprints do not overlap.")))

    door = scenario.start_door()
    checks.append(_door_check(door, req.door_min_clear_width_cm))

    if not req.required_destination_ids:
        checks.append(Check(id="destinations-selected", status="needs_input",
                            message="Select at least one required destination to check a route."))

    # Shared route state: one free space and one entry component for every destination.
    r = req.route_width_cm / 2 if req.route_width_cm else None
    start = free = comp = None
    if door and door.clear_width_cm and r:
        start = routing.entry_point(door, room, r)
        free = routing.free_space(room, rects, r)
        comp = routing.component_at(free, start)

    routes: list[RouteEvidence] = []
    for dest in scenario.destinations:
        required = dest.id in req.required_destination_ids
        rect = approach_rect(dest, objs[dest.object_id])
        blockers = [i for i, f in fps.items() if overlaps(rect, f)]
        in_room = inside(rect, room)
        problems = ([] if in_room else ["extends past a wall"]) + (
            [f"overlaps {', '.join(blockers)}"] if blockers else [])
        checks.append(Check(
            id=f"approach-{dest.id}", status="fail" if problems else "pass", required=required,
            object_ids=blockers,
            message=(f"Approach zone for {dest.id} " + " and ".join(problems) + "." if problems
                     else f"Approach zone for {dest.id} "
                          f"({dest.approach_width_cm:g}×{dest.approach_depth_cm:g} cm) is clear.")))
        check, ev = _route(scenario, dest, rect, door, r, start, free, comp, rects, grid_cm,
                           warnings)
        check.required = required
        checks.append(check)
        routes.append(ev)

    turning_check, zones = _turning(scenario, door, r, comp, rects)
    checks.append(turning_check)

    statuses = {c.status for c in checks if c.required}
    status = ("fail" if "fail" in statuses
              else "needs_input" if statuses & {"needs_input", "unknown"} else "pass")

    return ValidationResult(
        status=status, checks=checks, routes=routes, turning_zones=zones,
        reachable_area=[routing.rings(comp)] if comp is not None else [],
        assumptions=_assumptions(r, grid_cm), warnings=warnings, grid_cm=grid_cm,
        elapsed_ms=_r1((perf_counter() - t0) * 1000))


def _door_check(door: Door | None, required: float | None) -> Check:
    if door is None:
        return Check(id="door-clearance", status="needs_input",
                     message="Add a door so a route can start from it.")
    if door.clear_width_cm is None or required is None:
        missing = "door clear width" if door.clear_width_cm is None else "minimum door width"
        return Check(id="door-clearance", status="needs_input", object_ids=[door.id],
                     message=f"Enter the {missing} to check {door.id}.")
    ok = door.clear_width_cm >= required - EPS
    return Check(
        id="door-clearance", status="pass" if ok else "fail", object_ids=[door.id],
        measured_cm=door.clear_width_cm, required_cm=required,
        message=(f"{door.id} clear opening {door.clear_width_cm:g} cm "
                 f"{'meets' if ok else 'is below'} the configured {required:g} cm minimum."))


def _route(scenario, dest: Destination, rect, door, r, start, free, comp, rects, grid,
           warnings) -> tuple[Check, RouteEvidence]:
    cid = f"route-{door.id if door else 'door'}-to-{dest.id}"
    ev = RouteEvidence(destination_id=dest.id, door_id=door.id if door else None,
                       status="needs_input", target_rect=rect.bounds)

    def result(status, message, **kw) -> tuple[Check, RouteEvidence]:
        ev.status = status
        return Check(id=cid, status=status, message=message,
                     required_cm=2 * r if r else None, **kw), ev

    if door is None:
        return result("needs_input", "Add a door to check routes.")
    if door.clear_width_cm is None:
        return result("needs_input", f"Enter the clear width of {door.id} to locate the entry.")
    if r is None:
        return result("needs_input", f"Set a route width to check the route to {dest.id}.")
    w, room = 2 * r, scenario.room
    ev.start = start
    if free.is_empty:
        return result("fail", f"A {w:g} cm route cannot fit in a {room.width_cm:g}×"
                              f"{room.height_cm:g} cm room even when it is empty.")
    if comp is None:
        near = [o.id for o, f in zip(scenario.objects, rects, strict=True)
                if f.distance(Point(start)) < r]
        return result("fail", f"The entry point inside {door.id} does not have {w:g} cm of "
                              f"clearance" + (f" (blocked by {', '.join(near)})." if near else "."),
                      object_ids=near)

    path = routing.grid_route(free, start, rect, grid)
    if path is not None and not routing.segments_covered(free, path):
        warnings.append(f"{cid}: a grid path failed segment verification and was discarded.")
        path = None
    if path is None:
        if comp.intersection(rect).area > EPS:
            warnings.append(f"{cid}: the free-space polygon touches the approach zone but no grid "
                            f"path was found; a passage narrower than the {grid:g} cm grid can "
                            "resolve may exist. Try a finer grid.")
        return result("fail", f"No verified {w:g} cm route from {door.id} to the {dest.id} "
                              f"approach zone under this geometry (grid {grid:g} cm).")

    cl = routing.clearance(path, room, rects)
    ev.polyline = path
    ev.length_cm = _r1(sum(dist(a, b) for a, b in pairwise(path)))
    ev.min_clearance_cm = _r1(cl)
    if cl < r - EPS:  # independent exact check against the original rectangles
        warnings.append(f"{cid}: path clearance {cl:.2f} cm is below the {r:g} cm radius.")
        return result("fail", f"The candidate route to {dest.id} failed the exact clearance check.")
    return result("pass", f"Verified {w:g} cm route to {dest.id}, {ev.length_cm:g} cm long. "
                          f"Closest wall or furniture: {cl:.1f} cm from the route centreline.",
                  measured_cm=_r1(2 * cl))


def _turning(scenario, door, r, comp, rects) -> tuple[Check, list[TurningZone]]:
    room = scenario.room
    d = scenario.requirements.turning_diameter_cm
    if d is None:
        return Check(id="turning-space", status="not_checked",
                     message="No turning diameter configured; turning space was not checked."), []
    if d >= min(room.width_cm, room.height_cm):
        return Check(id="turning-space", status="fail", required_cm=d,
                     message=f"A {d:g} cm circle cannot fit in a {room.width_cm:g}×"
                             f"{room.height_cm:g} cm room even when it is empty."), []
    found = routing.turning_center(room, rects, d / 2, comp)
    if found is None or found[1] < d / 2 - EPS:
        return Check(id="turning-space", status="fail", required_cm=d,
                     message=f"No position fits a {d:g} cm turning circle with the current "
                             "furniture."), []
    (cx, cy), cl, reach = found
    zone = TurningZone(center=(_r1(cx), _r1(cy)), diameter_cm=d, reachable=reach)
    where = f"A {d:g} cm circle fits at ({cx:.0f}, {cy:.0f})"
    measured = {"measured_cm": _r1(2 * cl), "required_cm": d}
    if reach:
        return Check(id="turning-space", status="pass", **measured,
                     message=f"{where} and is reachable from {door.id}. The largest circle at "
                             f"that centre is {2 * cl:.0f} cm."), [zone]
    if r is None or door is None or door.clear_width_cm is None:
        return Check(id="turning-space", status="needs_input", **measured,
                     message=f"{where}; reachability needs a door and route width."), [zone]
    return Check(id="turning-space", status="fail", **measured,
                 message=f"{where}, but no {2 * r:g} cm route from {door.id} reaches it."), [zone]


def _assumptions(r: float | None, grid: float) -> list[str]:
    return [
        "2D floor geometry only; furniture heights, knee/toe clearance and protrusions are "
        "not modelled.",
        "Furniture is modelled as axis-aligned rectangles from the entered dimensions.",
        "The moving person/device is approximated as a circle the width of the route "
        "(translation only, no wheelchair kinematics).",
        (f"Routes start {r + routing.ENTRY_MARGIN_CM:g} cm inside the door opening. "
         if r else "") + "Door swing and door maneuvering clearance are not modelled.",
        f"Routes are searched on a {grid:g} cm grid. A passage narrower than the grid can "
        "resolve may be reported as no route. A reported route is always verified.",
        "Passing means the configured geometric checks pass. It is not an accessibility "
        "certification or a safety guarantee.",
    ]
