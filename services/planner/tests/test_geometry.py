"""Geometry: containment, collisions, rotation, door width, approach zones."""

from app.analyze import analyze
from app.geometry import approach_rect, footprint
from app.models import Destination, Furniture
from helpers import check, dest, make, obj, route_check


def test_partly_outside_room_fails():
    r = analyze(make([obj("desk", 350, 50, 100, 60)]))
    c = check(r, "object-containment")
    assert c.status == "fail" and c.object_ids == ["desk"] and r.status == "fail"


def test_overlap_fails():
    r = analyze(make([obj("a", 100, 100, 100, 50), obj("b", 150, 120, 100, 50)]))
    c = check(r, "object-collision")
    assert c.status == "fail" and c.object_ids == ["a", "b"]


def test_touching_edges_allowed():
    r = analyze(make([obj("a", 100, 100, 100, 50), obj("b", 200, 100, 100, 50),
                      obj("c", 100, 150, 100, 50)]))
    assert check(r, "object-collision").status == "pass"


def test_rotation_swaps_footprint_and_turns_approach_side():
    o = Furniture.model_validate(obj("desk", 100, 50, 110, 65, rot=90))
    assert footprint(o).bounds == (100, 50, 165, 160)
    assert footprint(o.model_copy(update={"rotation_deg": 180})).bounds == (100, 50, 210, 115)
    d = Destination.model_validate(dest("a", "desk", "bottom"))
    # rotating 90 deg clockwise moves the unrotated bottom edge to the left
    assert approach_rect(d, o).bounds == (10, 65, 100, 145)


def test_door_just_below_and_exactly_at_minimum():
    def door(width):
        return [{"id": "door", "wall": "left", "offset_cm": 100, "clear_width_cm": width,
                 "confirmed": True}]
    assert check(analyze(make(doors=door(79.9))), "door-clearance").status == "fail"
    c = check(analyze(make(doors=door(80))), "door-clearance")
    assert c.status == "pass" and c.measured_cm == 80 and c.required_cm == 80


def test_route_width_is_not_applied_across_the_doorway():
    # 100 cm route through a 90 cm door: the door has its own check, the route starts inside.
    s = make([obj("desk", 300, 100, 60, 100)], [dest("d", "desk", "left")], route=100)
    r = analyze(s)
    assert check(r, "door-clearance").status == "pass"
    assert route_check(r, "d").status == "pass"
    assert r.routes[0].start == (51, 145)


def test_approach_zone_in_wall_or_furniture_fails_and_clear_zone_passes():
    against_wall = make([obj("desk", 150, 240, 100, 60)], [dest("d", "desk", "bottom")])
    c = check(analyze(against_wall), "approach-d")
    assert c.status == "fail" and "wall" in c.message

    blocked = make([obj("desk", 150, 0, 100, 60), obj("chair", 170, 80, 40, 40)],
                   [dest("d", "desk", "bottom")])
    c = check(analyze(blocked), "approach-d")
    assert c.status == "fail" and c.object_ids == ["chair"]

    clear = make([obj("desk", 150, 0, 100, 60)], [dest("d", "desk", "bottom")])
    r = analyze(clear)
    assert check(r, "approach-d").status == "pass"
    assert route_check(r, "d").status == "pass" and r.status == "pass"
