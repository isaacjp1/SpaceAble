"""Clearance-aware free space, grid A*, path verification and turning circles.

The moving agent is a disk of radius r (translation only). Valid disk centers are
the room shrunk by r minus every footprint grown by r. Shapely approximates arcs
with chords that lie inside the true circle, so footprints are grown by
r / cos(pi / 4q) instead. The polygon then circumscribes the true rounded rectangle
and the free space is never larger than the exact one.
"""

import heapq
import math
from itertools import pairwise

import numpy as np
import shapely
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

from .models import XY, Door, Room

QUAD_SEGS = 16
INFLATE = 1 / math.cos(math.pi / (4 * QUAD_SEGS))
ENTRY_MARGIN_CM = 1.0
_D = math.sqrt(2)
_MOVES = [(0, 1, 1.0), (0, -1, 1.0), (1, 0, 1.0), (-1, 0, 1.0),
          (1, 1, _D), (1, -1, _D), (-1, 1, _D), (-1, -1, _D)]


def grow(geom, r: float):
    """Footprints grown by r, circumscribing the true rounded shape (see above)."""
    return geom.buffer(r * INFLATE, quad_segs=QUAD_SEGS)


def free_space(room: Room, footprints: list[Polygon], r: float):
    W, H = room.width_cm, room.height_cm
    if W <= 2 * r or H <= 2 * r:
        return Polygon()
    free = box(r, r, W - r, H - r)
    if footprints:
        free = free.difference(grow(unary_union(footprints), r))
    return free


def pieces(geom) -> list[Polygon]:
    parts = [geom] if isinstance(geom, Polygon) else list(getattr(geom, "geoms", []))
    return [g for g in parts if isinstance(g, Polygon) and not g.is_empty]


def component_at(free, xy: XY) -> Polygon | None:
    """The connected free-space polygon whose interior contains xy."""
    p = Point(xy)
    return next((g for g in pieces(free) if g.contains(p)), None)


def entry_point(door: Door, room: Room, r: float) -> XY:
    """Door midpoint pushed r + margin into the room (clamped along the wall).

    Derived from the route radius so the route width threshold is never applied
    across the doorway itself; the door opening has its own check.
    """
    W, H = room.width_cm, room.height_cm
    inset = r + ENTRY_MARGIN_CM
    wall_len = H if door.wall in ("left", "right") else W
    along = min(max(door.offset_cm + door.clear_width_cm / 2, inset), wall_len - inset)
    return {"left": (inset, along), "right": (W - inset, along),
            "top": (along, inset), "bottom": (along, H - inset)}[door.wall]


def clearance(path: list[XY], room: Room, footprints: list[Polygon]) -> float:
    """Exact minimum distance from a polyline (or point) to the walls and every footprint.

    Computed from the original rectangles, independently of the buffered free space.
    Wall distance is linear along a segment, so its minimum is at a vertex.
    """
    walls = min(min(x, room.width_cm - x, y, room.height_cm - y) for x, y in path)
    geom = LineString(path) if len(path) > 1 else Point(path[0])
    return min([walls] + [geom.distance(f) for f in footprints])


def segments_covered(free, path: list[XY]) -> bool:
    return all(free.covers(LineString([a, b])) for a, b in pairwise(path))


def grid_route(free, start: XY, target: Polygon, grid: float) -> list[XY] | None:
    """A* on an 8-connected grid aligned to `start`, ending at any free node inside `target`.

    Diagonal moves need both orthogonal neighbours free (no corner cutting). An edge
    of length L between nodes with boundary clearances d_i, d_j is safe when
    d_i + d_j > L (the worst point on it has clearance (d_i + d_j - L) / 2);
    otherwise it must pass an exact `covers` test.
    """
    shapely.prepare(free)
    sx, sy = start
    minx, miny, maxx, maxy = free.bounds
    kx, ky = math.floor((minx - sx) / grid), math.floor((miny - sy) / grid)
    xs = (sx + grid * np.arange(kx, math.ceil((maxx - sx) / grid) + 1)).tolist()
    ys = (sy + grid * np.arange(ky, math.ceil((maxy - sy) / grid) + 1)).tolist()
    X, Y = np.meshgrid(xs, ys)
    ok_np = shapely.contains_xy(free, X, Y)
    clear_np = np.zeros(X.shape)
    clear_np[ok_np] = shapely.distance(free.boundary, shapely.points(X[ok_np], Y[ok_np]))
    tx1, ty1, tx2, ty2 = target.bounds
    goal_np = ok_np & (X >= tx1) & (X <= tx2) & (Y >= ty1) & (Y <= ty2)
    s = (-ky, -kx)
    if not ok_np[s] or not goal_np.any():
        return None
    ok, clear, goal = ok_np.tolist(), clear_np.tolist(), goal_np.tolist()
    ny, nx = len(ys), len(xs)

    def h(j: int, i: int) -> float:  # octile distance to the target rectangle (admissible)
        dx = max(tx1 - xs[i], 0.0, xs[i] - tx2)
        dy = max(ty1 - ys[j], 0.0, ys[j] - ty2)
        return max(dx, dy) + (math.sqrt(2) - 1) * min(dx, dy)

    best = {s: 0.0}
    came: dict[tuple[int, int], tuple[int, int]] = {}
    heap = [(h(*s), 0.0, s)]
    closed = set()
    end = None
    while heap:
        _, g, node = heapq.heappop(heap)
        if node in closed:
            continue
        closed.add(node)
        j, i = node
        if goal[j][i]:
            end = node
            break
        for dj, di, step in _MOVES:
            nj, ni = j + dj, i + di
            if not (0 <= nj < ny and 0 <= ni < nx) or not ok[nj][ni] or (nj, ni) in closed:
                continue
            if dj and di and not (ok[j][ni] and ok[nj][i]):
                continue
            length = step * grid
            ng = g + length
            if ng >= best.get((nj, ni), math.inf):
                continue
            if clear[j][i] + clear[nj][ni] <= length and not free.covers(
                    LineString([(xs[i], ys[j]), (xs[ni], ys[nj])])):
                continue
            best[(nj, ni)] = ng
            came[(nj, ni)] = node
            heapq.heappush(heap, (ng + h(nj, ni), ng, (nj, ni)))
    if end is None:
        return None

    nodes = [end]
    while nodes[-1] != s:
        nodes.append(came[nodes[-1]])
    nodes.reverse()
    # keep only turning points: a straight run of verified edges is itself verified
    turns = [nodes[0]] + [
        b for a, b, c in zip(nodes, nodes[1:], nodes[2:], strict=False)
        if (b[0] - a[0], b[1] - a[1]) != (c[0] - b[0], c[1] - b[1])
    ] + ([nodes[-1]] if len(nodes) > 1 else [])
    return _pull(free, [(xs[i], ys[j]) for j, i in turns])


def _pull(free, pts: list[XY]) -> list[XY]:
    """String-pulling: jump to the farthest later point whose segment stays in free space."""
    out, i = [pts[0]], 0
    while i < len(pts) - 1:
        j = len(pts) - 1
        while j > i + 1 and not free.covers(LineString([pts[i], pts[j]])):
            j -= 1
        out.append(pts[j])
        i = j
    return out


def turning_center(room: Room, footprints: list[Polygon], R: float, entry_component):
    """Best center for a free disk of radius R: (center, clearance, reachable) or None.

    Prefers a center reachable from the entry component, then the largest clearance.
    """
    best = None
    for piece in pieces(free_space(room, footprints, R)):
        cx, cy = shapely.maximum_inscribed_circle(piece, 0.5).coords[0]
        cl = clearance([(cx, cy)], room, footprints)
        reach = entry_component is not None and entry_component.covers(Point(cx, cy))
        if best is None or (reach, cl) > (best[2], best[1]):
            best = ((cx, cy), cl, reach)
    return best


def rings(poly: Polygon) -> list[list[XY]]:
    return [[(round(x, 1), round(y, 1)) for x, y in ring.coords]
            for ring in [poly.exterior, *poly.interiors]]
