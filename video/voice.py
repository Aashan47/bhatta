"""The narrator is Aashan's own cloned voice (from 24 Oct 2026; Breeze TTS is no
longer used). clone_synth.py reads each line with his Voice Clone tool
(Qwen3-TTS, local) at speed 0.92; this file runs the Whisper read-back gate on
every take (word error at most 0.12, the product name's spellings allowed),
tries the next seed when a take fails (seeds 1 to 3), and keeps the first take
that passes, levelled to -16 LUFS, as audio/<beat>.wav.

    python voice.py          # synthesise and gate every missing line, print durations
"""

from __future__ import annotations

import difflib
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cues import CUES  # noqa: E402

CLIPS = HERE / "audio"
TAKES = CLIPS / "takes"
VC = Path("/Users/aashanjaved/Desktop/Drive -D - Aashan/Voice Clone")
SEEDS = (1, 2, 3)
HACK = next(d for d in HERE.parents if d.name == "Hackathons")
WHISPER = "mlx-community/whisper-large-v3-turbo"
MAX_WER = 0.12
VOICE_LUFS = -16.0
PAUSE_KEEP = 0.9
FFMPEG = "ffmpeg"
FFPROBE = "ffprobe"


def ff(args: list[str]) -> None:
    r = subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", *args], capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffmpeg failed:\n{r.stderr.strip()}")
    if r.stderr.strip():
        print(f"ffmpeg said: {r.stderr.strip()}", flush=True)


def duration(path: Path) -> float:
    r = subprocess.run([FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(f"ffprobe failed on {path}:\n{r.stderr.strip()}")
    return float(r.stdout.strip())


def clip_path(text: str) -> Path:
    """The gated, levelled clip for a line, keyed by the line's text so a copy change re-voices only that line."""
    key = hashlib.sha256(f"clone|qwen3-tts|0.92|{VOICE_LUFS}|{text}".encode()).hexdigest()[:12]
    return CLIPS / f"{key}.wav"


def loudness(path: Path) -> float:
    r = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=framelog=quiet", "-f", "null", "-"],
                       capture_output=True, text=True)
    m = re.findall(r"I:\s*(-?\d+\.\d+) LUFS", r.stderr)
    if not m:
        raise SystemExit(f"could not measure {path}:\n{r.stderr[-600:]}")
    return float(m[-1])


def normalise(src: Path, dest: Path) -> None:
    """Leading silence removed, internal pauses kept up to PAUSE_KEEP, then a measured linear gain
    to VOICE_LUFS with a peak limiter. (Single-pass loudnorm left these short clips 1 to 4 dB low.)"""
    trimmed = dest.with_suffix(".trim.wav")
    ff(["-i", str(src), "-af",
        "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08"
        f":stop_periods=-1:stop_threshold=-50dB:stop_silence={PAUSE_KEEP}", "-ar", "24000", "-ac", "1", str(trimmed)])
    gain = 0.0
    for _ in range(3):  # the limiter takes back part of the gain on peaky lines, so measure and correct again
        ff(["-i", str(trimmed), "-af", f"volume={gain:.2f}dB,alimiter=limit=0.89:level=false", "-ar", "24000", "-ac", "1", str(dest)])
        miss = VOICE_LUFS - loudness(dest)
        if abs(miss) < 0.2:
            break
        gain += miss
    trimmed.unlink()


_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
_TENS = "x x twenty thirty forty fifty sixty seventy eighty ninety".split()


def _num_words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        h, r = divmod(n, 100)
        return _ONES[h] + " hundred" + ("" if r == 0 else " and " + _num_words(r))
    if n < 1_000_000:
        t, r = divmod(n, 1000)
        rest = "" if r == 0 else (" and " + _num_words(r) if r < 100 else " " + _num_words(r))
        return _num_words(t) + " thousand" + rest
    return str(n)


def words_of(text: str, hyphen: str = " ") -> list[str]:
    """Spoken-word tokens: digits as words, so "8,879" and the spelled form compare equal."""
    t = text.lower().replace("%", " percent ").replace("-", hyphen)
    t = re.sub(r"(\d),(\d{3})", r"\1\2", t)
    t = re.sub(r"\d+", lambda m: _num_words(int(m.group(0))), t)
    t = t.replace("metres", "meters").replace("metre", "meter")
    # Whisper has no spelling for the product name (Urdu for brick kiln) and writes what it
    # hears as an English word: Bata, Batta, Butter, or run into the word before it
    # ("Sobata"). Those spellings count as the name; every other word is still checked.
    t = re.sub(r"\b(so)?(bh?[au]tt?(a|er|ah)|bhatta)\b", lambda m: ("so " if m.group(1) else "") + "bhatta", t)
    # "root" and "route" sound the same in the narrator's accent, and "season's root from"
    # is heard as "roots"; the transcriber cannot tell them apart, so neither counts as a drift.
    t = re.sub(r"\b(route|roots)\b", "root", t)
    toks = re.findall(r"[a-z']+", t)
    return [w for w in toks if w != "and"]  # "and" in spoken numbers is optional either way


def wer(said: str, wanted: str) -> float:
    best = 9.9
    for hyphen in (" ", ""):
        a, b = words_of(wanted, hyphen), words_of(said, hyphen)
        matched = sum(bl.size for bl in difflib.SequenceMatcher(None, a, b).get_matching_blocks())
        best = min(best, (len(a) + len(b) - 2 * matched) / max(1, len(a)))
    return best


def transcribe(paths: list[Path]) -> dict[Path, str]:
    import mlx_whisper
    return {p: mlx_whisper.transcribe(str(p), path_or_hf_repo=WHISPER)["text"].strip() for p in paths}


def main() -> None:
    CLIPS.mkdir(exist_ok=True)
    todo = {beat: text for beat, text in CUES if not clip_path(text).exists()}
    log: dict[str, list] = {}
    for seed in SEEDS:
        if not todo:
            break
        jobs = [{"text": t, "seed": seed, "out": str(TAKES / f"{b}_s{seed}.wav")} for b, t in todo.items()]
        jf = TAKES / f"jobs_s{seed}.json"
        TAKES.mkdir(parents=True, exist_ok=True)
        jf.write_text(json.dumps(jobs, indent=1))
        print(f"seed {seed}: {len(jobs)} lines", flush=True)
        r = subprocess.run([str(VC / ".venv" / "bin" / "python"), str(HERE / "clone_synth.py"), str(jf)])
        if r.returncode:
            raise SystemExit("clone_synth.py failed")
        heard = transcribe([Path(j["out"]) for j in jobs])
        for b in list(todo):
            take = TAKES / f"{b}_s{seed}.wav"
            e = wer(heard[take], todo[b])
            log.setdefault(b, []).append((seed, round(e, 3), heard[take]))
            print(f"  {b} seed {seed}: {duration(take):.2f}s word error {e:.2f}  heard: {heard[take]}", flush=True)
            if e <= MAX_WER:
                normalise(take, clip_path(todo[b]))
                clip_path(todo[b]).with_suffix(".heard.txt").write_text(f"seed {seed}\n{e:.3f}\n{heard[take]}\n", encoding="utf-8")
                del todo[b]
    if todo:
        raise SystemExit(f"no seed in {SEEDS} passed the read-back gate for: {', '.join(todo)}")
    total = 0.0
    for beat, text in CUES:
        d = clip_path(text)
        secs = duration(d)
        total += secs
        meta = d.with_suffix(".heard.txt").read_text().split("\n")
        print(f"{beat}  {secs:5.2f}s  {len(text.split()) / secs * 60:4.0f} wpm  {meta[0]}  wer {meta[1]}", flush=True)
    print(f"ALL LINES DONE, speech {total:.1f}s")


if __name__ == "__main__":
    main()
