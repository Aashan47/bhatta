"""Lay the narration and the music onto the composed picture, and write the SRT.

Each line starts BREATH seconds after its beat's mark (from timeline.json, in
film time after compose.py's cuts). A line that would still be speaking when
the next beat starts is a build error. The music bed sits about 26 dB under the
-16 LUFS voice, fades in and out, and is trimmed to the picture so the streams
end together. Subtitles come from the same cue sheet as the voice.

    python narrate.py   # deliverables/Bhatta-demo.mp4 and Bhatta-demo.srt
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cues import CUES  # noqa: E402
import voice  # noqa: E402

PICTURE = HERE / "picture.mp4"
TIMELINE = HERE / "timeline.json"
SRT = HERE / "Bhatta-demo.srt"
DELIV = HERE.parents[2] / "deliverables"
OUT = DELIV / "Bhatta-demo.mp4"
MUSIC = HERE.parents[3] / "Music for Reels" / "ES_Agwe - West & Zander.mp3"
VOICE_LUFS, MUSIC_LUFS = -16.0, -42.0
BREATH = 0.45
MIN_LEN, MAX_LEN = 180.0, 300.0
EM_DASH = "\u2014"


def ff(args: list[str]) -> None:
    r = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg failed:\n{r.stderr.strip()}")
    if r.stderr.strip():
        print("ffmpeg said:", r.stderr.strip())


def probe(path: Path, stream: str | None = None) -> float:
    args = ["ffprobe", "-v", "error"] + (["-select_streams", stream, "-show_entries", "stream=duration"] if stream else
                                         ["-show_entries", "format=duration"]) + ["-of", "csv=p=0", str(path)]
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffprobe failed on {path}:\n{r.stderr}")
    return float(r.stdout.strip().splitlines()[0])


def loudness(path: Path, seconds: float | None = None) -> float:
    args = ["ffmpeg", "-hide_banner", "-nostats"] + (["-t", f"{seconds}"] if seconds else []) + \
           ["-i", str(path), "-af", "ebur128=framelog=quiet", "-f", "null", "-"]
    r = subprocess.run(args, capture_output=True, text=True)
    m = re.findall(r"I:\s*(-?\d+\.\d+) LUFS", r.stderr)
    if not m:
        raise SystemExit(f"could not measure {path.name}:\n{r.stderr[-800:]}")
    return float(m[-1])


def stamp(t: float) -> str:
    ms = int(round(t * 1000)); h, ms = divmod(ms, 3600_000); m, ms = divmod(ms, 60_000); s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def srt_chunks(text: str, start: float, end: float) -> list[tuple[float, float, str]]:
    """Split a long line at sentence ends so a subtitle never runs past two short lines."""
    parts = [p.strip() for p in re.split(r"(?<=[.:])\s+", text) if p.strip()]
    merged: list[str] = []
    for p in parts:
        if merged and len(merged[-1]) + len(p) < 84:
            merged[-1] += " " + p
        else:
            merged.append(p)
    total = sum(len(p) for p in merged)
    out, t = [], start
    for p in merged:
        d = (end - start) * len(p) / total
        out.append((t, t + d, p))
        t += d
    return out


def main() -> None:
    tl = json.loads(TIMELINE.read_text())
    at = {b["id"]: b["at"] for b in tl["beats"]}
    order = [b["id"] for b in tl["beats"]]
    video_len = probe(PICTURE)
    placed, faults = [], []
    for i, (bid, text) in enumerate(CUES):
        if bid not in at:
            raise SystemExit(f"beat {bid} was not recorded")
        clip = voice.clip_path(text)
        secs = voice.duration(clip)
        start = at[bid] + BREATH
        end = start + secs
        nxt = at[order[order.index(bid) + 1]] if order.index(bid) + 1 < len(order) else video_len
        if end > nxt + 0.05:
            faults.append(f"{bid} speaks {end - nxt:.2f}s into the next beat")
        placed.append({"beat": bid, "start": start, "end": end, "secs": secs, "clip": clip, "text": text, "room": nxt - at[bid]})
    tail = video_len - placed[-1]["end"]
    if not (MIN_LEN <= video_len <= MAX_LEN):
        faults.append(f"film is {video_len:.1f}s, outside {MIN_LEN:.0f} to {MAX_LEN:.0f}s")
    if tail > 4.0:
        faults.append(f"{tail:.1f}s of picture after the last line")
    print(f"  {'beat':5s} {'in':>7s} {'out':>7s} {'line':>5s} {'beat':>5s}")
    for c in placed:
        print(f"  {c['beat']:5s} {c['start']:7.2f} {c['end']:7.2f} {c['secs']:5.2f} {c['room']:5.2f}")
    spoken = sum(c["secs"] for c in placed)
    print(f"  speech {spoken:.1f}s of {video_len:.1f}s ({spoken / video_len:.0%}), tail {tail:.1f}s")
    if faults:
        raise SystemExit("the narration does not fit the picture:\n  " + "\n  ".join(faults))

    cues = []
    for c in placed:
        cues += srt_chunks(c["text"], c["start"], c["end"])
    body = "\n".join(f"{i}\n{stamp(a)} --> {stamp(b)}\n{t}\n" for i, (a, b, t) in enumerate(cues, start=1))
    if EM_DASH in body:
        raise SystemExit("an em dash reached the subtitles")
    SRT.write_text(body, encoding="utf-8")

    mix = HERE / "mix.m4a"
    inputs = ["-f", "lavfi", "-t", f"{video_len:.3f}", "-i", "anullsrc=r=48000:cl=stereo"]
    filters, mixes = [], ["[0:a]"]
    for i, c in enumerate(placed, start=1):
        inputs += ["-i", str(c["clip"])]
        ms = int(round(c["start"] * 1000))
        filters.append(f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay={ms}|{ms}[d{i}]")
        mixes.append(f"[d{i}]")
    filters.append("".join(mixes) + f"amix=inputs={len(placed) + 1}:duration=first:normalize=0[vo]")
    gain = MUSIC_LUFS - loudness(MUSIC, seconds=video_len)
    m = len(placed) + 1
    inputs += ["-i", str(MUSIC)]
    filters.append(f"[{m}:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{video_len:.3f},asetpts=N/SR/TB,"
                   f"volume={gain:.2f}dB,afade=t=in:st=0:d=2.0,afade=t=out:st={max(0.0, video_len - 3.0):.2f}:d=3.0[bed]")
    filters.append("[bed][vo]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[out]")
    ff([*inputs, "-filter_complex", ";".join(filters), "-map", "[out]", "-map_chapters", "-1", "-map_metadata", "-1", "-t", f"{video_len:.3f}", "-c:a", "aac", "-b:a", "192k", str(mix)])

    DELIV.mkdir(exist_ok=True)
    ff(["-i", str(PICTURE), "-i", str(mix), "-map", "0:v:0", "-map", "1:a:0", "-map_chapters", "-1", "-map_metadata", "-1", "-c:v", "copy", "-c:a", "copy",
        "-shortest", "-movflags", "+faststart", str(OUT)])
    mix.unlink()
    shutil.copyfile(SRT, DELIV / SRT.name)
    v, a = probe(OUT, "v:0"), probe(OUT, "a:0")
    if abs(v - a) > 0.3:
        raise SystemExit(f"streams do not end together: video {v:.2f}s, audio {a:.2f}s")
    print(f"  music {MUSIC.name} at {gain:+.1f} dB (bed {MUSIC_LUFS} LUFS under a {VOICE_LUFS} LUFS voice)")
    print(f"  final {OUT}  video {v:.2f}s audio {a:.2f}s")


if __name__ == "__main__":
    main()
