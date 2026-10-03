"""Converged quasi-steady field solvers for the cellular automata (2D or 3D).

Each biological step solves  D * laplacian(u) - k(u) * u + s = 0  on the lattice
with the standard 2*ndim + 1 point stencil, reflecting (clamped-index) boundaries
and [0, 1] clamping, by red-black successive over-relaxation iterated to a
tolerance. For a 2D section (array shape (1, H, W) or (H, W)) the stencil is the
five-point one the validated engine used; a volume uses the seven-point stencil.
``tests/test_physics_validation.py`` compares both against dense direct solves.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True)
class SolveResult:
    values: np.ndarray
    iterations: int
    converged: bool
    max_change: float


def _active_axes(u: np.ndarray) -> list[int]:
    """Axes with more than one site; a 1-deep volume is treated as a 2D section."""
    return [axis for axis in range(u.ndim) if u.shape[axis] > 1]


def _neighbor_sum(u: np.ndarray, axes: list[int] | None = None) -> np.ndarray:
    """Sum of lattice neighbours along the active axes with clamped indices at the edges."""
    axes = _active_axes(u) if axes is None else axes
    out = np.zeros_like(u)
    for axis in axes:
        lo = [slice(None)] * u.ndim
        hi = [slice(None)] * u.ndim
        first = [slice(None)] * u.ndim
        last = [slice(None)] * u.ndim
        lo[axis] = slice(1, None); hi[axis] = slice(None, -1)
        first[axis] = slice(0, 1); last[axis] = slice(-1, None)
        shifted_minus = np.concatenate([u[tuple(first)], u[tuple(hi)]], axis=axis)   # u[i-1], clamped
        shifted_plus = np.concatenate([u[tuple(lo)], u[tuple(last)]], axis=axis)     # u[i+1], clamped
        out += shifted_minus + shifted_plus
    return out


def neighbor_sum(u: np.ndarray) -> np.ndarray:
    """Public alias used by the legacy explicit solver."""
    return _neighbor_sum(u)


def _parity_mask(shape: tuple[int, ...]) -> np.ndarray:
    grids = np.indices(shape)
    return (grids.sum(axis=0) % 2) == 0


def solve_quasi_steady(
    initial: np.ndarray,
    *,
    diffusion: float,
    source: np.ndarray,
    linear_sink: np.ndarray | None = None,
    mm_vmax: float | None = None,
    mm_km: float = 0.25,
    density: np.ndarray | None = None,
    fixed_mask: np.ndarray | None = None,
    fixed_values: np.ndarray | None = None,
    omega: float = 1.7,
    tolerance: float = 1e-7,
    max_iterations: int = 5000,
    clamp: tuple[float, float] | None = (0.0, 1.0)
) -> SolveResult:
    """Solve D*lap(u) - sink(u)*u + source = 0 by red-black SOR.

    ``linear_sink`` is a per-site first-order removal rate (same units as
    ``diffusion``). If ``mm_vmax`` is given, Michaelis-Menten uptake
    ``vmax * u / (km + u) * density`` is added through the Picard linearisation
    ``vmax / (km + u) * density``. Sites in ``fixed_mask`` are held at
    ``fixed_values`` (Dirichlet).
    """
    u = np.array(initial, dtype=float, copy=True)
    axes = _active_axes(u)
    ndim = max(1, len(axes))
    red = _parity_mask(u.shape)
    masks = (red, ~red)
    source = np.asarray(source, dtype=float)
    sink_base = np.zeros_like(u) if linear_sink is None else np.asarray(linear_sink, dtype=float)
    dens = None if density is None else np.asarray(density, dtype=float)
    if fixed_mask is not None:
        fixed_mask = np.asarray(fixed_mask, dtype=bool)
        fixed_values = np.asarray(fixed_values, dtype=float)

    def sink_of(field: np.ndarray) -> np.ndarray:
        if mm_vmax is None or dens is None:
            return sink_base
        return sink_base + np.where(dens > 0, mm_vmax / (mm_km + np.maximum(field, 1e-9)) * dens, 0.0)

    if diffusion <= 0:
        sink = sink_of(u)
        with np.errstate(divide="ignore", invalid="ignore"):
            steady = np.where(sink > 0, source / np.maximum(sink, 1e-12), u + source)
        if fixed_mask is not None:
            steady = np.where(fixed_mask, fixed_values, steady)
        if clamp is not None:
            steady = np.clip(steady, *clamp)
        return SolveResult(steady, 0, True, 0.0)

    stencil = 2.0 * ndim * diffusion
    max_change = float("inf")
    for iteration in range(1, max_iterations + 1):
        previous = u.copy()
        for mask in masks:
            sink = sink_of(u)
            candidate = (diffusion * _neighbor_sum(u, axes) + source) / (stencil + sink)
            if fixed_mask is not None:
                candidate = np.where(fixed_mask, fixed_values, candidate)
            updated = u + omega * (candidate - u)
            if clamp is not None:
                updated = np.clip(updated, *clamp)
            u = np.where(mask, updated, u)
        max_change = float(np.abs(u - previous).max())
        if max_change < tolerance:
            return SolveResult(u, iteration, True, max_change)
    return SolveResult(u, max_iterations, False, max_change)


def residual(
    u: np.ndarray,
    *,
    diffusion: float,
    source: np.ndarray,
    sink: np.ndarray,
    fixed_mask: np.ndarray | None = None
) -> np.ndarray:
    """Pointwise |D*lap(u) - sink*u + source| for diagnostics and tests."""
    axes = _active_axes(u)
    lap = _neighbor_sum(u, axes) - 2.0 * len(axes) * u
    res = np.abs(diffusion * lap - sink * u + source)
    if fixed_mask is not None:
        res = np.where(fixed_mask, 0.0, res)
    return res


def dense_reference_solve(
    *,
    diffusion: float,
    source: np.ndarray,
    sink: np.ndarray,
    fixed_mask: np.ndarray | None = None,
    fixed_values: np.ndarray | None = None
) -> np.ndarray:
    """Direct dense solve of the same discretised linear system (tests only; 2D or 3D)."""
    source = np.asarray(source, dtype=float)
    shape = source.shape
    axes = _active_axes(source)
    n = int(np.prod(shape))
    matrix = np.zeros((n, n))
    rhs = np.zeros(n)
    for flat in range(n):
        idx = np.unravel_index(flat, shape)
        if fixed_mask is not None and fixed_mask[idx]:
            matrix[flat, flat] = 1.0
            rhs[flat] = fixed_values[idx]
            continue
        matrix[flat, flat] = 2.0 * len(axes) * diffusion + sink[idx]
        for axis in axes:
            for step in (-1, 1):
                nidx = list(idx)
                nidx[axis] = min(max(nidx[axis] + step, 0), shape[axis] - 1)
                matrix[flat, np.ravel_multi_index(tuple(nidx), shape)] -= diffusion
        rhs[flat] = source[idx]
    return np.linalg.solve(matrix, rhs).reshape(shape)
