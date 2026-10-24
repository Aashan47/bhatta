"""Shared constants and geometry helpers for the Bhatta kiln pipeline.

Facts about SentinelKilnDB that these helpers encode (checked against the parquet files and
the benchmark scripts at github.com/rishabh-mondal/NeurIPS_2025, data_scripts/):

* Images were exported from Google Earth Engine (COPERNICUS/S2_SR_HARMONIZED, bands B4,B3,B2) at
  scale=10 in EPSG:4326, so one pixel is 10/111319.49 degrees on BOTH axes. Neighbouring patch
  centres in the parquet differ by 0.0088 deg in lat and in lon (98 px stride, 30 px overlap),
  which confirms the degree grid.
* Each 128 x 128 patch is rendered per patch and per band with min-max scaling:
  ((b - b.min()) / (b.max() - b.min() + 1e-5) * 255).astype(uint8)   (tile_processing.py, norm()).
* File names are "<lat_center>_<lon_center>.png" with 4 decimals; the centre is the patch centre.
  The patch polygon used to normalise labels spans 129 pixels (rasterio xy with offset 'lr' on
  pixel x0+128), so label coordinates are normalised by 129 * PIX_DEG.
* Label classes: 0 CFCBK, 1 FCBK, 2 Zigzag. YOLO-OBB y is measured from the top of the image.
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
RAW = DATA / "raw"
WORK = ROOT / "ml" / "work"
RUNS = ROOT / "ml" / "runs"

SEED = 20261024
BLOCK_DEG = 0.5
EDGE_BUFFER_KM = 1.3
ALPHA = 0.10

PATCH = 128
PIX_DEG = 10.0 / 111319.49
EXTENT_DEG = 129 * PIX_DEG  # label normalisation span, see module docstring
CLASS_NAMES_SRC = {0: "CFCBK", 1: "FCBK", 2: "Zigzag"}
CLS2 = ["FCBK", "Zigzag"]  # classifier classes, CFCBK folded into FCBK
KM_PER_DEG = 111.32

# crop size (pixels in the 128 px patch) for the FCBK vs Zigzag classifier
CROP = 32
CROP_INPUT = 96  # resized input to the CNN

AOI_DEFAULT = (73.6, 30.8, 74.8, 32.0)  # lon_min, lat_min, lon_max, lat_max


def parse_name(name: str) -> tuple[float, float]:
    stem = name[:-4] if name.endswith(".png") else name
    lat, lon = stem.split("_")
    return float(lat), float(lon)


def patch_bounds(lat_c: float, lon_c: float) -> tuple[float, float, float, float]:
    h = EXTENT_DEG / 2
    return lon_c - h, lat_c - h, lon_c + h, lat_c + h


def norm_to_lonlat(u: np.ndarray, v: np.ndarray, lat_c: float, lon_c: float):
    """Normalised patch coords (u right, v down, in [0,1]) to lon, lat."""
    lon0, lat0, lon1, lat1 = patch_bounds(lat_c, lon_c)
    return lon0 + u * (lon1 - lon0), lat1 - v * (lat1 - lat0)


def lonlat_to_norm(lon: np.ndarray, lat: np.ndarray, lat_c: float, lon_c: float):
    lon0, lat0, lon1, lat1 = patch_bounds(lat_c, lon_c)
    return (lon - lon0) / (lon1 - lon0), (lat1 - lat) / (lat1 - lat0)


def minmax_u8(band: np.ndarray) -> np.ndarray:
    """Exact SentinelKilnDB per-patch, per-band rendering."""
    band = band.astype(np.float64)
    return ((band - band.min()) / (band.max() - band.min() + 1e-5) * 255).astype(np.uint8)


def render_rgb(r: np.ndarray, g: np.ndarray, b: np.ndarray) -> np.ndarray:
    return np.dstack((minmax_u8(r), minmax_u8(g), minmax_u8(b)))


def km_xy(lon, lat, lat_ref: float = 30.5):
    """Local equirectangular km coordinates, good enough for neighbour searches."""
    return (np.asarray(lon) * KM_PER_DEG * math.cos(math.radians(lat_ref)),
            np.asarray(lat) * KM_PER_DEG)


def block_of(lat: float, lon: float) -> tuple[int, int]:
    return int(math.floor(lat / BLOCK_DEG)), int(math.floor(lon / BLOCK_DEG))


def dist_point_rect_km(lat, lon, rect):
    """Distance in km from a point to an axis-aligned lon/lat rectangle (lon0, lat0, lon1, lat1)."""
    lon0, lat0, lon1, lat1 = rect
    dlon = max(lon0 - lon, 0.0, lon - lon1)
    dlat = max(lat0 - lat, 0.0, lat - lat1)
    return math.hypot(dlon * KM_PER_DEG * math.cos(math.radians(lat)), dlat * KM_PER_DEG)


def geohash(lat: float, lon: float, precision: int = 8) -> str:
    import pygeohash
    return pygeohash.encode(lat, lon, precision=precision)


def sha256(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
