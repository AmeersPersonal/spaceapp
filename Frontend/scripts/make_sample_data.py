"""Generates SAMPLE radar-like images, observed hazard zones and FORECAST
hazard zones so the frontend can be built before real NISAR data is processed.

Study area: Aso caldera, Kumamoto Prefecture, Japan. The active vent is
Nakadake. NOT REAL DATA — the shapes are invented, only the geography is real.
Dates use NISAR's 12-day repeat cycle.
"""
import json, sys
import numpy as np
from PIL import Image, ImageFilter

out = sys.argv[1]
W = H = 512
west, south, east, north = 130.85, 32.70, 131.35, 33.06
rng = np.random.default_rng(11)

# Ground scale of one pixel, used to put things at believable distances.
KM_LAT = 110.57
KM_LON = 111.32 * np.cos(np.radians(32.88))
PX_PER_KM_X = W / ((east - west) * KM_LON)
PX_PER_KM_Y = H / ((north - south) * KM_LAT)

# Nakadake crater — the active vent — and the caldera around it.
CRATER_X, CRATER_Y = 260, 250
CAL_X, CAL_Y = 238, 250
CAL_A = 9.0 * PX_PER_KM_X      # caldera is 18 km east-west
CAL_B = 12.5 * PX_PER_KM_Y     # and 25 km north-south


def smooth(sigma, seed):
    r = np.random.default_rng(seed).integers(0, 255, (H, W), dtype=np.uint8)
    a = np.asarray(Image.fromarray(r).filter(ImageFilter.GaussianBlur(sigma)), dtype=float)
    return (a - a.min()) / (a.max() - a.min())


yy, xx = np.mgrid[0:H, 0:W]

# ---------- the landscape that does not change between passes ----------
land = 80 + 55 * smooth(16, 1)                       # general terrain texture

rim = np.hypot((xx - CAL_X) / CAL_A, (yy - CAL_Y) / CAL_B)
land += 85 * np.exp(-((rim - 1.0) ** 2) / 0.006)     # caldera wall: steep, bright
land -= 24 * np.exp(-(rim ** 2) / 0.35)              # caldera floor: flat, darker

cone = np.hypot((xx - CRATER_X) / 62.0, (yy - CRATER_Y) / 40.0)
land += 72 * np.exp(-(cone ** 2) / 0.6)              # central cones, elongated E-W

# ---------- what does change: fresh ash spreading from the vent ----------
# Distance from the vent in kilometres, stretched toward the north-east so the
# deposit lies downwind instead of sitting as a disc on the crater.
from_vent = np.hypot((xx - CRATER_X) / PX_PER_KM_X, (yy - CRATER_Y) / PX_PER_KM_Y)
bearing = np.arctan2(-(yy - CRATER_Y), xx - CRATER_X)   # screen y runs downward
lobe = 1 + 0.55 * np.cos(bearing - np.radians(55))
wobble = 0.65 + 0.7 * smooth(22, 2)                     # irregular edge

dates = ["2026-09-08", "2026-09-20", "2026-10-02",
         "2026-10-14", "2026-10-26", "2026-11-07"]
ash_km = [0.8, 1.2, 1.7, 2.3, 3.0, 3.8]   # still spreading on the last pass
for d, r in zip(dates, ash_km):
    # Speckle, lightly multi-looked the way a real SAR product is: enough
    # grain to read as radar, not enough to bury the terrain under it.
    speckle = rng.gamma(20.0, 1 / 20.0, (H, W))
    speckle = np.asarray(
        Image.fromarray((speckle * 100).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7)),
        dtype=float) / 100.0
    img = land * speckle
    # Fresh ash smooths the ground, so less signal comes back and it goes dark.
    # A soft edge keeps the deposit from looking like a drawn shape.
    edge = np.clip((r * lobe * wobble - from_vent) / 1.2, 0, 1)
    img *= 1 - 0.78 * edge
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(f"{out}/radar_{d}.png")

# ---------- hazard zones, as rings of a given radius around the vent ----------
CRATER_LON = west + CRATER_X / W * (east - west)
CRATER_LAT = north - CRATER_Y / H * (north - south)


def blob(radius_km, seed, n=72):
    """A ring at radius_km from the vent, nudged in and out so it reads as
    something derived from data rather than a drawn circle."""
    r = np.random.default_rng(seed)
    bump = 1 + 0.13 * r.standard_normal(n)
    # Smooth across the wrap so the ring closes without a kink.
    bump = np.convolve(np.r_[bump, bump, bump], np.ones(9) / 9, "same")[n:2 * n]
    ring = []
    for a, b in zip(np.linspace(0, 2 * np.pi, n, endpoint=False), bump):
        rad = radius_km * b
        ring.append([round(CRATER_LON + rad / KM_LON * np.cos(a), 5),
                     round(CRATER_LAT + rad / KM_LAT * np.sin(a), 5)])
    return [ring + [ring[0]]]


def zones(path, high_km, medium_km, seed):
    fc = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"risk": "medium"},
         "geometry": {"type": "Polygon", "coordinates": blob(medium_km, seed)}},
        {"type": "Feature", "properties": {"risk": "high"},
         "geometry": {"type": "Polygon", "coordinates": blob(high_km, seed + 1)}},
    ]}
    json.dump(fc, open(f"{out}/{path}", "w"))


# Zones for what has already been observed. High = ballistics and pyroclastic
# flow, medium = ashfall. Roughly matches the exclusion radius JMA uses at
# alert level 2.
zones("risk_zones.geojson", 2.0, 5.0, 100)

# PLACEHOLDER model output: the zones widen as the predicted peak approaches,
# then pull back.
forecast = [
    ("2026-11-19", 3.0, 7.0),
    ("2026-12-01", 4.0, 9.0),
    ("2026-12-13", 5.5, 12.0),
    ("2026-12-25", 4.0, 8.0),
]
for i, (d, hi, med) in enumerate(forecast):
    zones(f"risk_forecast_{d}.geojson", hi, med, 200 + i * 2)

print("ok")
