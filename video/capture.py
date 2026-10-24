"""Chromium's own screencast, saved frame by frame with its timestamps.

Playwright's built-in video is VP8 at a low bitrate, which smears small text
at 1920x1080. This asks the DevTools protocol for JPEG frames instead, writes
each one with the timestamp Chromium put on it, and leaves the timing to the
compositor (compose.py), which holds each frame until the next. Chromium sends
a frame only when the picture changes, so a still screen costs nothing.

The screencast runs on its own DevTools connection, in a thread, so every
frame is acknowledged the moment it arrives. Acknowledging through
Playwright's synchronous event dispatch made Chromium wait on the script, and
the frame rate fell from about twenty to under one per second within minutes.
"""

from __future__ import annotations

import base64
import json
import threading
import time
import urllib.request
from pathlib import Path

import websocket


class Screencast:
    def __init__(self, port: int, url_part: str, out: Path, quality: int = 92, size: tuple[int, int] = (1920, 1080)):
        self.out, self.quality, self.size = out, quality, size
        self.out.mkdir(parents=True, exist_ok=True)
        self.frames: list[tuple[float, str]] = []
        pages, targets = [], []
        for _ in range(40):
            targets = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10).read())
            pages = [t for t in targets if t.get("type") == "page" and url_part in t.get("url", "")]
            if pages:
                break
            time.sleep(0.25)
        if not pages:
            raise SystemExit(f"no page target matching {url_part}: {[t.get('url') for t in targets]}")
        self.ws = websocket.create_connection(pages[0]["webSocketDebuggerUrl"], timeout=30, suppress_origin=True,
                                              enable_multithread=True)
        self._id = 0
        self._n = 0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def _send(self, method: str, params: dict | None = None) -> None:
        with self._lock:
            self._id += 1
            self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))

    def _loop(self) -> None:
        self.ws.settimeout(0.5)
        while not self._stop.is_set():
            try:
                msg = json.loads(self.ws.recv())
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                break
            if msg.get("method") != "Page.screencastFrame":
                continue
            p = msg["params"]
            self._send("Page.screencastFrameAck", {"sessionId": p["sessionId"]})
            ts = p["metadata"].get("timestamp") or time.time()
            name = f"f{self._n:06d}.jpg"
            self._n += 1
            (self.out / name).write_bytes(base64.b64decode(p["data"]))
            self.frames.append((float(ts), name))

    def mouse(self, kind: str, x: float, y: float, button: str = "none", buttons: int = 0, clicks: int = 0) -> None:
        """Real input through the same DevTools connection, sent without waiting for Chromium's reply.
        Playwright's mouse waits for each event to be acknowledged, and while the screencast runs
        that wait grew to seconds per move."""
        self._send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": button, "buttons": buttons,
                                                "clickCount": clicks})

    def start(self) -> None:
        self._thread.start()
        w, h = self.size
        self._send("Page.startScreencast", {"format": "jpeg", "quality": self.quality, "maxWidth": w, "maxHeight": h,
                                            "everyNthFrame": 1})

    def stop(self) -> None:
        try:
            self._send("Page.stopScreencast")
        except Exception:
            pass
        time.sleep(0.3)
        self._stop.set()
        self._thread.join(timeout=3)
        self.ws.close()

    def save_index(self) -> Path:
        idx = self.out / "frames.json"
        idx.write_text(json.dumps(self.frames))
        return idx
