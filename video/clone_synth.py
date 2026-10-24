"""Synthesise narration lines in Aashan's own cloned voice (Qwen3-TTS, run locally
by his Voice Clone tool), loading the model once for the whole batch.

Each line is read exactly as `say.py "<line>" --seed N --speed 0.92` reads it:
the same sentence split, 0.5 s between sentences, temperature 0.9, silence
trimmed, then slowed with atempo. Run with the Voice Clone venv:

    "$VC/.venv/bin/python" clone_synth.py JOBS.json

JOBS.json is a list of {"text", "seed", "out"}. voice.py writes it and gates the results.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path

VC = Path("/Users/aashanjaved/Desktop/Drive -D - Aashan/Voice Clone")
sys.path.insert(0, str(VC))
import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
import torch  # noqa: E402
import say  # noqa: E402  (his tool: constants and helpers, nothing runs on import)
from qwen_tts import Qwen3TTSModel  # noqa: E402

SPEED, PAUSE, TEMPERATURE = 0.92, 0.5, 0.9


def main() -> None:
    jobs = json.loads(Path(sys.argv[1]).read_text())
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    t0 = time.time()
    model = Qwen3TTSModel.from_pretrained(say.MODEL_ID, device_map=device, dtype=torch.bfloat16)
    prompt = model.create_voice_clone_prompt(ref_audio=str(say.REF_AUDIO), ref_text=say.REF_TEXT)
    print(f"model loaded on {device} in {time.time() - t0:.0f}s", flush=True)
    for job in jobs:
        torch.manual_seed(job["seed"])
        pieces, sr = [], None
        sentences = [s for para in say.split_script(job["text"]) for s in para]
        for i, sentence in enumerate(sentences):
            wavs, sr = model.generate_voice_clone(text=sentence, language="English", voice_clone_prompt=prompt,
                                                  temperature=TEMPERATURE)
            pieces.append(say.trim_silence(wavs[0], sr))
            if i < len(sentences) - 1:
                pieces.append(np.zeros(int(PAUSE * sr), dtype=pieces[-1].dtype))
        out = Path(job["out"])
        out.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
            sf.write(tmp.name, np.concatenate(pieces), sr)
            r = subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp.name, "-af", f"atempo={SPEED}", str(out)],
                               capture_output=True, text=True)
            if r.returncode:
                raise SystemExit(f"ffmpeg failed:\n{r.stderr}")
        print(f"  {out.name}: {sf.info(str(out)).duration:.2f}s", flush=True)


if __name__ == "__main__":
    main()
