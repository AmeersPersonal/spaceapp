"""Generates SAMPLE radar-like images, observed hazard zones and FORECAST hazard
zones for every disaster type the backend has a data source for, so the map can
show all of them before real NISAR data is processed.

    earthquake  Kahramanmaras, Turkiye        backend: USGS earthquakes + NISAR
    wildfire    San Gabriel Mtns, California  backend: FIRMS, HLS, GEOS-FP, SMAP
    flood       Sylhet, Bangladesh            backend: GPM IMERG, NASADEM, SMAP
    landslide   Wayanad, Kerala, India        backend: GPM IMERG, NASADEM, SMAP
    drought     San Joaquin Valley, Calif.    backend: SMAP, GRACE, GPM IMERG
    glacier     Jakobshavn Isbrae, Greenland  backend: GRACE, HLS

The volcano (Mount Aso) has its own script: make_sample_data.py.

NOT REAL DATA. Only the geography is real; every shape is invented.
Dates use NISAR's 12-day repeat cycle.

    python scripts/make_disaster_samples.py public/data
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

OUT = sys.argv[1]
N = 384                       # image size in pixels
KM_LAT = 110.57
DATES = ["2026-09-08", "2026-09-20", "2026-10-02",
         "2026-10-14", "2026-10-26", "2026-11-07"]
FORECAST_DATES = ["2026-11-19", "2026-12-01", "2026-12-13", "2026-12-25"]


def noise(sigma, seed):
    r = np.random.default_rng(seed).integers(0, 255, (N, N), dtype=np.uint8)
    a = np.asarray(Image.fromarray(r).filter(ImageFilter.GaussianBlur(sigma)), dtype=float)
    return (a - a.min()) / (a.max() - a.min())


def cell_hash(ix, iy, salt):
    """Repeatable pseudo-random 0..1 per grid cell (field parcels etc.)."""
    v = np.sin(ix * 12.9898 + iy * 78.233 + salt * 37.719) * 43758.5453
    return v - np.floor(v)


def soft(x, width):
    return np.clip(x / width, 0, 1)


def smooth_ring(values, k=9):
    n = len(values)
    return np.convolve(np.r_[values, values, values], np.ones(k) / k, "same")[n:2 * n]


class Site:
    """One study area. Positions are kilometres east (x) / north (y) of the centre."""

    def __init__(self, sid, west, south, east, north, seed):
        self.id, self.seed = sid, seed
        self.clon, self.clat = (west + east) / 2, (south + north) / 2
        self.km_lon = 111.32 * np.cos(np.radians(self.clat))
        lon = west + (np.arange(N) + 0.5) / N * (east - west)
        lat = north - (np.arange(N) + 0.5) / N * (north - south)
        lon, lat = np.meshgrid(lon, lat)
        self.x = (lon - self.clon) * self.km_lon
        self.y = (lat - self.clat) * KM_LAT
        self.rng = np.random.default_rng(seed)
        self.dir = os.path.join(OUT, sid)
        os.makedirs(self.dir, exist_ok=True)

    def km(self, lon, lat):
        return (lon - self.clon) * self.km_lon, (lat - self.clat) * KM_LAT

    def lonlat(self, x, y):
        return [round(float(self.clon + x / self.km_lon), 5), round(float(self.clat + y / KM_LAT), 5)]

    def noise(self, sigma, k):
        return noise(sigma, self.seed * 100 + k)

    def rotated(self, cx, cy, rot):
        t = np.radians(rot)
        dx, dy = self.x - cx, self.y - cy
        return dx * np.cos(t) + dy * np.sin(t), -dx * np.sin(t) + dy * np.cos(t)

    def ellipse(self, cx, cy, a, b, rot=0):
        u, v = self.rotated(cx, cy, rot)
        return np.hypot(u / a, v / b)

    # ---------- output ----------

    def save_images(self, backscatter_for_date):
        for i, d in enumerate(DATES):
            # Lightly multi-looked speckle, same recipe as the Aso sample.
            sp = self.rng.gamma(20.0, 1 / 20.0, (N, N))
            sp = np.asarray(Image.fromarray((sp * 100).astype(np.uint8))
                            .filter(ImageFilter.GaussianBlur(0.7)), dtype=float) / 100.0
            img = backscatter_for_date(i) * sp
            Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(
                os.path.join(self.dir, f"radar_{d}.png"), optimize=True)

    def blob(self, cx, cy, a, b, rot, seed, n=72):
        """Ellipse (km) nudged in and out so it reads as derived from data."""
        bump = smooth_ring(1 + 0.12 * np.random.default_rng(seed).standard_normal(n))
        t = np.radians(rot)
        ring = []
        for ang, k in zip(np.linspace(0, 2 * np.pi, n, endpoint=False), bump):
            u, v = a * k * np.cos(ang), b * k * np.sin(ang)
            ring.append(self.lonlat(cx + u * np.cos(t) - v * np.sin(t),
                                    cy + u * np.sin(t) + v * np.cos(t)))
        return ring + [ring[0]]

    def band(self, centre_fn, x0, x1, half_width, seed, n=80):
        """A corridor of half_width km either side of the line y = centre_fn(x)."""
        xs = np.linspace(x0, x1, n)
        r = np.random.default_rng(seed)
        top = half_width * (1 + 0.15 * np.convolve(r.standard_normal(n), np.ones(7) / 7, "same"))
        bot = half_width * (1 + 0.15 * np.convolve(r.standard_normal(n), np.ones(7) / 7, "same"))
        ring = [self.lonlat(x, centre_fn(x) + w) for x, w in zip(xs, top)]
        ring += [self.lonlat(x, centre_fn(x) - w) for x, w in zip(xs[::-1], bot[::-1])]
        return ring + [ring[0]]

    def write_zones(self, name, features):
        fc = {"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {"risk": risk},
             "geometry": {"type": "Polygon", "coordinates": [ring]}}
            for risk, ring in sorted(features, key=lambda f: f[0] != "medium")
        ]}
        with open(os.path.join(self.dir, name), "w") as f:
            json.dump(fc, f)

    def write_all_zones(self, zones_for):
        """zones_for(step) -> list of (risk, ring). step 'now' or a forecast index."""
        self.write_zones("risk_zones.geojson", zones_for("now"))
        for i, d in enumerate(FORECAST_DATES):
            self.write_zones(f"risk_forecast_{d}.geojson", zones_for(i))


# =====================================================================
# Earthquake: East Anatolian Fault near Kahramanmaras. The mainshock lands
# between pass 2 and pass 3; aftershock-triggered landslides keep adding up.
# =====================================================================
def earthquake():
    s = Site("earthquake", 36.70, 37.00, 37.35, 37.62, 21)
    FAULT = 40                                   # strike, degrees from east
    u, v = s.rotated(0, 0, FAULT)
    land = 70 + 60 * s.noise(10, 1) + 30 * s.noise(3, 2)
    land += 14 * np.sin(v / 1.6 + 6 * s.noise(20, 3))      # ridges parallel to the fault
    cx, cy = s.km(36.93, 37.58)                              # Kahramanmaras city
    city = np.exp(-((s.x - cx) ** 2 + (s.y - cy) ** 2) / (2 * 3.2 ** 2))
    blocks = s.noise(1, 4) > 0.5
    land += 120 * city * blocks

    trace = v - 0.6 * (s.noise(25, 5) - 0.5)                 # fault trace, slightly wavy
    rupture_len = 26
    on_fault = soft(rupture_len - np.abs(u), 2)
    r = np.random.default_rng(22)
    slides = [(r.uniform(-20, 20), r.normal(0, 4), r.uniform(0.5, 0.9), r.uniform(1.0, 2.2))
              for _ in range(48)]
    counts = [0, 0, 22, 32, 40, 48]

    def date(i):
        img = land.copy()
        if i < 2:
            return img
        img *= 1 - 0.65 * on_fault * soft(0.7 - np.abs(trace), 0.3)        # dark scarp
        img *= 1 + 0.9 * on_fault * soft(0.7 - np.abs(trace - 1.1), 0.3)   # bright uplifted side
        for su, sv, w, ln in slides[:counts[i]]:
            d = np.hypot((u - su) / ln, (v - sv) / w)
            img *= 1 - 0.6 * soft(1 - d, 0.3)
        img *= 1 - 0.55 * city * blocks * (s.noise(1.5, 6) > 0.55)          # collapsed blocks
        return img

    s.save_images(date)

    def along(d):                                            # point d km NE along the fault
        t = np.radians(FAULT)
        return d * np.cos(t), d * np.sin(t)

    def zones(step):
        shift, ha, hb, ma, mb = {"now": (0, 16, 3.5, 28, 9),
                                 0: (3, 18, 4, 30, 10), 1: (6, 20, 4.5, 32, 11),
                                 2: (4, 16, 3.5, 27, 9), 3: (2, 13, 3, 22, 7)}[step]
        c = along(shift)
        seed = 300 + (0 if step == "now" else 10 + step * 2)
        return [("medium", s.blob(*c, ma, mb, FAULT, seed)),
                ("high", s.blob(*c, ha, hb, FAULT, seed + 1))]

    s.write_all_zones(zones)


# =====================================================================
# Wildfire: San Gabriel Mountains above the LA basin. Santa Ana winds push
# the fire south-west; the burn scar loses vegetation and goes dark.
# =====================================================================
def wildfire():
    s = Site("wildfire", -118.35, 34.18, -117.85, 34.50, 31)
    land = 40 + 150 * s.noise(7, 1) + 30 * s.noise(2, 2)     # chaparral on steep slopes
    edge_y = s.km(0, 34.235)[1] + 1.2 * (s.noise(30, 3) - 0.5) * 4
    urban = soft(edge_y - s.y, 1.0)                           # foothill suburbs, south edge
    streets = ((s.x * 2.2) % 1 < 0.22) | ((s.y * 2.2) % 1 < 0.22)
    land = land * (1 - urban) + urban * np.where(streets, 70, 165)

    ix, iy = s.km(-118.0, 34.385)                              # ignition point
    dist = np.hypot(s.x - ix, s.y - iy)
    bearing = np.degrees(np.arctan2(s.y - iy, s.x - ix))
    lobe = 1 + 0.7 * np.cos(np.radians(bearing - 225))        # stretched downwind (SW)
    wobble = 0.7 + 0.6 * s.noise(14, 4)
    radius = [0, 1.5, 3.5, 6, 8.5, 10]

    def date(i):
        burned = soft(radius[i] * lobe * wobble - dist, 0.8) * (1 - urban)
        return land * (1 - 0.62 * burned)

    s.save_images(date)

    sw = np.radians(225)

    def zones(step):
        R = {"now": 10, 0: 12, 1: 15, 2: 16, 3: 15}[step]
        seed = 400 + (0 if step == "now" else 10 + step * 2)
        hc = (ix + 0.85 * R * np.cos(sw), iy + 0.85 * R * np.sin(sw))
        mc = (ix + 0.9 * R * np.cos(sw), iy + 0.9 * R * np.sin(sw))
        return [("medium", s.blob(*mc, 1.45 * R, 0.85 * R, 45, seed)),
                ("high", s.blob(*hc, 0.7 * R, 0.4 * R, 45, seed + 1))]

    s.write_all_zones(zones)


# =====================================================================
# Flood: the Surma river through Sylhet. Water is a mirror to radar and
# comes back almost black, so the flood shows as a spreading dark sheet.
# =====================================================================
def flood():
    s = Site("flood", 91.60, 24.65, 92.10, 25.05, 41)

    def river(x):
        return 1.6 * np.sin(x / 3.4) + 0.7 * np.sin(x / 1.3 + 1) - 2.0

    dist = np.abs(s.y - river(s.x))
    low = s.noise(14, 1)                                      # haor depressions
    parcel = cell_hash(np.floor(s.x / 0.35), np.floor(s.y / 0.35), 1)
    land = 85 + 55 * parcel + 30 * s.noise(4, 2)              # rice paddies
    hills = soft(s.y - 14 - 2 * s.noise(25, 3), 2)            # Meghalaya foothills, north
    land = land * (1 - hills) + hills * (60 + 140 * s.noise(4, 4))
    water = soft(0.25 - dist, 0.1)
    land = land * (1 - water) + 18 * water
    level = [0.2, 0.35, 1.0, 2.0, 3.4, 4.6]

    def date(i):
        flooded = soft(level[i] * (0.5 + low) - dist, 0.4) * (1 - hills)
        return land * (1 - 0.82 * flooded)

    s.save_images(date)

    def zones(step):
        hi, med = {"now": (3, 6), 0: (4.5, 8), 1: (5.5, 10), 2: (4, 8), 3: (2.5, 5)}[step]
        seed = 500 + (0 if step == "now" else 10 + step * 2)
        return [("medium", s.band(river, -24, 24, med, seed)),
                ("high", s.band(river, -22, 22, hi, seed + 1))]

    s.write_all_zones(zones)


# =====================================================================
# Landslide: Western Ghats around Wayanad. Monsoon rain on steep, saturated
# slopes; each slide leaves a rough debris track that comes back bright.
# =====================================================================
def landslide():
    s = Site("landslide", 75.95, 11.30, 76.35, 11.65, 51)
    relief = 0.6 * s.noise(6, 1) + 0.4 * s.noise(14, 2)
    land = 55 + 115 * relief + 20 * s.noise(1.5, 3)          # forested ridges
    clusters = [s.km(76.14, 11.47), s.km(76.05, 11.56), s.km(76.26, 11.38)]
    r = np.random.default_rng(52)
    slides = []
    for k in range(27):
        cx, cy = clusters[k % 3]
        slides.append((cx + r.normal(0, 2.5), cy + r.normal(0, 2.5),
                       r.uniform(200, 250), r.uniform(1.2, 2.8), r.uniform(0.35, 0.55)))
    # The big debris flow, appearing on pass 4.
    mx, my = clusters[0]
    slides.insert(9, (mx + 1.5, my + 2.5, 235, 7.0, 0.8))
    counts = [1, 2, 5, 10, 19, 28]

    def scar(sx, sy, brg, ln, w):
        t = np.radians(brg)
        along = (s.x - sx) * np.cos(t) + (s.y - sy) * np.sin(t)
        across = -(s.x - sx) * np.sin(t) + (s.y - sy) * np.cos(t)
        width = w * (0.6 + 0.4 * np.clip(along / ln, 0, 1))   # widens downhill
        return soft(width - np.abs(across), 0.15) * soft(along, 0.2) * soft(ln - along, 0.3)

    scars = [scar(*sl) for sl in slides]

    def date(i):
        img = land.copy()
        for sc in scars[:counts[i]]:
            img = img * (1 - sc) + sc * np.maximum(img * 1.9, 185)
        return img

    s.save_images(date)

    def zones(step):
        grow = {"now": 1.0, 0: 1.25, 1: 1.45, 2: 1.2, 3: 0.9}[step]
        seed = 600 + (0 if step == "now" else 10 + step * 2)
        feats = [("medium", s.blob(0.5, 0, 14 * grow, 10 * grow, 30, seed))]
        for k, (cx, cy) in enumerate(clusters):
            size = (4.5 if k == 0 else 3) * grow
            feats.append(("high", s.blob(cx, cy, size, size * 0.7, 30, seed + 1 + k)))
        return feats

    s.write_all_zones(zones)


# =====================================================================
# Drought: irrigated fields of the San Joaquin Valley. Fields that lose
# their water turn into smooth dry soil and drop out of the radar, west
# side (where surface water is cut first) before east.
# =====================================================================
def drought():
    s = Site("drought", -119.95, 36.00, -119.35, 36.45, 61)
    gx, gy = np.floor(s.x / 0.8), np.floor(s.y / 0.8)
    wet = cell_hash(gx, gy, 1)
    when = cell_hash(gx, gy, 2)                               # how soon each field dries
    roads = ((s.x / 1.6) % 1 < 0.05) | ((s.y / 1.6) % 1 < 0.05)
    land = 70 + 115 * wet + 15 * s.noise(2, 3)
    land = np.where(roads, 60, land)
    westness = np.clip(0.5 - s.x / 50, 0, 1)
    frac = [0.04, 0.1, 0.18, 0.28, 0.4, 0.5]

    def date(i):
        dry = (when < frac[i] * (0.3 + 1.4 * westness)) & ~roads
        return np.where(dry, land * 0.35 + 10, land)

    s.save_images(date)

    def zones(step):
        hx, ha, hb, ma, mb = {"now": (-14, 9, 16, 20, 22), 0: (-13, 10, 17, 22, 23),
                              1: (-12, 11, 18, 24, 24), 2: (-11, 12, 19, 25, 25),
                              3: (-11, 12, 18, 24, 24)}[step]
        seed = 700 + (0 if step == "now" else 10 + step * 2)
        return [("medium", s.blob(hx + 6, 0, ma, mb, 80, seed)),
                ("high", s.blob(hx, 0, ha, hb, 80, seed + 1))]

    s.write_all_zones(zones)


# =====================================================================
# Glacier: Jakobshavn Isbrae. The calving front retreats up the fjord;
# where glacier ice was, there is now dark open water and iceberg melange.
# =====================================================================
def glacier():
    s = Site("glacier", -50.25, 69.08, -49.35, 69.28, 71)

    def fjord_y(x):
        return 0.8 * np.sin(x / 6) - 0.5

    in_fjord = soft(2.8 + 0.6 * s.noise(10, 1) - np.abs(s.y - fjord_y(s.x)), 0.4)
    rock = 60 + 130 * s.noise(3, 2)                           # bare rock and tundra
    ice_sheet = 125 + 35 * s.noise(6, 3) + 25 * np.sin(s.y * 2.5 + 8 * s.noise(18, 4))  # flow lines
    sheet = soft(s.x - 9 - 3 * s.noise(25, 5), 2)
    land = rock * (1 - sheet) + ice_sheet * sheet
    tongue = 150 + 70 * (s.noise(1.2, 6) > 0.55)              # crevassed glacier tongue
    melange = 35 + 30 * s.noise(1.5, 7)
    front0, retreat = 4.0, [0, 0.6, 1.5, 2.6, 3.6, 4.5]
    jag = 0.8 * (s.noise(8, 8) - 0.5)

    def date(i):
        is_water = soft(front0 + retreat[i] + jag - s.x, 0.3)
        fjord = melange * is_water + tongue * (1 - is_water)
        return land * (1 - in_fjord) + fjord * in_fjord

    s.save_images(date)

    def zones(step):
        front = front0 + {"now": 4.5, 0: 5.3, 1: 6.4, 2: 7.2, 3: 7.6}[step]
        seed = 800 + (0 if step == "now" else 10 + step * 2)
        return [("medium", s.band(fjord_y, -18, front, 4.0, seed)),
                ("high", s.blob(front - 1.8, fjord_y(front - 1.8), 3.2, 3.4, 0, seed + 1))]

    s.write_all_zones(zones)


for make in (earthquake, wildfire, flood, landslide, drought, glacier):
    make()
    print("ok", make.__name__)
