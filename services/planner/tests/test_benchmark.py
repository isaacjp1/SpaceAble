"""Benchmark smoke run: every reported result must survive independent re-verification."""

from app.benchmark import NAMED, named, procedural, run


def test_no_verification_mismatches():
    rooms = [named(n) for n in NAMED] + [procedural(seed) for seed in (1, 2, 3, 6)]
    rows = run(rooms, time_limit_s=3)
    assert [p for r in rows for p in r["problems"]] == []
    by = {r["fixture"]: r for r in rows}
    assert by["canonical-bedroom"]["search_status"] == "solutions_found"
    assert by["feasible-bedroom"]["moved_objects"] == 0
    assert by["locked-impossible"]["exhaustive"] is True
    assert by["unconfirmed-input"]["search_status"] == "needs_input"
