"""Furniture footprints, containment, collision and approach zones (axis-aligned, cm)."""

from shapely.geometry import Polygon, box

from .models import EPS, Destination, Furniture, Room

_CW = {"top": "right", "right": "bottom", "bottom": "left", "left": "top"}


def dims(obj: Furniture) -> tuple[float, float]:
    """Physical footprint (w, h) after rotation: 90/270 swap width and height."""
    if obj.rotation_deg in (90, 270):
        return obj.height_cm, obj.width_cm
    return obj.width_cm, obj.height_cm


def footprint(obj: Furniture) -> Polygon:
    w, h = dims(obj)
    return box(obj.x_cm, obj.y_cm, obj.x_cm + w, obj.y_cm + h)


def inside(rect: Polygon, room: Room) -> bool:
    x1, y1, x2, y2 = rect.bounds
    return x1 >= -EPS and y1 >= -EPS and x2 <= room.width_cm + EPS and y2 <= room.height_cm + EPS


def overlaps(a: Polygon, b: Polygon) -> bool:
    """Interiors overlap by more than EPS in both axes. Shared edges/corners do not count."""
    ax1, ay1, ax2, ay2 = a.bounds
    bx1, by1, bx2, by2 = b.bounds
    return min(ax2, bx2) - max(ax1, bx1) > EPS and min(ay2, by2) - max(ay1, by1) > EPS


def world_side(side: str, rotation_deg: int) -> str:
    for _ in range(rotation_deg // 90):
        side = _CW[side]
    return side


def approach_rect(dest: Destination, obj: Furniture) -> Polygon:
    """Approach zone centred on the chosen side, extending outward by approach_depth_cm."""
    x1, y1, x2, y2 = footprint(obj).bounds
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    hw, d = dest.approach_width_cm / 2, dest.approach_depth_cm
    return {
        "top": lambda: box(cx - hw, y1 - d, cx + hw, y1),
        "bottom": lambda: box(cx - hw, y2, cx + hw, y2 + d),
        "left": lambda: box(x1 - d, cy - hw, x1, cy + hw),
        "right": lambda: box(x2, cy - hw, x2 + d, cy + hw),
    }[world_side(dest.side, obj.rotation_deg)]()
