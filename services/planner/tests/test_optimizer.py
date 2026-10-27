"""Optimizer: locked pieces, impossible cases, timeouts and determinism."""

from fastapi.testclient import TestClient

from app.analyze import analyze
from app.main import app
from app.models import OptimizeOptions, apply_layout
from app.optimize import _near_duplicate, optimize, widest_route
from helpers import dest, load, make, obj

OPTS = OptimizeOptions()
VOLATILE = {"elapsed_ms"}


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
    (alt,) = r.alternatives
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
        time_limit_s=1e-9, grid_spacing_cm=20.0, max_alternatives=3))
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


def test_max_clearance_ranks_by_verified_width():
    s = load("canonical-bedroom")
    s.requirements.optimization_profile = "max_clearance"
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and r.warnings == []
    widths = [a.cost.widest_route_cm for a in r.alternatives]
    assert widths == sorted(widths, reverse=True)
    fewest = optimize(load("canonical-bedroom"), OPTS).alternatives
    assert widths[0] >= max(a.cost.widest_route_cm for a in fewest)
    for i, a in enumerate(r.alternatives):
        assert _at_width(apply_layout(s, a.layout), a.cost.widest_route_cm).status == "pass"
        for wider in r.alternatives[:i]:  # never more pieces moved for no extra width
            assert not {m.object_id for m in wider.moves} <= {m.object_id for m in a.moves}


def test_max_clearance_on_a_passing_layout_only_offers_wider_routes():
    s = load("feasible-bedroom")
    s.requirements.optimization_profile = "max_clearance"
    current = widest_route(s)
    r = optimize(s, OPTS)
    assert r.status == "solutions_found" and r.alternatives
    assert all(a.moves and a.cost.widest_route_cm > current for a in r.alternatives)
    assert f"{current:g} cm" in r.message


def test_max_clearance_keeps_the_current_layout_when_nothing_can_move():
    s = load("feasible-bedroom")
    s.requirements.optimization_profile = "max_clearance"
    s.requirements.locked_object_ids = [o.id for o in s.objects]
    r = optimize(s, OPTS)
    (alt,) = r.alternatives
    assert r.status == "solutions_found" and alt.id == "current"
    assert alt.cost.widest_route_cm == widest_route(s)
