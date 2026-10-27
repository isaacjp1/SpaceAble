"""SpaceAble planner HTTP API."""

import hmac
import logging
import os

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .analyze import analyze
from .models import (
    AnalyzeRequest,
    OptimizationResult,
    OptimizeRequest,
    ValidationResult,
    apply_layout,
)
from .optimize import optimize, widest_route

MAX_BODY_BYTES = 512 * 1024

log = logging.getLogger("planner")
if not os.environ.get("PLANNER_SHARED_SECRET"):
    log.warning("PLANNER_SHARED_SECRET is not set: the planner accepts unauthenticated requests. "
                "Fine for local development; set it in production.")
app = FastAPI(title="SpaceAble planner", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("PLANNER_CORS_ORIGINS", "http://localhost:3000").split(","),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


def error(status: int, code: str, message: str, details=None, retryable=False) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": {
        "code": code, "message": message, "details": details or {}, "retryable": retryable}})


@app.middleware("http")
async def guard(request: Request, call_next):
    # Only the Next.js server calls the planner. When PLANNER_SHARED_SECRET is set (required in
    # production), every route except /health needs it, so the compute endpoints aren't public.
    secret = os.environ.get("PLANNER_SHARED_SECRET")
    sent = request.headers.get("x-planner-secret", "").encode()
    if secret and request.url.path != "/health" and not hmac.compare_digest(sent, secret.encode()):
        return error(401, "UNAUTHORIZED", "Missing or wrong planner secret.")
    # Limit: trusts Content-Length; the Next.js proxy also caps bodies. Stream-count if exposed.
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > MAX_BODY_BYTES:
        return error(413, "VALIDATION_ERROR", f"Request body exceeds {MAX_BODY_BYTES} bytes.")
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(_: Request, exc: RequestValidationError):
    errs = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    first = errs[0] if errs else {"msg": "Invalid request", "loc": []}
    where = ".".join(str(p) for p in first["loc"] if p != "body")
    msg = first["msg"].removeprefix("Value error, ")
    return error(422, "VALIDATION_ERROR", f"{where}: {msg}" if where else msg, {"errors": errs})


@app.exception_handler(Exception)
async def internal_error(_: Request, exc: Exception):
    log.exception("unhandled error")
    return error(500, "INTERNAL_ERROR", "The planner hit an unexpected error.")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/v1/planner/analyze", response_model=ValidationResult)
def analyze_endpoint(body: AnalyzeRequest):
    scenario = body.scenario
    if body.layout_override is not None:
        try:
            scenario = apply_layout(scenario, body.layout_override)
        except ValueError as e:
            return error(422, "VALIDATION_ERROR", str(e))
    result = analyze(scenario, body.options.grid_cm)
    if result.status == "pass":
        result.widest_route_cm = widest_route(scenario, body.options.grid_cm)
    return result


@app.post("/v1/planner/optimize", response_model=OptimizationResult)
def optimize_endpoint(body: OptimizeRequest):
    return optimize(body.scenario, body.options)
