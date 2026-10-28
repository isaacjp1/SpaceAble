"""Optimizer: locked pieces, impossible cases, timeouts and determinism."""

from fastapi.testclient import TestClient

from app.analyze import analyze
from app.benchmark import procedural
from app.main import app
from app.models import OptimizeOptions, RoomScenario, apply_layout
from app.optimize import POOL, _near_duplicate, optimize, widest_route
from helpers import check, dest, load, make, obj, route_check

OPTS = OptimizeOptions()
VOLATILE = {"elapsed_ms", "widest_route_cm"}  # widest is added after analyze()


def stable(v):
    return v.model_dump(exclude=VOLATILE)


def test_canonical_alternatives_are_independently_valid():
    s = load("canonical-bedroom")
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and r.baseline.status == "fail"
    assert 1 <= len(r.alternatives) <= 3
    for alt in r.alternatives:
        assert alt.validation.status == "pass"
        # re-run the validator on exactly the returned layout
        again = analyze(apply_layout(s, alt.layout))
        assert again.status == "pass" and stable(again) == stable(alt.validation)
        assert {m.object_id for m in alt.moves} <= {"desk", "dresser"}  # bed is locked
        assert alt.cost.moved_objects == len(alt.moves) >= 1
    scores = [a.cost.total_score for a in r.alternatives]
    assert scores == sorted(scores)
    for i, a in enumerate(r.alternatives):
        for b in r.alternatives[i + 1:]:
            assert not _near_duplicate(a.moves, b.moves)


def test_locked_objects_never_move():
    s = load("canonical-bedroom")
    s.requirements.locked_object_ids = ["bed", "desk"]
    r = optimize(s, OPTS)
    assert r.status == "solutions_found"
    assert all(m.object_id == "dresser" for a in r.alternatives for m in a.moves)


def test_already_valid_layout_is_not_moved():
    r = optimize(load("feasible-bedroom"), OPTS)
    assert r.status == "solutions_found"
    alt = r.alternatives[0]  # the fewest changes; a wider-route option may follow
    assert alt.id == "current" and alt.moves == [] and alt.cost.moved_objects == 0


def test_nothing_movable_is_reported_without_crash():
    s = load("canonical-bedroom")
    s.requirements.locked_object_ids = ["bed", "desk", "dresser"]
    r = optimize(s, OPTS)
    assert r.status == "discretized_search_infeasible" and r.alternatives == []
    assert "No furniture is allowed to move" in r.message


def test_failures_furniture_cannot_fix_are_explained():
    s = load("canonical-bedroom")
    s.requirements.turning_diameter_cm = 400  # bigger than the room
    r = optimize(s, OPTS)
    assert r.status == "discretized_search_infeasible"
    assert "even when it is empty" in r.message and r.search.candidates_tested == 0

    s = load("canonical-bedroom")
    s.requirements.door_min_clear_width_cm = 95  # door is 90
    r = optimize(s, OPTS)
    assert r.status == "discretized_search_infeasible" and "door-1" in r.message


def test_missing_measurements_need_input():
    s = load("canonical-bedroom")
    s.requirements.route_width_cm = None
    assert optimize(s, OPTS).status == "needs_input"
    s = load("canonical-bedroom")
    s.objects[2].confirmed = False
    r = optimize(s, OPTS)
    assert r.status == "needs_input" and "dresser" in r.message


def test_timeout_is_never_reported_as_infeasible():
    r = optimize(load("canonical-bedroom"), OptimizeOptions.model_construct(
        time_limit_s=1e-9, grid_spacing_cm=20.0))
    assert r.status == "no_solution_found_within_budget"
    assert r.search.exhaustive is False and r.alternatives == []


def test_exhaustive_search_without_a_solution():
    # Every grid placement of the 100 cm box either covers the entry point,
    # overlaps the fixed desk, or overlaps the desk's approach zone.
    s = make([obj("desk", 240, 50, 60, 100, movable=False), obj("box", 100, 50, 100, 100)],
             [dest("d", "desk", "left")], room=(300, 200),
             doors=[{"id": "door", "wall": "left", "offset_cm": 55, "clear_width_cm": 90,
                     "confirmed": True}])
    r = optimize(s, OPTS)
    assert r.status == "discretized_search_infeasible" and r.search.exhaustive is True
    assert "may still exist" in r.message


def test_deterministic_and_fast():
    s = load("canonical-bedroom")
    a, b = optimize(s, OPTS), optimize(s, OPTS)
    def key(r):
        return [(x.moves, x.cost) for x in r.alternatives]
    assert key(a) == key(b)
    assert a.search.elapsed_s < 5  # measured ~0.2 s on the dev machine; loose bound


def test_optimize_endpoint():
    client = TestClient(app)
    body = {"scenario": load("canonical-bedroom").model_dump(mode="json")}
    r = client.post("/v1/planner/optimize", json=body)
    assert r.status_code == 200 and r.json()["status"] == "solutions_found"
    r = client.post("/v1/planner/optimize", json={**body, "options": {"time_limit_s": 0.1}})
    assert r.status_code == 422 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_entry_blocked_by_locked_furniture_is_explained_not_searched():  # found by the benchmark
    # Locked bed against the door wall; the only required destination belongs to a mover.
    s = make([obj("bed", 0, 120, 140, 200), obj("desk", 300, 40, 120, 60),
              obj("chair", 300, 200, 50, 50)], [dest("d", "desk", "bottom")], room=(500, 320),
             doors=[{"id": "door", "wall": "left", "offset_cm": 165, "clear_width_cm": 85,
                     "confirmed": True}], route=90)
    s.requirements.locked_object_ids = ["bed"]
    r = optimize(s, OPTS)
    assert r.status == "discretized_search_infeasible"
    assert "bed" in r.message and r.search.combinations_considered == 0


def _at_width(s, w):
    return analyze(s.model_copy(update={
        "requirements": s.requirements.model_copy(update={"route_width_cm": w})}))


def test_widest_route_matches_a_fixed_gap():
    # Built-ins leave a 100 cm gap. Footprints are padded slightly (conservative), so 99 cm.
    s = load("wide-corridor")
    assert widest_route(s) == 99.0
    assert _at_width(s, 99).status == "pass" and _at_width(s, 100).status == "fail"


def test_optimize_offers_the_fewest_changes_and_the_widest_route():
    s = load("canonical-bedroom")
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and r.warnings == []
    fewest, widest = r.alternatives  # the sample has a wider layout than its cheapest one
    assert (fewest.best_for, widest.best_for) == (["fewest_changes"], ["widest_route"])
    assert fewest.cost.total_score < widest.cost.total_score
    assert widest.validation.widest_route_cm > fewest.validation.widest_route_cm
    for a in r.alternatives:
        assert _at_width(apply_layout(s, a.layout), a.validation.widest_route_cm).status == "pass"


def test_a_passing_layout_is_the_fewest_changes_and_only_a_wider_route_is_offered():
    s = load("feasible-bedroom")
    current = widest_route(s)
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and f"{current:g} cm" in r.message
    kept, wider = r.alternatives
    assert kept.id == "current" and kept.best_for == ["fewest_changes"]
    assert wider.moves and wider.best_for == ["widest_route"]
    assert wider.validation.widest_route_cm > current


def test_the_current_layout_is_both_when_nothing_can_move():
    s = load("feasible-bedroom")
    s.requirements.locked_object_ids = [o.id for o in s.objects]
    r = optimize(s, OPTS)
    (alt,) = r.alternatives
    assert r.status == "solutions_found" and alt.id == "current"
    assert alt.best_for == ["fewest_changes", "widest_route"]
    assert alt.validation.widest_route_cm == widest_route(s)


def test_the_search_stops_once_it_cannot_get_wider():
    # No spot for one of the movers allows a wider route than this room already has: proven at once.
    r = optimize(procedural(13), OPTS)
    assert [a.id for a in r.alternatives] == ["current"] and r.search.combinations_considered == 0
    # Here only the full check can tell, so the search gives up after POOL misses in a row.
    r = optimize(procedural(5), OPTS)
    assert [a.id for a in r.alternatives] == ["current"] and r.search.candidates_tested == POOL
    assert r.warnings == []


def _with_new(name, size, approach_side=None, at=(0, 0)):
    """A fixture plus a hypothetical shelf that has no position yet."""
    d = load(name).model_dump(mode="json")
    d["objects"].append(obj("shelf", *at, *size, kind="shelf", label="Shelf", to_place=True))
    if approach_side:
        d["destinations"].append(dest("shelf-approach", "shelf", approach_side))
        d["requirements"]["required_destination_ids"].append("shelf-approach")
    return RoomScenario.model_validate(d)


def test_analyze_leaves_a_new_piece_out_and_says_so():
    s = _with_new("canonical-bedroom", (100, 40), at=(260, 65))  # on top of the bed
    v = analyze(s)
    assert check(v, "object-collision").status == "pass"
    unplaced = check(v, "unplaced-objects")
    assert unplaced.status == "not_checked" and not unplaced.required
    assert unplaced.object_ids == ["shelf"]
    assert v.status == analyze(load("canonical-bedroom")).status


def test_a_new_piece_is_placed_in_every_option_and_rechecked():
    s = _with_new("canonical-bedroom", (100, 40))
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and "with a place for the new Shelf" in r.message
    for alt in r.alternatives:
        placed = [m for m in alt.moves if m.placed]
        assert [m.object_id for m in placed] == ["shelf"] and placed[0].distance_cm == 0
        assert alt.cost.moved_objects == len(alt.moves) - 1
        moved = apply_layout(s, alt.layout)
        assert not any(o.to_place for o in moved.objects)
        again = analyze(moved)  # the independent re-check includes the shelf
        assert again.status == "pass" and stable(again) == stable(alt.validation)
        assert all(c.id != "unplaced-objects" for c in again.checks)


def test_a_passing_room_still_searches_for_a_place_for_a_new_piece():
    s = _with_new("feasible-bedroom", (100, 50), approach_side="bottom")
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and r.alternatives[0].id != "current"
    for alt in r.alternatives:
        assert any(m.placed for m in alt.moves)
        assert route_check(alt.validation, "shelf-approach").status == "pass"


def test_a_new_piece_too_big_for_the_room_is_reported():
    r = optimize(_with_new("canonical-bedroom", (500, 500)), OPTS)
    assert r.status == "discretized_search_infeasible" and "No spot for the new Shelf" in r.message


def test_an_unplaced_piece_does_not_narrow_the_widest_route():
    s = _with_new("feasible-bedroom", (100, 40), approach_side="bottom")  # nominally at (0, 0)
    body = TestClient(app).post("/v1/planner/analyze",
                                json={"scenario": s.model_dump(mode="json")}).json()
    assert body["status"] == "pass"
    assert body["widest_route_cm"] == widest_route(load("feasible-bedroom")) > 80
