import json
from pathlib import Path

from app.models import Check, RoomScenario, ValidationResult

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "fixtures"


def load(name: str) -> RoomScenario:
    return RoomScenario.model_validate(json.loads((FIXTURES / f"{name}.json").read_text()))


def obj(id, x, y, w, h, rot=0, movable=True, **kw) -> dict:
    return {"id": id, "label": id, "x_cm": x, "y_cm": y, "width_cm": w, "height_cm": h,
            "rotation_deg": rot, "movable": movable, "confirmed": True, **kw}


def dest(id, object_id, side, w=80, d=90) -> dict:
    return {"id": id, "object_id": object_id, "side": side,
            "approach_width_cm": w, "approach_depth_cm": d}


DOOR = {"id": "door", "wall": "left", "offset_cm": 100, "clear_width_cm": 90, "confirmed": True}


def make(objects=(), destinations=(), room=(400, 300), route=80, door_min=80, turning=None,
         doors=None, required=None) -> RoomScenario:
    return RoomScenario.model_validate({
        "id": "test", "room": {"width_cm": room[0], "height_cm": room[1]},
        "doors": [DOOR] if doors is None else doors,
        "objects": list(objects), "destinations": list(destinations),
        "requirements": {
            "route_width_cm": route, "door_min_clear_width_cm": door_min,
            "turning_diameter_cm": turning,
            "required_destination_ids": ([d["id"] for d in destinations]
                                         if required is None else required)}})


def check(result: ValidationResult, id: str) -> Check:
    return next(c for c in result.checks if c.id == id)


def route_check(result: ValidationResult, dest_id: str) -> Check:
    return next(c for c in result.checks if c.id.startswith("route-") and c.id.endswith(dest_id))
