"""The house narrator (Hackathons/DEMO-RECORDING/voice/VOICE.md): Breeze TTS 2
on this Mac with MLX, cloned from one reference clip on every line so the
speaker never changes, and a Whisper read-back gate that regenerates any line
whose words drift from the script. Clips are cached by a hash of everything
that shapes them, so a copy change re-synthesises only that line.

Copied from synth_breeze() in amd-developer-act-iii/build/turno/video/narrate.py.

    python voice.py          # synthesise every missing line, print durations
"""

from __future__ import annotations

import difflib
import hashlib
import re
import subprocess
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from cues import CUES  # noqa: E402

CLIPS = HERE / "voice"
HACK = next(d for d in HERE.parents if d.name == "Hackathons")
BREEZE_REF = HACK / "DEMO-RECORDING" / "voice" / "breeze-ref.wav"
MODEL = "mlx-community/Breeze-TTS-2-mlx"
WHISPER = "mlx-community/whisper-large-v3-turbo"
BREEZE_REF_TEXT = ("Every summer, Italian regions ban outdoor work from half past twelve to four, on days the heat is "
                   "rated high. A site supervisor still has to decide the rest of the day.")
BREEZE_INSTRUCT = ("A professional male narrator for a product demonstration. Clear, precise and focused. Measured, "
                   "even pace, neutral and confident tone, every word articulated, no slang, no hesitation.")
BREEZE_CFG, BREEZE_TRIES, MAX_WER = 4.0, 6, 0.12
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
    ref = hashlib.sha256(BREEZE_REF.read_bytes()).hexdigest()[:8]
    key = hashlib.sha256(f"breeze|{MODEL}|{ref}|{BREEZE_INSTRUCT}|{BREEZE_CFG}|{PAUSE_KEEP}|{VOICE_LUFS}|{text}".encode()).hexdigest()[:16]
    return CLIPS / f"{key}.wav"


def normalise(src: Path, dest: Path) -> None:
    ff(["-i", str(src), "-af",
        "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.08"
        f":stop_periods=-1:stop_threshold=-50dB:stop_silence={PAUSE_KEEP},"
        f"loudnorm=I={VOICE_LUFS}:TP=-1.5:LRA=7", "-ar", "24000", "-ac", "1", str(dest)])


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


_breeze = None


def synth_breeze(text: str, dest: Path) -> tuple[float, str]:
    global _breeze
    import numpy as np
    import mlx_whisper
    if _breeze is None:
        from mlx_audio.tts import load
        _breeze = load(MODEL)
    raw = dest.with_suffix(".raw.wav")
    best: tuple[float, Path | None, str] = (9.9, None, "")
    for seed in range(BREEZE_TRIES):
        chunks = list(_breeze.generate(text=text, instruct=BREEZE_INSTRUCT, ref_audio=str(BREEZE_REF), ref_text=BREEZE_REF_TEXT,
                                       cfg_scale=BREEZE_CFG, voice="S0", seed=seed))
        audio = np.concatenate([np.array(c.audio, dtype=np.float32).reshape(-1) for c in chunks])
        rate = chunks[0].sample_rate
        cand = dest.with_name(f"{dest.stem}.try{seed}.wav")
        with wave.open(str(cand), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
        heard = mlx_whisper.transcribe(str(cand), path_or_hf_repo=WHISPER)["text"].strip()
        e = wer(heard, text)
        print(f"      try {seed}: {len(audio) / rate:.1f}s, word error {e:.2f}  heard: {heard}", flush=True)
        if e < best[0]:
            if best[1] is not None:
                best[1].unlink()
            best = (e, cand, heard)
        else:
            cand.unlink()
        if e <= MAX_WER:
            break
    if best[0] > MAX_WER:
        raise SystemExit(f"the voice would not read this line faithfully after {BREEZE_TRIES} tries: {text}")
    best[1].rename(raw)
    normalise(raw, dest)
    raw.unlink()
    dest.with_suffix(".heard.txt").write_text(f"{best[0]:.3f}\n{best[2]}\n", encoding="utf-8")
    return best[0], best[2]


def main() -> None:
    CLIPS.mkdir(exist_ok=True)
    total = 0.0
    for beat, text in CUES:
        d = clip_path(text)
        if not d.exists():
            print(f"   synth {beat}: {text[:70]}", flush=True)
            synth_breeze(text, d)
        secs = duration(d)
        total += secs
        heard = d.with_suffix(".heard.txt")
        e = heard.read_text().split("\n")[0] if heard.exists() else "?"
        print(f"{beat}  {secs:5.2f}s  {len(text.split()) / secs * 60:4.0f} wpm  wer {e}", flush=True)
    print(f"ALL LINES DONE, speech {total:.1f}s")


if __name__ == "__main__":
    main()
