"""Vascular tree for 3D runs: a Python port of the viewer's ``src/sim/vasculature.ts``.

The viewer grows its vessel network from ``rules.json`` and draws it. For a
Python run the network is grown here with the same algorithm (branching with
Murray's law, tortuous segments, lumen + wall rasterisation) and the resulting
segments are written into the run's ``rules.json`` as ``vasculature.segments``.
The viewer then rasterises those segments with the same ``stamp`` routine, so
the vessels it draws are exactly the voxels the engine perfuses. Nothing about
the vessels is biology; it is geometry shared by both sides.

Only the lumen voxels are oxygen/drug sources; lumen and wall voxels are blocked
for cells.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np


DEFAULT_SPEC = {
    "trunks": 6,
    "maxDepth": 5,
    "segmentLengthVoxels": 6.5,
    "tortuosity": 0.42,
    "branchAngle": 0.62,
    "branchEverySegments": 2,
    "trunkRadiusVoxels": 1.35,
    "minRadiusVoxels": 0.45,
    "murrayExponent": 2.7,
    "wallThicknessVoxels": 0.3,
    "oxygenSupply": 1.0,
    "drugSupplyFraction": 1.0
}


@dataclass
class Segment:
    ax: float; ay: float; az: float
    bx: float; by: float; bz: float
    ra: float
    rb: float
    depth: int
    parent: int

    def as_dict(self) -> dict:
        return asdict(self)


@dataclass
class VesselNetwork:
    segments: list[Segment]
    mask: np.ndarray          # flat uint8, 0 empty, 1 lumen, 2 wall; index = x + y*nx + z*nx*ny
    nx: int
    ny: int
    nz: int

    @property
    def lumen_indices(self) -> np.ndarray:
        return np.flatnonzero(self.mask == 1)

    @property
    def blocked_indices(self) -> np.ndarray:
        return np.flatnonzero(self.mask != 0)

    def coords(self, index: int) -> tuple[int, int, int]:
        plane = self.nx * self.ny
        z, rest = divmod(int(index), plane)
        y, x = divmod(rest, self.nx)
        return x, y, z

    def mean_distance_to_lumen_sites(self) -> float:
        """Mean 6-connected lattice distance from a non-vessel voxel to the nearest lumen voxel."""
        lumen = self.mask.reshape(self.nz, self.ny, self.nx) == 1
        if not lumen.any():
            return float("inf")
        dist = np.where(lumen, 0.0, np.inf)
        frontier = lumen.copy()
        d = 0
        while frontier.any() and np.isinf(dist).any():
            d += 1
            grown = np.zeros_like(frontier)
            grown[1:, :, :] |= frontier[:-1, :, :]; grown[:-1, :, :] |= frontier[1:, :, :]
            grown[:, 1:, :] |= frontier[:, :-1, :]; grown[:, :-1, :] |= frontier[:, 1:, :]
            grown[:, :, 1:] |= frontier[:, :, :-1]; grown[:, :, :-1] |= frontier[:, :, 1:]
            new = grown & np.isinf(dist)
            dist[new] = d
            frontier = new
        return float(dist[~lumen].mean())


# ---------------------------------------------------------------- JS-compatible RNG and math
_MASK32 = 0xFFFFFFFF


def _imul(a: int, b: int) -> int:
    """JavaScript Math.imul: 32-bit signed multiply."""
    r = (a * b) & _MASK32
    return r - (1 << 32) if r >= (1 << 31) else r


def mulberry32(seed: int):
    """Port of the viewer's sequential generator (``src/sim/rng.ts``)."""
    state = seed & _MASK32

    def rng() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & _MASK32
        t = state
        t = _imul(t ^ (t >> 15), t | 1) & _MASK32
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & _MASK32
        t &= _MASK32
        return ((t ^ (t >> 14)) & _MASK32) / 4294967296.0

    return rng


def _norm(x: float, y: float, z: float) -> tuple[float, float, float]:
    length = math.hypot(x, y, z) or 1.0
    return x / length, y / length, z / length


def _perpendicular(dx: float, dy: float, dz: float) -> tuple[float, float, float]:
    ax = 1 if abs(dx) < 0.9 else 0
    ay = 0 if abs(dx) < 0.9 else 1
    return _norm(dy * 0 - dz * ay, dz * ax - dx * 0, dx * ay - dy * ax)


def _rotate_about(vx, vy, vz, kx, ky, kz, angle):
    c = math.cos(angle)
    s = math.sin(angle)
    dot = kx * vx + ky * vy + kz * vz
    return _norm(
        vx * c + (ky * vz - kz * vy) * s + kx * dot * (1 - c),
        vy * c + (kz * vx - kx * vz) * s + ky * dot * (1 - c),
        vz * c + (kx * vy - ky * vx) * s + kz * dot * (1 - c)
    )


# ---------------------------------------------------------------- growth
def grow_vasculature(seed: int, nx: int, ny: int, nz: int, spec: dict | None = None) -> VesselNetwork:
    """Grow a tree with the viewer's algorithm. Deterministic in (seed, spec, grid)."""
    spec = {**DEFAULT_SPEC, **(spec or {})}
    murray = spec.get("murrayExponent", 3)
    rng = mulberry32((seed ^ 0x5BF03635) & _MASK32)
    cx = (nx - 1) / 2
    cy = (ny - 1) / 2
    cz = (nz - 1) / 2
    radius = min(nx, ny, nz) / 2

    segments: list[Segment] = []
    tips: list[dict] = []
    for t in range(spec["trunks"]):
        theta = ((t + rng() * 0.5) / spec["trunks"]) * math.pi * 2
        phi = math.acos(2 * rng() - 1)
        sx = cx + math.sin(phi) * math.cos(theta) * radius * 0.98
        sy = cy + math.cos(phi) * radius * 0.98
        sz = cz + math.sin(phi) * math.sin(theta) * radius * 0.98
        jitter = radius * 0.35
        dx, dy, dz = _norm(cx + (rng() - 0.5) * jitter - sx, cy + (rng() - 0.5) * jitter - sy, cz + (rng() - 0.5) * jitter - sz)
        tips.append(dict(x=sx, y=sy, z=sz, dx=dx, dy=dy, dz=dz, radius=spec["trunkRadiusVoxels"], depth=0, since=0, parent=-1))

    def inside(x, y, z):
        return x >= -2 and y >= -2 and z >= -2 and x <= nx + 1 and y <= ny + 1 and z <= nz + 1

    guard = 0
    while tips and guard < 20000:
        guard += 1
        nxt: list[dict] = []
        for tip in tips:
            if tip["depth"] > spec["maxDepth"] or tip["radius"] < spec["minRadiusVoxels"]:
                continue
            px, py, pz = _perpendicular(tip["dx"], tip["dy"], tip["dz"])
            spin = rng() * math.pi * 2
            wx, wy, wz = _rotate_about(px, py, pz, tip["dx"], tip["dy"], tip["dz"], spin)
            bend = spec["tortuosity"] * (0.5 + rng())
            dx, dy, dz = _norm(tip["dx"] + wx * bend, tip["dy"] + wy * bend, tip["dz"] + wz * bend)
            length = spec["segmentLengthVoxels"] * (0.7 + rng() * 0.6)
            ex, ey, ez = tip["x"] + dx * length, tip["y"] + dy * length, tip["z"] + dz * length
            if not inside(ex, ey, ez):
                continue
            index = len(segments)
            segments.append(Segment(tip["x"], tip["y"], tip["z"], ex, ey, ez, tip["radius"], tip["radius"], tip["depth"], tip["parent"]))
            should_branch = tip["since"] + 1 >= spec["branchEverySegments"] and tip["depth"] + 1 <= spec["maxDepth"]
            if not should_branch:
                nxt.append(dict(x=ex, y=ey, z=ez, dx=dx, dy=dy, dz=dz, radius=tip["radius"], depth=tip["depth"], since=tip["since"] + 1, parent=index))
                continue
            split = 0.35 + rng() * 0.3
            total = tip["radius"] ** murray
            r1 = (total * split) ** (1 / murray)
            r2 = (total * (1 - split)) ** (1 / murray)
            kx, ky, kz = _rotate_about(*_perpendicular(dx, dy, dz), dx, dy, dz, rng() * math.pi * 2)
            for child_radius, sign in ((r1, 1), (r2, -1)):
                if child_radius < spec["minRadiusVoxels"]:
                    continue
                angle = spec["branchAngle"] * (0.6 + rng() * 0.8) * sign
                bx2, by2, bz2 = _rotate_about(dx, dy, dz, kx, ky, kz, angle)
                nxt.append(dict(x=ex, y=ey, z=ez, dx=bx2, dy=by2, dz=bz2, radius=child_radius, depth=tip["depth"] + 1, since=0, parent=index))
        tips = nxt

    child_radius: dict[int, float] = {}
    for s in segments:
        if s.parent >= 0:
            child_radius[s.parent] = max(child_radius.get(s.parent, 0.0), s.ra)
    for i, s in enumerate(segments):
        s.rb = child_radius.get(i, s.ra * 0.8)

    mask = rasterize(segments, nx, ny, nz, spec["wallThicknessVoxels"])
    return VesselNetwork(segments, mask, nx, ny, nz)


def rasterize(segments: list[Segment], nx: int, ny: int, nz: int, wall_thickness: float) -> np.ndarray:
    """Port of the viewer's ``stamp`` loop: walls (2) first, lumen (1) second; lumen wins."""
    mask = np.zeros(nx * ny * nz, dtype=np.uint8)
    stride_y, stride_z = nx, nx * ny

    def stamp(x, y, z, r, value):
        r2 = r * r
        x0, x1 = max(0, math.floor(x - r)), min(nx - 1, math.ceil(x + r))
        y0, y1 = max(0, math.floor(y - r)), min(ny - 1, math.ceil(y + r))
        z0, z1 = max(0, math.floor(z - r)), min(nz - 1, math.ceil(z + r))
        for vz in range(z0, z1 + 1):
            ddz = vz - z
            for vy in range(y0, y1 + 1):
                ddy = vy - y
                row = vy * stride_y + vz * stride_z
                for vx in range(x0, x1 + 1):
                    ddx = vx - x
                    if ddx * ddx + ddy * ddy + ddz * ddz > r2:
                        continue
                    i = row + vx
                    if mask[i] != 0 and value >= mask[i]:
                        continue
                    mask[i] = value

    for value in (2, 1):
        extra = wall_thickness if value == 2 else 0.0
        for s in segments:
            dx, dy, dz = s.bx - s.ax, s.by - s.ay, s.bz - s.az
            length = math.hypot(dx, dy, dz)
            steps = max(2, math.ceil(length * 2))
            for k in range(steps + 1):
                t = k / steps
                stamp(s.ax + dx * t, s.ay + dy * t, s.az + dz * t, s.ra + (s.rb - s.ra) * t + extra, value)
    return mask


def network_from_segments(segments: list[dict], nx: int, ny: int, nz: int, wall_thickness: float) -> VesselNetwork:
    segs = [Segment(**{k: s[k] for k in ("ax", "ay", "az", "bx", "by", "bz", "ra", "rb", "depth", "parent")}) for s in segments]
    return VesselNetwork(segs, rasterize(segs, nx, ny, nz, wall_thickness), nx, ny, nz)
