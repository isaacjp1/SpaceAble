"""HTTP contract and error behaviour."""

import json

from fastapi.testclient import TestClient

from app.main import MAX_BODY_BYTES, app
from helpers import FIXTURES

client = TestClient(app)
SCENARIO = json.loads((FIXTURES / "canonical-bedroom.json").read_text())


def test_health():
    assert client.get("/health").json() == {"status": "ok"}


def test_analyze_canonical_and_layout_override():
    r = client.post("/v1/planner/analyze", json={"scenario": SCENARIO})
    assert r.status_code == 200 and r.json()["status"] == "fail"

    moved = {"object_positions": [{"object_id": "dresser", "x_cm": 90, "y_cm": 300}]}
    r = client.post("/v1/planner/analyze", json={"scenario": SCENARIO, "layoutOverride": moved})
    body = r.json()
    assert body["status"] == "pass"
    assert body["routes"][0]["polyline"] and body["routes"][0]["length_cm"] > 0


def test_unknown_object_in_override_is_rejected():
    bad = {"object_positions": [{"object_id": "piano", "x_cm": 0, "y_cm": 0}]}
    r = client.post("/v1/planner/analyze", json={"scenario": SCENARIO, "layoutOverride": bad})
    assert r.status_code == 422
    assert r.json()["error"] == {"code": "VALIDATION_ERROR", "retryable": False, "details": {},
                                 "message": "Unknown object id 'piano' in layout"}


def test_malformed_scenario_uses_error_contract():
    s = json.loads(json.dumps(SCENARIO))
    s["objects"][1]["rotation_deg"] = 45
    r = client.post("/v1/planner/analyze", json={"scenario": s})
    err = r.json()["error"]
    assert r.status_code == 422 and err["code"] == "VALIDATION_ERROR"
    assert "rotation_deg" in err["message"] and err["details"]["errors"]


def test_nan_in_raw_json_is_rejected():
    raw = json.dumps({"scenario": SCENARIO}).replace('"x_cm": 260', '"x_cm": NaN')
    r = client.post("/v1/planner/analyze", content=raw,
                    headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_oversized_body_is_rejected():
    r = client.post("/v1/planner/analyze", content=b" " * (MAX_BODY_BYTES + 1),
                    headers={"content-type": "application/json"})
    assert r.status_code == 413 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_grid_option_bounds():
    r = client.post("/v1/planner/analyze",
                    json={"scenario": SCENARIO, "options": {"grid_cm": 0.1}})
    assert r.status_code == 422
