"""Pull review frames out of the finished film: one at the middle of every line
(and optionally other offsets), tiled four to a sheet for a quick look, plus
full-size PNGs for close checks.

    python review.py OUTDIR [mid|start|end]...
"""
import json, subprocess, sys
from pathlib import Path
from PIL import Image
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cues import CUES
import voice
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
modes = sys.argv[2:] or ["mid"]
film = HERE.parents[2] / "deliverables" / "Bhatta-demo.mp4"
tl = json.loads((HERE / "timeline.json").read_text())
at = {b["id"]: b["at"] for b in tl["beats"]}
shots = []
for bid, text in CUES:
    d = voice.duration(voice.clip_path(text)); s = at[bid] + 0.45
    for m in modes:
        t = {"start": s + 0.3, "mid": s + d / 2, "end": s + d - 0.2}[m]
        p = out / f"{bid}_{m}.png"
        r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", f"{t:.3f}", "-i", str(film), "-frames:v", "1", str(p)], capture_output=True, text=True)
        if r.returncode: raise SystemExit(r.stderr)
        shots.append((f"{bid} {m} {t:.1f}s", p))
for k in range(0, len(shots), 4):
    sheet = Image.new("RGB", (1920, 1080), "white")
    for j, (label, p) in enumerate(shots[k:k + 4]):
        im = Image.open(p).resize((960, 540), Image.LANCZOS)
        sheet.paste(im, ((j % 2) * 960, (j // 2) * 540))
    sheet.save(out / f"sheet_{k // 4:02d}.png")
print("\n".join(l for l, _ in shots))
