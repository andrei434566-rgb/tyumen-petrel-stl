"""Export a Petrel GRDECL property class as a surface in millimetres.

Requires Python 3.11+ and numpy, numba, scipy, scikit-image, trimesh, manifold3d.
"""

import argparse
import math
import re
from pathlib import Path
from tempfile import NamedTemporaryFile

import numpy as np


def numeric_chunks(path, keyword):
    """Stream the named numeric section, expanding ECLIPSE count*value tokens."""
    section = keyword.upper().encode("ascii")
    with path.open("rb") as stream:
        for line in stream:
            tokens = line.split(b"--", 1)[0].split(maxsplit=1)
            if tokens and tokens[0].upper() == section:
                first = tokens[1] if len(tokens) > 1 else b""
                break
        else:
            raise ValueError(f"{keyword} section is missing in {path}")

        while True:
            if first:
                chunk, first = first, b""
            else:
                chunk = stream.read(4 * 1024**2)
                if chunk and not chunk.endswith(b"\n"):
                    chunk += stream.readline()
            if not chunk:
                raise ValueError(f"Unterminated {keyword} section in {path}")

            if b"--" in chunk:
                chunk = re.sub(rb"--[^\r\n]*", b"", chunk)
            chunk, terminator, _ = chunk.partition(b"/")
            if chunk.strip():
                normalized = chunk.replace(b"D", b"E").replace(b"d", b"e")
                plain = normalized.replace(b"*", b" ")
                values = np.fromstring(plain.decode("ascii"), sep=" ", dtype=np.float64)
                if b"*" in normalized:
                    stars = np.flatnonzero(np.frombuffer(normalized, dtype=np.uint8) == ord("*"))
                    nonspace = np.frombuffer(plain, dtype=np.uint8) > ord(" ")
                    nonspace[1:] &= ~nonspace[:-1].copy()
                    starts = np.flatnonzero(nonspace)
                    repeated = np.searchsorted(starts, stars)
                    if (
                        len(starts) != len(values)
                        or np.any(repeated <= 0)
                        or np.any(repeated >= len(values))
                        or np.any(starts[repeated] != stars + 1)
                    ):
                        raise ValueError(f"Invalid repetition in {keyword} in {path}")
                    counts = values[repeated - 1].astype(np.int64)
                    if np.any(counts < 1) or np.any(counts != values[repeated - 1]):
                        raise ValueError(f"Invalid repetition count in {keyword} in {path}")
                    repeats = np.ones(len(values), dtype=np.int64)
                    repeats[repeated - 1] = 0
                    repeats[repeated] = counts
                    values = np.repeat(values, repeats)
                yield values

            if terminator:
                return


def read_array(path, keyword, count, dtype):
    result = np.empty(count, dtype=dtype)
    offset = 0
    for chunk in numeric_chunks(path, keyword):
        end = offset + len(chunk)
        if end > count:
            raise ValueError(f"{keyword} has more than {count:,} values in {path}")
        if np.issubdtype(dtype, np.integer):
            limits = np.iinfo(dtype)
            if np.any((chunk < limits.min) | (chunk > limits.max) | (chunk != np.trunc(chunk))):
                raise ValueError(f"{keyword} contains invalid category values in {path}")
        result[offset:end] = chunk
        offset = end
    if offset != count:
        raise ValueError(f"Expected {count:,} values for {keyword} in {path}, found {offset:,}")
    return result


def read_deck(deck):
    content = re.sub(r"--[^\r\n]*", "", deck.read_text(encoding="ascii"))
    dimensions = re.search(r"\bSPECGRID\s+(\d+)\s+(\d+)\s+(\d+)", content, re.I)
    if not dimensions:
        raise ValueError(f"SPECGRID is missing in {deck}")
    shape = tuple(int(n) for n in reversed(dimensions.groups()))
    includes = re.findall(r"\bINCLUDE\s+['\"]([^'\"]+)['\"]\s*/", content, re.I)
    sections = {name: deck for name in ("COORD", "ZCORN", "ACTNUM")}
    for name in includes:
        path = deck.parent / name
        with path.open("rb") as stream:
            for line in stream:
                section = line.split(b"--", 1)[0].split(maxsplit=1)
                if section:
                    keyword = section[0].decode("ascii").upper()
                    if keyword in sections:
                        sections[keyword] = path
                    break
    return shape, sections


def read_property(deck, property_file, keyword):
    shape, sections = read_deck(deck)
    count = math.prod(shape)
    active = read_array(sections["ACTNUM"], "ACTNUM", count, np.int8) > 0
    categories = read_array(property_file, keyword, count, np.int16)
    return shape, sections, active, categories


def cell_geometry(shape, sections, selected):
    nz, ny, nx = shape
    pillars = read_array(sections["COORD"], "COORD", (nx + 1) * (ny + 1) * 6, np.float64)
    pillars = pillars.reshape(ny + 1, nx + 1, 6)
    k, j, i = np.unravel_index(np.flatnonzero(selected), shape)

    # ZCORN is indexed as (2*NZ, 2*NY, 2*NX), fastest in I.
    base = ((2 * k) * (2 * ny) + 2 * j) * (2 * nx) + 2 * i
    offsets = [((dz * 2 * ny) + dy) * 2 * nx + dx
               for dz in range(2) for dy in range(2) for dx in range(2)]
    corner_depths = np.empty((len(i), 8), dtype=np.float64)
    positions = [base + offset for offset in offsets]
    starts = [0] * 8
    absolute = 0
    for chunk in numeric_chunks(sections["ZCORN"], "ZCORN"):
        end = absolute + len(chunk)
        for corner, indices in enumerate(positions):
            start = starts[corner]
            stop = np.searchsorted(indices, end)
            corner_depths[start:stop, corner] = chunk[indices[start:stop] - absolute]
            starts[corner] = stop
        absolute = end
    if absolute != 8 * math.prod(shape):
        raise ValueError(f"Unexpected ZCORN size: {absolute:,} values")

    print(f"Read corners of {len(i):,} selected cells", flush=True)
    geometry = np.empty((len(i), 8, 3), dtype=np.float64)
    for corner in range(4):
        dy, dx = divmod(corner, 2)
        pillar = pillars[j + dy, i + dx]
        top, bottom = pillar[:, :3], pillar[:, 3:]
        vector = bottom - top
        for index in (corner, corner + 4):
            depth = corner_depths[:, index]
            fraction = np.divide(depth - top[:, 2], vector[:, 2],
                                 out=np.zeros_like(depth), where=vector[:, 2] != 0)
            geometry[:, index, :2] = top[:, :2] + vector[:, :2] * fraction[:, None]
            geometry[:, index, 2] = -depth
    if not np.isfinite(geometry).all():
        raise ValueError("Non-finite values in selected cell geometry")
    return geometry


def sample_cells(geometry, size_mm, vertical_scale, spacing_mm):
    from numba import njit

    points = geometry.reshape(-1, 3)
    low = points.min(axis=0)
    spans = points.max(axis=0) - low
    if min(spans) <= 0:
        raise ValueError("Selected cells do not span a 3D volume")
    scale = size_mm / max(spans[:2])
    points -= low
    points *= (scale, scale, scale * vertical_scale)
    points /= spacing_mm
    points += 1.5  # Keep an empty border for a closed contour.
    shape = tuple(int(n) + 2 for n in np.ceil(points.max(axis=0)))
    if math.prod(shape) > 250_000_000:
        raise ValueError(f"Sampling grid {shape} is too large. Increase the sampling interval.")
    occupancy = np.zeros(shape, dtype=bool)
    print(f"Sampling physical space on a {shape} grid at {spacing_mm} mm", flush=True)

    # Every cell uses the same body diagonal and the same split on shared faces.
    tetrahedra = np.array([[0, 1, 3, 7], [0, 1, 5, 7], [0, 2, 3, 7],
                           [0, 2, 6, 7], [0, 4, 5, 7], [0, 4, 6, 7]])
    njit(rasterize)(geometry, occupancy, tetrahedra)
    return occupancy


def rasterize(cells, occupancy, tetrahedra):
    for cell in cells:
        for tetra in tetrahedra:
            a, b, c, d = cell[tetra[0]], cell[tetra[1]], cell[tetra[2]], cell[tetra[3]]
            x_start = math.ceil(min(a[0], b[0], c[0], d[0]))
            x_stop = math.floor(max(a[0], b[0], c[0], d[0])) + 1
            y_start = math.ceil(min(a[1], b[1], c[1], d[1]))
            y_stop = math.floor(max(a[1], b[1], c[1], d[1])) + 1
            z_start = math.ceil(min(a[2], b[2], c[2], d[2]))
            z_stop = math.floor(max(a[2], b[2], c[2], d[2])) + 1
            if x_start >= x_stop or y_start >= y_stop or z_start >= z_stop:
                continue

            ab, ac, ad = b - a, c - a, d - a
            normal_b = np.cross(ac, ad)
            determinant = np.dot(ab, normal_b)
            if abs(determinant) < 1e-10:
                continue  # Pinched cells may have zero-volume tetrahedra.
            normal_b /= determinant
            normal_c = np.cross(ad, ab) / determinant
            normal_d = np.cross(ab, ac) / determinant
            epsilon = 1e-8
            for x in range(x_start, x_stop):
                dx = x - a[0]
                for y in range(y_start, y_stop):
                    dy = y - a[1]
                    b_xy = dx * normal_b[0] + dy * normal_b[1]
                    c_xy = dx * normal_c[0] + dy * normal_c[1]
                    d_xy = dx * normal_d[0] + dy * normal_d[1]
                    for z in range(z_start, z_stop):
                        dz = z - a[2]
                        wb = b_xy + dz * normal_b[2]
                        wc = c_xy + dz * normal_c[2]
                        wd = d_xy + dz * normal_d[2]
                        if min(wb, wc, wd) >= -epsilon and wb + wc + wd <= 1 + epsilon:
                            occupancy[x, y, z] = True


def write_surface(occupancy, spacing_mm, output):
    from manifold3d import Error, Manifold, Mesh
    from skimage.measure import marching_cubes
    import trimesh

    if not occupancy.any():
        raise ValueError("No cell interiors were sampled. Decrease --pitch-mm.")
    # Avoid the exact saddle at 0.5 when diagonally touching samples form a checkerboard.
    vertices, faces, _, _ = marching_cubes(occupancy, level=0.55, allow_degenerate=False)
    vertices *= spacing_mm
    vertices -= vertices.min(axis=0)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    if mesh.volume < 0:
        mesh.invert()
    if not mesh.is_volume:
        raise ValueError(f"Invalid solid for {output.name}: closed={mesh.is_watertight}, "
                         f"consistent winding={mesh.is_winding_consistent}, volume={mesh.volume:g}")
    solid = Manifold(Mesh(np.asarray(mesh.vertices, dtype=np.float32),
                          np.asarray(mesh.faces, dtype=np.uint32)))
    if solid.is_empty() or solid.status() != Error.NoError:
        raise ValueError(f"Manifold validation failed for {output.name}: {solid.status()}")
    del solid

    output.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=output.parent, prefix=output.stem + "_", suffix=".tmp", delete=False) as handle:
        temporary = Path(handle.name)
    try:
        mesh.export(temporary, file_type="stl")
        round_trip = trimesh.load_mesh(temporary, file_type="stl")
        if not round_trip.is_volume or len(round_trip.faces) != len(mesh.faces):
            raise ValueError(f"STL round-trip validation failed for {output.name}")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    print(f"{output}: {len(mesh.faces):,} triangles, {mesh.extents.round(2)} mm, "
          f"{mesh.volume:.1f} mm³", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("deck", type=Path, help="Main GRDECL file containing SPECGRID")
    parser.add_argument("property", type=Path, help="GRDECL file containing the cell property")
    parser.add_argument("--keyword", required=True, help="Property keyword, e.g. FLUIDS")
    parser.add_argument("--code", type=int, help="Selected property code")
    parser.add_argument("--output", type=Path, help="Write the complete selection as STL")
    parser.add_argument("--largest-output", type=Path, help="Also write the largest connected body as STL")
    parser.add_argument("--size-mm", type=float, default=140, help="Longest horizontal dimension")
    parser.add_argument("--vertical-scale", type=float, default=1, help="Vertical exaggeration factor")
    parser.add_argument("--pitch-mm", type=float, default=0.25, help="Horizontal sampling interval")
    parser.add_argument("--layer-pitch-mm", type=float, help="Vertical sampling interval (defaults to --pitch-mm)")
    args = parser.parse_args()
    layer_pitch = args.pitch_mm if args.layer_pitch_mm is None else args.layer_pitch_mm

    if (args.output or args.largest_output) and args.code is None:
        parser.error("STL export requires --code")
    if any(path and path.suffix.lower() != ".stl" for path in (args.output, args.largest_output)):
        parser.error("Output filenames must end in .stl")
    if args.output and args.largest_output and args.output.resolve() == args.largest_output.resolve():
        parser.error("Give the complete selection and largest body different filenames")
    if any(not math.isfinite(value) or value <= 0
           for value in (args.size_mm, args.vertical_scale, args.pitch_mm, layer_pitch)):
        parser.error("Size, vertical scale and pitch must be positive finite numbers")

    shape, sections, active, categories = read_property(args.deck, args.property, args.keyword)
    print(f"{args.deck.stem}: {shape[::-1]}, {np.count_nonzero(active):,} active cells", flush=True)
    for label, count in zip(*np.unique(categories[active], return_counts=True)):
        print(f"Code {label}: {count:,}", flush=True)
    if args.code is not None:
        selected = active & (categories == args.code)
        if not np.any(selected):
            parser.error(f"No active cells have code {args.code}")
        geometry = cell_geometry(shape, sections, selected)
        pts = geometry.reshape(-1, 3)
        print(f"Grid-local bounds (m): {pts.min(axis=0)} to {pts.max(axis=0)}", flush=True)
        thickness = (geometry[:, :4, 2] - geometry[:, 4:, 2]).mean(axis=1)
        print(f"Mean cell thickness percentiles, m: {np.percentile(thickness, [0, 5, 50, 95, 100])}", flush=True)
        if args.output or args.largest_output:
            spacing = (args.pitch_mm, args.pitch_mm, layer_pitch)
            occupancy = sample_cells(geometry, args.size_mm, args.vertical_scale, spacing)
            del geometry, pts
            if args.output:
                write_surface(occupancy, spacing, args.output)
            if args.largest_output:
                from scipy.ndimage import label

                regions, count = label(occupancy)
                if not count:
                    parser.error("No connected bodies were sampled")
                sizes = np.bincount(regions[occupancy], minlength=count + 1)
                biggest = 1 + sizes[1:].argmax()
                print(f"Found {count:,} bodies on the sampling grid. Largest contains "
                      f"{100 * sizes[biggest] / sizes[1:].sum():.1f}% of the sampled material.", flush=True)
                write_surface(regions == biggest, spacing, args.largest_output)


if __name__ == "__main__":
    main()
