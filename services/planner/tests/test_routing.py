"""Routes, corridors, corner cutting, turning circles and missing measurements."""

import pytest
from shapely.geometry import Point, box
from shapely.ops import unary_union

from app import routing
from app.analyze import analyze
from app.geometry import footprint
from helpers import check, dest, load, make, obj, route_check

DESK = obj("desk", 520, 100, 60, 100)  # against the right wall of a 600 cm room
DESK_DEST = dest("d", "desk", "left")


def corridor(gap: float, route: float = 80):
    """Partition at x 250-350 with a centred gap; the door is left, the desk right."""
    a = 150 - gap / 2
    return make([obj("top", 250, 0, 100, a), obj("bottom", 250, a + gap, 100, 300 - a - gap),
                 DESK], [DESK_DEST], room=(600, 300), route=route)


def assert_route_verified(scenario, result):
    """Every returned segment lies in free-center space and keeps r from all rectangles."""
    r = scenario.requirements.route_width_cm / 2
    rects = [footprint(o) for o in scenario.objects]
    free = routing.free_space(scenario.room, rects, r)
    for ev in result.routes:
        if ev.status == "pass":
            assert len(ev.polyline) >= 2
            assert routing.segments_covered(free, ev.polyline)
            assert routing.clearance(ev.polyline, scenario.room, rects) >= r - 1e-6
            assert ev.min_clearance_cm >= r


def test_fully_blocked_destination():
    s = make([obj("wardrobe", 200, 0, 60, 300), obj("desk", 340, 100, 60, 100)],
             [dest("d", "desk", "left")])
    r = analyze(s)
    c = route_check(r, "d")
    assert c.status == "fail" and r.status == "fail"
    assert r.routes[0].polyline == []
    target = box(*r.routes[0].target_rect)
    assert all(max(x for x, _ in poly[0]) < target.bounds[0] for poly in r.reachable_area)


@pytest.mark.parametrize("gap, expected", [(70, "fail"), (79, "fail"), (100, "pass"),
                                           (140, "pass")])
def test_corridor_width(gap, expected):
    s = corridor(gap)
    r = analyze(s)
    assert route_check(r, "d").status == expected
    assert_route_verified(s, r)
    if expected == "pass":
        assert route_check(r, "d").measured_cm >= 80


def test_grid_does_not_cut_a_diagonal_pinch():
    # Two free squares that only touch at (52.5, 52.5). The diagonal grid edge
    # (50,50)->(55,55) is `covered` by the union, so only the corner rule stops it.
    pinch = unary_union([box(0, 0, 52.5, 52.5), box(52.5, 52.5, 100, 100)])
    assert routing.grid_route(pinch, (25, 25), box(60, 60, 100, 100), 5) is None
    overlap = unary_union([box(0, 0, 52.5, 52.5), box(45, 45, 100, 100)])
    assert routing.grid_route(overlap, (25, 25), box(60, 60, 100, 100), 5) is not None


def test_diagonal_furniture_gap_is_not_traversable():
    s = make([obj("a", 100, 0, 100, 150), obj("b", 210, 160, 100, 140),
              obj("shelf", 330, 0, 70, 40)], [dest("d", "shelf", "bottom", w=60)])
    assert route_check(analyze(s), "d").status == "fail"


@pytest.mark.parametrize("name", ["feasible-bedroom"])
def test_route_segments_inside_free_space(name):
    s = load(name)
    r = analyze(s)
    assert r.status == "pass"
    assert_route_verified(s, r)


def test_entry_blocked_names_the_obstacle():
    r = analyze(make([obj("dresser", 0, 120, 60, 50), DESK], [DESK_DEST], room=(600, 300)))
    c = route_check(r, "d")
    assert c.status == "fail" and c.object_ids == ["dresser"] and r.reachable_area == []


def test_route_wider_than_room_is_explicitly_impossible():
    r = analyze(make([DESK], [DESK_DEST], room=(600, 300), route=300))
    assert "even when it is empty" in route_check(r, "d").message


def test_sub_grid_passage_warns_instead_of_claiming_impossible():
    s = corridor(82)  # 2 cm wide strip of valid centres
    coarse = analyze(s, grid_cm=25)
    assert route_check(coarse, "d").status == "fail"
    assert any("finer grid" in w for w in coarse.warnings)
    assert route_check(analyze(s, grid_cm=5), "d").status == "pass"


def test_turning_circle():
    empty = make(room=(400, 300), turning=310, required=[])
    assert "even when it is empty" in check(analyze(empty), "turning-space").message

    s = make([obj("desk", 0, 0, 120, 60)], turning=150, required=[])
    r = analyze(s)
    c = check(r, "turning-space")
    assert c.status == "pass" and c.measured_cm >= 150
    (cx, cy), = [z.center for z in r.turning_zones]
    disk = Point(cx, cy).buffer(75)
    assert box(0, 0, 400, 300).contains(disk) and not disk.intersects(box(0, 0, 120, 60))

    # fits only on the far side of a full-height partition, so it is unreachable
    pocket = make([obj("wall", 150, 0, 20, 300)], turning=200, required=[])
    r = analyze(pocket)
    assert check(r, "turning-space").status == "fail"
    assert r.turning_zones[0].reachable is False


def test_missing_measurements_never_pass():
    s = make([DESK], [DESK_DEST], room=(600, 300), route=None)
    r = analyze(s)
    assert route_check(r, "d").status == "needs_input" and r.status == "needs_input"

    no_door_width = make([DESK], [DESK_DEST], room=(600, 300), doors=[
        {"id": "door", "wall": "left", "offset_cm": 100, "confirmed": True}])
    r = analyze(no_door_width)
    assert check(r, "door-clearance").status == "needs_input" and r.status == "needs_input"

    unconfirmed = make([{**DESK, "confirmed": False}], [DESK_DEST], room=(600, 300))
    r = analyze(unconfirmed)
    assert route_check(r, "d").status == "pass"
    assert check(r, "measurements-confirmed").status == "needs_input"
    assert r.status == "needs_input"

    assert analyze(make([DESK], [DESK_DEST], room=(600, 300), required=[])).status == "needs_input"

    r = analyze(make([DESK], [DESK_DEST], room=(600, 300)))
    assert check(r, "turning-space").status == "not_checked" and r.status == "pass"


def test_canonical_bedroom_fails_for_the_dresser_and_manual_fix_passes():
    r = analyze(load("canonical-bedroom"))
    assert r.status == "fail"
    assert check(r, "approach-desk-approach").object_ids == ["dresser"]
    assert route_check(r, "desk-approach").status == "fail"
    assert check(r, "object-collision").status == "pass"

    fixed = analyze(load("feasible-bedroom"))
    assert fixed.status == "pass"
    assert route_check(fixed, "desk-approach").status == "pass"


def test_deterministic():
    s = load("canonical-bedroom")
    a, b = analyze(s), analyze(s)
    assert a.model_dump(exclude={"elapsed_ms"}) == b.model_dump(exclude={"elapsed_ms"})
