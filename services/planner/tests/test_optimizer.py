"""Optimizer: locked pieces, impossible cases, timeouts and determinism."""

from fastapi.testclient import TestClient

from app.analyze import analyze
from app.main import app
from app.models import OptimizeOptions, apply_layout
from app.optimize import _near_duplicate, optimize
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
