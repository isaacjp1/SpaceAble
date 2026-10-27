"""Data contracts. All lengths are centimeters; origin top-left, x right, y down."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

MAX_ROOM_CM = 3000.0  # 30 m cap on any dimension or coordinate
MAX_OBJECTS = 40
EPS = 1e-6


class Model(BaseModel):
    # extra="forbid": typos are errors. allow_inf_nan=False: json.loads accepts NaN/Infinity.
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, populate_by_name=True)


Length = Annotated[float, Field(gt=0, le=MAX_ROOM_CM)]
Coord = Annotated[float, Field(ge=0, le=MAX_ROOM_CM)]
Id = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_.-]+$")]
Side = Literal["top", "right", "bottom", "left"]
Rotation = Literal[0, 90, 180, 270]  # clockwise as seen on screen
Status = Literal["pass", "fail", "not_checked", "needs_input", "unknown"]
Kind = Literal[
    "bed", "desk", "dresser", "chair", "table", "wardrobe",
    "nightstand", "sofa", "shelf", "obstacle", "other",
]
XY = tuple[float, float]


class Point(Model):
    x: float
    y: float


class Room(Model):
    width_cm: Length
    height_cm: Length


class Door(Model):
    id: Id
    wall: Side
    offset_cm: Coord  # along the wall: from the top for left/right walls, from the left otherwise
    clear_width_cm: Length | None = None
    entry_anchor: Point | None = None  # informational only; the route start is derived
    confirmed: bool = False


class Furniture(Model):
    """Fixed obstacles are furniture with movable=False."""

    id: Id
    label: str = Field(min_length=1, max_length=80)
    kind: Kind = "other"
    x_cm: Coord  # top-left of the *current* (rotated) footprint
    y_cm: Coord
    width_cm: Length  # unrotated dimensions
    height_cm: Length
    rotation_deg: Rotation = 0
    movable: bool = True
    confirmed: bool = False  # measurements confirmed by the user
    label_source: Literal["user-provided", "ai-inferred"] = "user-provided"
    # A hypothetical new piece with no position yet: analyze leaves it out, optimize places it.
    to_place: bool = False


class Destination(Model):
    id: Id
    object_id: Id
    side: Side  # in the object's unrotated frame; turns with the object
    approach_width_cm: Length
    approach_depth_cm: Length
    required: bool = False  # default for new requirements; requirements list is authoritative


class Requirements(Model):
    route_width_cm: Length | None = None
    door_min_clear_width_cm: Length | None = None
    turning_diameter_cm: Length | None = None  # None = not checked
    required_destination_ids: list[Id] = Field(default_factory=list, max_length=20)
    locked_object_ids: list[Id] = Field(default_factory=list, max_length=MAX_OBJECTS)
    optimization_profile: Literal["minimal_changes", "max_clearance"] = "minimal_changes"
    start_door_id: Id | None = None  # None = first door


class RoomScenario(Model):
    id: Id
    version: Literal[1] = 1
    units: Literal["cm"] = "cm"
    title: str | None = Field(None, max_length=120)
    room: Room
    doors: list[Door] = Field(default_factory=list, max_length=8)
    objects: list[Furniture] = Field(default_factory=list, max_length=MAX_OBJECTS)
    destinations: list[Destination] = Field(default_factory=list, max_length=20)
    requirements: Requirements = Field(default_factory=Requirements)

    @model_validator(mode="after")
    def _references(self) -> "RoomScenario":
        for name, items in (("door", self.doors), ("object", self.objects),
                            ("destination", self.destinations)):
            ids = [i.id for i in items]
            if dupes := sorted({i for i in ids if ids.count(i) > 1}):
                raise ValueError(f"Duplicate {name} id(s): {', '.join(dupes)}")
        object_ids = {o.id for o in self.objects}
        req = self.requirements
        refs = [(d.object_id, object_ids, f"destination '{d.id}' object")
                for d in self.destinations]
        refs += [(i, object_ids, "locked object") for i in req.locked_object_ids]
        refs += [(i, {d.id for d in self.destinations}, "required destination")
                 for i in req.required_destination_ids]
        if req.start_door_id is not None:
            refs.append((req.start_door_id, {d.id for d in self.doors}, "start door"))
        for ref, known, what in refs:
            if ref not in known:
                raise ValueError(f"Unknown {what} id '{ref}'")
        for o in self.objects:
            if o.to_place and (not o.movable or o.id in req.locked_object_ids):
                raise ValueError(f"'{o.id}' has no position yet, so it can't be fixed or locked")
        for d in self.doors:
            wall_len = self.room.height_cm if d.wall in ("left", "right") else self.room.width_cm
            if d.offset_cm + (d.clear_width_cm or 0) > wall_len + EPS:
                raise ValueError(
                    f"Door '{d.id}' extends beyond the {d.wall} wall ({wall_len:g} cm)")
        return self

    def start_door(self) -> Door | None:
        if self.requirements.start_door_id:
            return next(d for d in self.doors if d.id == self.requirements.start_door_id)
        return self.doors[0] if self.doors else None


class ObjectPosition(Model):
    object_id: Id
    x_cm: Coord
    y_cm: Coord
    rotation_deg: Rotation = 0


class Layout(Model):
    object_positions: list[ObjectPosition] = Field(default_factory=list, max_length=MAX_OBJECTS)


def apply_layout(scenario: RoomScenario, layout: Layout) -> RoomScenario:
    """Return a copy of the scenario with positions replaced. Unknown ids raise ValueError."""
    by_id = {o.id: o for o in scenario.objects}
    for p in layout.object_positions:
        if p.object_id not in by_id:
            raise ValueError(f"Unknown object id '{p.object_id}' in layout")
        by_id[p.object_id] = by_id[p.object_id].model_copy(update={
            "x_cm": p.x_cm, "y_cm": p.y_cm, "rotation_deg": p.rotation_deg, "to_place": False})
    return scenario.model_copy(update={"objects": [by_id[o.id] for o in scenario.objects]})


def without_unplaced(scenario: RoomScenario) -> RoomScenario:
    """The scenario minus pieces that have no position yet, and their destinations."""
    gone = {o.id for o in scenario.objects if o.to_place}
    if not gone:
        return scenario
    dests = {d.id for d in scenario.destinations if d.object_id in gone}
    req = scenario.requirements
    return scenario.model_copy(update={
        "objects": [o for o in scenario.objects if o.id not in gone],
        "destinations": [d for d in scenario.destinations if d.id not in dests],
        "requirements": req.model_copy(update={"required_destination_ids": [
            i for i in req.required_destination_ids if i not in dests]})})


class AnalyzeOptions(Model):
    grid_cm: float = Field(5.0, ge=1.0, le=25.0)


class AnalyzeRequest(Model):
    scenario: RoomScenario
    layout_override: Layout | None = Field(None, alias="layoutOverride")
    options: AnalyzeOptions = Field(default_factory=AnalyzeOptions)


class OptimizeOptions(Model):
    time_limit_s: float = Field(10.0, ge=0.5, le=30.0)
    grid_spacing_cm: float = Field(20.0, ge=10.0, le=50.0)
    max_alternatives: int = Field(3, ge=1, le=3)


class OptimizeRequest(Model):
    scenario: RoomScenario
    options: OptimizeOptions = Field(default_factory=OptimizeOptions)


# ---- results ---------------------------------------------------------------


class Check(Model):
    id: str
    status: Status
    required: bool = True  # only required checks drive the overall status
    measured_cm: float | None = None
    required_cm: float | None = None
    message: str
    object_ids: list[str] = Field(default_factory=list)


class RouteEvidence(Model):
    destination_id: str
    door_id: str | None
    status: Status
    start: XY | None = None
    target_rect: tuple[float, float, float, float] | None = None  # x1, y1, x2, y2
    polyline: list[XY] = Field(default_factory=list)
    length_cm: float | None = None
    min_clearance_cm: float | None = None  # exact distance from path to nearest wall/furniture


class TurningZone(Model):
    center: XY
    diameter_cm: float
    reachable: bool


class ValidationResult(Model):
    status: Status
    checks: list[Check]
    routes: list[RouteEvidence] = Field(default_factory=list)
    turning_zones: list[TurningZone] = Field(default_factory=list)
    reachable_area: list[list[list[XY]]] = Field(default_factory=list)  # polygons → rings → points
    assumptions: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    grid_cm: float
    elapsed_ms: float
    # Widest route width at which this layout still passes. Filled for passing layouts by the
    # analyze endpoint and the optimizer; analyze() leaves it None so search stays fast.
    widest_route_cm: float | None = None


class Move(Model):
    object_id: str
    from_x_cm: float
    from_y_cm: float
    from_rotation_deg: int
    to_x_cm: float
    to_y_cm: float
    to_rotation_deg: int
    distance_cm: float  # footprint centre to footprint centre
    placed: bool = False  # a new (to_place) piece put here: from_* equal to_*, distance 0


class Cost(Model):
    moved_objects: int
    displacement_cm: float
    route_length_cm: float  # sum over required routes
    total_score: float  # lower is better; weights are engineering defaults (optimize.py)


class Alternative(Model):
    id: str
    layout: Layout  # positions of moved objects only; use as analyze layoutOverride
    moves: list[Move]
    validation: ValidationResult  # independent analyze() of exactly this layout
    cost: Cost


class SearchInfo(Model):
    grid_spacing_cm: float
    time_limit_s: float
    elapsed_s: float
    combinations_considered: int
    candidates_tested: int  # layouts that reached the full validator
    exhaustive: bool  # every discrete combination was visited (no cap, no timeout)


OptimizeStatus = Literal["solutions_found", "no_solution_found_within_budget",
                         "discretized_search_infeasible", "needs_input", "error"]


class OptimizationResult(Model):
    status: OptimizeStatus
    message: str
    alternatives: list[Alternative] = Field(default_factory=list)
    baseline: ValidationResult  # analyze() of the submitted layout
    search: SearchInfo
    warnings: list[str] = Field(default_factory=list)
