import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.models import RoomScenario
from helpers import FIXTURES, load

SCHEMA = FIXTURES.parent / "schemas" / "room-scenario.schema.json"


def raw(name="canonical-bedroom") -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


@pytest.mark.parametrize("name", ["canonical-bedroom", "feasible-bedroom"])
def test_fixture_roundtrip(name):
    s = load(name)
    again = RoomScenario.model_validate_json(s.model_dump_json())
    assert again == s
    assert s.objects[0].x_cm == raw(name)["objects"][0]["x_cm"]


def mutate(fn) -> dict:
    d = raw()
    fn(d)
    return d


@pytest.mark.parametrize("bad, fragment", [
    (lambda d: d["objects"][0].update(rotation_deg=45), "rotation_deg"),
    (lambda d: d["objects"][0].update(x_cm=float("nan")), "x_cm"),
    (lambda d: d["objects"][0].update(width_cm=float("inf")), "width_cm"),
    (lambda d: d["objects"][0].update(x_cm=-1), "x_cm"),
    (lambda d: d["objects"][0].update(width_cm=0), "width_cm"),
    (lambda d: d["objects"][1].update(id="bed"), "Duplicate object id"),
    (lambda d: d["destinations"][0].update(object_id="sofa"), "Unknown destination"),
    (lambda d: d["requirements"].update(locked_object_ids=["ghost"]), "Unknown locked object"),
    (lambda d: d["requirements"].update(required_destination_ids=["x"]), "Unknown required"),
    (lambda d: d["requirements"].update(start_door_id="door-9"), "Unknown start door"),
    (lambda d: d["doors"][0].update(offset_cm=300), "extends beyond"),
    (lambda d: d["objects"][0].update(colour="red"), "colour"),
    (lambda d: d.update(objects=[{**d["objects"][0], "id": f"o{i}"} for i in range(41)]),
     "objects"),
    (lambda d: d["room"].update(width_cm=5000), "width_cm"),
])
def test_rejects_invalid(bad, fragment):
    with pytest.raises(ValidationError) as e:
        RoomScenario.model_validate(mutate(bad))
    assert fragment in str(e.value)


def test_rotation_90_float_is_accepted_not_rounded():
    d = mutate(lambda d: d["objects"][0].update(rotation_deg=90.0))
    assert RoomScenario.model_validate(d).objects[0].rotation_deg == 90
    with pytest.raises(ValidationError):
        RoomScenario.model_validate(mutate(lambda d: d["objects"][0].update(rotation_deg=90.5)))


def test_json_schema_is_exported():
    """Drift guard for the TS side. Rewrites the file and fails when it changed."""
    schema = json.dumps(RoomScenario.model_json_schema(), indent=2) + "\n"
    old = SCHEMA.read_text() if SCHEMA.exists() else None
    if old != schema:
        Path(SCHEMA).write_text(schema)
    assert old == schema, f"{SCHEMA.name} was out of date and has been regenerated; re-run tests"
