"""Turn the screencast frames into a 30 fps 1920x1080 film.

Every output frame shows the latest captured frame at that moment. The camera
log from record.py is applied as a crop: the pose eases (cubic in-out) from
wherever it was to each new target, and the crop is resampled with Lanczos
from the captured frame, never from an upscaled copy. A route change gets a
short dissolve from the last frame before it.

    python compose.py   # writes picture.mp4 (no audio) and timeline.json
"""

from __future__ import annotations

import bisect
import json
import subprocess
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
TAKE = HERE / "take.json"
OUT = HERE / "picture.mp4"
TIMELINE = HERE / "timeline.json"
W, H, FPS = 1920, 1080, 30
LEAD = 0.25  # seconds of picture before the first beat


def ease(p: float) -> float:
    p = min(1.0, max(0.0, p))
    return 4 * p * p * p if p < 0.5 else 1 - (-2 * p + 2) ** 3 / 2


def camera_at(cams: list[dict], t: float) -> tuple[float, float, float]:
    pose = (1.0, W / 2, H / 2)
    for c in cams:
        if t < c["t0"]:
            break
        target = (c["s"], c["cx"], c["cy"])
        if t >= c["t1"]:
            pose = target
            continue
        e = ease((t - c["t0"]) / (c["t1"] - c["t0"]))
        # Interpolate the visible window's size in log space and its centre linearly,
        # so a push-in reads as a steady dolly instead of accelerating at the end.
        import math
        s = math.exp(math.log(pose[0]) + (math.log(target[0]) - math.log(pose[0])) * e)
        return s, pose[1] + (target[1] - pose[1]) * e, pose[2] + (target[2] - pose[2]) * e
    return pose


def main() -> None:
    take = json.loads(TAKE.read_text())
    frames = json.loads((RAW / "frames.json").read_text())
    frames.sort()
    ts = [f[0] for f in frames]
    marks, cams, fades = take["marks"], take["cams"], take["fades"]
    t0 = marks[0]["at"] - LEAD
    t1 = take["end"]
    cuts = sorted((f["t_nav"], f["t"]) for f in fades)
    removed = sum(b - a for a, b in cuts)

    def capture_time(t_out: float) -> float:
        c = t0 + t_out
        for a, b in cuts:
            if c >= a:
                c += b - a
        return c

    def out_time(c: float) -> float:
        return c - t0 - sum(b - a for a, b in cuts if b <= c)

    n = int((t1 - t0 - removed) * FPS)
    print(f"cut {removed:.1f}s of page loading from {len(cuts)} route changes", flush=True)
    print(f"{len(frames)} captured frames, {n} output frames, {(t1 - t0):.1f}s", flush=True)

    ff = subprocess.Popen(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "17",
                           "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(OUT)],
                          stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    cache: dict[int, Image.Image] = {}

    def frame(i: int) -> Image.Image:
        if i not in cache:
            if len(cache) > 6:
                cache.pop(next(iter(cache)))
            im = Image.open(RAW / frames[i][1]).convert("RGB")
            if im.size != (W, H):
                raise SystemExit(f"frame {frames[i][1]} is {im.size}, expected {W}x{H}")
            cache[i] = im
        return cache[i]

    def index_at(t: float) -> int:
        return max(0, bisect.bisect_right(ts, t) - 1)

    stale = []
    last_i = -1
    for k in range(n):
        t = capture_time(k / FPS)
        i = index_at(t)
        if i == last_i:
            stale.append(t)
        last_i = i
        im = frame(i)
        s, cx, cy = camera_at(cams, t)
        if abs(s - 1.0) > 1e-4:
            vw, vh = W / s, H / s
            box = (cx - vw / 2, cy - vh / 2, cx + vw / 2, cy + vh / 2)
            im = im.resize((W, H), Image.LANCZOS, box=box)
        for f in fades:
            if f["t"] <= t < f["t"] + f["d"]:
                # The frame shown just before the route change, under the same camera (always 1x at a cut).
                before = frame(index_at(f["t_nav"] - 0.02))
                im = Image.blend(before, im, ease((t - f["t"]) / f["d"]))
        ff.stdin.write(im.tobytes())
        if k % 600 == 0:
            print(f"  {k / FPS:6.1f}s", flush=True)
    ff.stdin.close()
    err = ff.stderr.read().decode()
    if ff.wait() != 0:
        raise SystemExit(f"ffmpeg failed:\n{err}")
    if err.strip():
        print("ffmpeg said:", err.strip())
    TIMELINE.write_text(json.dumps({"t0": t0, "length": n / FPS,
                                    "beats": [{"id": m["id"], "at": out_time(m["at"])} for m in marks],
                                    "cuts": [[out_time(a), b - a] for a, b in cuts]}, indent=1))
    print(f"{OUT.name}: {n / FPS:.2f}s")


if __name__ == "__main__":
    sys.exit(main())
