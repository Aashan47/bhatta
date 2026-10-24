"""Record the Bhatta demo by driving the live site in a chrome-less Chromium.

Playwright opens https://bhatta.aashanjaved.com in Chromium's new headless
mode, which renders WebGL on the Mac's GPU (Metal through ANGLE), so the 3D
explainer, the 3D map and the Merkle animation run at full speed. Chromium's
own screencast (capture.py) saves every frame with its timestamp. No frame is
drawn by hand: the only things added to the page are a drawn pointer, a
highlight ring, the title and closing cards, and a phone frame holding a
screenshot of the live site at phone width.

Each beat waits for its on-screen text, marks the moment its line starts, and
holds for exactly as long as that line needs (the clip durations come from the
voice cache). Push-ins are not done in the page: the recorder logs where the
camera should look (an element's box, measured after the page has settled),
and compose.py crops the captured frames. The page never reflows because of a
camera move, and nothing on the page moves while the camera does.

    python record.py            # full take into raw/, marks into take.json
    python record.py --only b14 # rehearse from one beat (timing only)
"""

from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from capture import Screencast  # noqa: E402
from cues import CUES  # noqa: E402
import voice  # noqa: E402

BASE = "https://bhatta.aashanjaved.com"
RAW = HERE / "raw"
TAKE = HERE / "take.json"
W, H = 1920, 1080
PORT = 9333
BREATH = 0.45  # silence before each line
TAIL = 0.45  # picture held after each line ends
FCBK_KILN = "PK-tt4rm4w8"  # FCBK, hand label FCBK, both chips clear, nothing on the ledger
UND_KILN = "PK-tts6wme9"  # undetermined, both chips clear, nothing on the ledger
CONFLICT_KILN = "PK-tt18rk68"
WITHDRAWN_KILN = "PK-tt18uxyy"

HELPERS = r"""
(() => {
 const init = () => {
  if (window.__v) return;
  const css = `
    html { scrollbar-width: none !important; }
    ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
    #__vcur { position: fixed; left: 0; top: 0; width: 30px; height: 30px; z-index: 2147483647; pointer-events: none;
              opacity: 0; transition: opacity .35s; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); will-change: transform; }
    #__vcur.on { opacity: 1; }
    #__vcur svg { width: 30px; height: 30px; display: block; }
    #__vring { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid #A8432A; border-radius: 10px;
               box-shadow: 0 0 0 6px rgba(168,67,42,.16); opacity: 0; transition: opacity .4s, left .5s, top .5s, width .5s, height .5s; }
    #__vring.on { opacity: 1; }
    #__vcard { position: fixed; inset: 0; z-index: 2147483640; display: flex; flex-direction: column; align-items: center; justify-content: center;
               background: var(--page, #FAF5F0); opacity: 0; pointer-events: none; transition: opacity .7s ease; text-align: center; }
    #__vcard.on { opacity: 1; }
    #__vcard .t { font: 800 132px/1 "Public Sans", system-ui, sans-serif; color: var(--text, #1d1915); letter-spacing: -0.03em;
                  display: flex; align-items: center; gap: 36px; }
    #__vcard .t img { width: 120px; height: 120px; border-radius: 26px; }
    #__vcard .s { margin-top: 34px; font: 500 38px/1.35 "Public Sans", system-ui, sans-serif; color: var(--muted, #6b625a); max-width: 1200px; }
    #__vcard .u { margin-top: 44px; font: 600 44px/1 "IBM Plex Mono", ui-monospace, monospace; color: #A8432A; }
    #__vphone { position: fixed; z-index: 2147483641; right: 150px; top: 50%; transform: translateY(-50%) translateX(40px); opacity: 0;
                transition: opacity .6s ease, transform .6s ease; pointer-events: none; width: 404px; height: 858px; border-radius: 58px;
                background: #15120f; padding: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.35); }
    #__vphone.on { opacity: 1; transform: translateY(-50%); }
    #__vphone img { width: 376px; height: 830px; border-radius: 46px; display: block; object-fit: cover; object-position: top; }
  `;
  const st = document.createElement("style"); st.textContent = css; document.documentElement.appendChild(st);
  const cur = document.createElement("div"); cur.id = "__vcur";
  cur.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 2.5 L4 19.5 L8.6 15.3 L11.6 22 L14.6 20.7 L11.7 14.1 L18 14.1 Z" fill="#fff" stroke="#1d1915" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  document.documentElement.appendChild(cur);
  const ring = document.createElement("div"); ring.id = "__vring"; document.documentElement.appendChild(ring);
  const card = document.createElement("div"); card.id = "__vcard"; document.documentElement.appendChild(card);
  const phone = document.createElement("div"); phone.id = "__vphone"; phone.innerHTML = "<img alt=''>"; document.documentElement.appendChild(phone);
  const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  window.__v = {
    cursor(on) { cur.classList.toggle("on", !!on); },
    ring(r) {
      if (!r) { ring.classList.remove("on"); return; }
      const pad = 8;
      Object.assign(ring.style, { left: r.x - pad + "px", top: r.y - pad + "px", width: r.w + 2 * pad + "px", height: r.h + 2 * pad + "px" });
      ring.classList.add("on");
    },
    card(html) {
      if (html == null) { card.classList.remove("on"); return; }
      card.innerHTML = html; card.classList.add("on");
    },
    phone(src) {
      if (!src) { phone.classList.remove("on"); return; }
      phone.querySelector("img").src = src; phone.classList.add("on");
    },
    // The pointer is drawn, not real: real mouse input on the 3D canvas drops the page from
    // 60 to about 3 frames a second in headless Chromium, so actions are dispatched in the page.
    at: [960, 540],
    glide(x, y, ms) {
      return new Promise((done) => {
        const [x0, y0] = window.__v.at, t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms), e = ease(p);
          const cx = x0 + (x - x0) * e, cy = y0 + (y - y0) * e;
          cur.style.transform = `translate(${cx - 4}px, ${cy - 2}px)`; window.__v.at = [cx, cy];
          if (p < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    },
    press() {
      const svg = cur.querySelector("svg");
      svg.style.transition = "transform .09s"; svg.style.transformOrigin = "4px 2px"; svg.style.transform = "scale(.84)";
      return new Promise((done) => setTimeout(() => { svg.style.transform = ""; done(); }, 130));
    },
    scene() {
      // The explainer's own scene object (the one its arrow keys drive), found through React's fiber.
      const el = document.querySelector(".explainer .stage");
      const k = el && Object.keys(el).find((k) => k.startsWith("__reactFiber"));
      let f = k ? el[k] : null;
      while (f) {
        let h = f.memoizedState, guard = 0;
        while (h && guard++ < 80) {
          const v = h.memoizedState;
          if (v && typeof v === "object" && v.current && typeof v.current.rotateBy === "function") return v.current;
          h = h.next;
        }
        f = f.return;
      }
      return null;
    },
    rotate(rad, ms) {
      const sc = window.__v.scene();
      if (!sc) return Promise.resolve(false);
      return new Promise((done) => {
        const t0 = performance.now(); let last = 0;
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms), e = ease(p);
          sc.rotateBy(rad * (e - last)); last = e;
          if (p < 1) requestAnimationFrame(step); else done(true);
        };
        requestAnimationFrame(step);
      });
    },
    slide(sel, to, ms) {
      // Moves a range input the way a drag does: the value changes step by step and each step
      // fires the input event the page listens to. The drawn pointer rides on the thumb.
      const el = document.querySelector(sel), r = el.getBoundingClientRect();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const from = Number(el.value), min = Number(el.min || 0), max = Number(el.max || 100);
      return new Promise((done) => {
        const t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms), v = Math.round(from + (to - from) * ease(p));
          if (Number(el.value) !== v) { set.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true })); }
          const x = r.left + 9 + (r.width - 18) * (v - min) / (max - min), y = r.top + r.height / 2;
          cur.style.transform = `translate(${x - 4}px, ${y - 2}px)`; window.__v.at = [x, y];
          if (p < 1) requestAnimationFrame(step); else { el.dispatchEvent(new Event("change", { bubbles: true })); done(); }
        };
        requestAnimationFrame(step);
      });
    },
    scrollTo(y, ms) {
      return new Promise((done) => {
        const y0 = window.scrollY, t0 = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - t0) / ms);
          window.scrollTo(0, y0 + (y - y0) * ease(p));
          if (p < 1) requestAnimationFrame(step); else done(window.scrollY);
        };
        requestAnimationFrame(step);
      });
    },
  };
 };
 if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
"""


def line_durations() -> dict[str, float]:
    out = {}
    for beat, text in CUES:
        clip = voice.clip_path(text)
        if not clip.exists():
            if "--dry" in sys.argv:
                out[beat] = 8.0
                continue
            raise SystemExit(f"no voice clip yet for {beat}: run voice.py first")
        out[beat] = voice.duration(clip)
    return out


class Director:
    def __init__(self, page: Page, durations: dict[str, float]):
        self.page, self.dur = page, durations
        self.marks: list[dict] = []
        self.cams: list[dict] = []  # {t0, t1, s, cx, cy}: camera arrives at (s, cx, cy) at t1, eased from its pose at t0
        self.fades: list[dict] = []  # {t, d}: cross-dissolve from the frame before t over d seconds
        self.mouse = (W / 2, H / 2)
        self.deadline = 0.0
        self.facts: dict[str, str] = {}

    # time and holds
    def wait(self, secs: float) -> None:
        if secs > 0:
            self.page.wait_for_timeout(int(secs * 1000))

    def hold(self) -> None:
        """Hold the picture until the current line and its tail are done."""
        self.wait(self.deadline - time.time())

    def beat(self, bid: str) -> None:
        now = time.time()
        self.marks.append({"id": bid, "at": now})
        self.deadline = now + BREATH + self.dur[bid] + TAIL
        print(f"  {bid} at {now - self.marks[0]['at']:6.1f}s  line {self.dur[bid]:.1f}s", flush=True)

    def into_line(self, secs: float) -> None:
        """Wait until `secs` seconds into the current line (from its start)."""
        start = self.marks[-1]["at"] + BREATH
        self.wait(start + secs - time.time())

    # camera
    def box(self, target) -> dict:
        loc = self.page.locator(target).first if isinstance(target, str) else target.first
        b = loc.bounding_box()
        if not b:
            raise SystemExit(f"no box for {target}")
        return b

    def cam(self, target=None, scale: float = 1.0, secs: float = 1.2, rect: dict | None = None, wait: bool = True) -> None:
        if target is None and rect is None:
            s, cx, cy = 1.0, W / 2, H / 2
        else:
            b = rect or self.box(target)
            s = scale
            cx, cy = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
            vw, vh = W / s, H / s
            if b["width"] > vw * 0.98 or b["height"] > vh * 0.98:
                print(f"    note: {target} ({b['width']:.0f}x{b['height']:.0f}) is larger than the {s}x view", flush=True)
            cx = min(max(cx, vw / 2), W - vw / 2)
            cy = min(max(cy, vh / 2), H - vh / 2)
        t0 = time.time()
        self.cams.append({"t0": t0, "t1": t0 + secs, "s": s, "cx": cx, "cy": cy})
        if wait:
            self.wait(secs + 0.05)

    def zoomed(self) -> bool:
        return bool(self.cams) and self.cams[-1]["s"] != 1.0

    def cam_out(self, secs: float = 0.9) -> None:
        if self.zoomed():
            self.cam(None, secs=secs)

    # page motion (only ever at scale 1, so nothing moves under a push-in)
    def scroll_to(self, y: float, ms: int = 1400) -> None:
        assert not self.zoomed(), "scroll while zoomed"
        self.page.evaluate("([y, ms]) => window.__v.scrollTo(y, ms)", [y, ms])
        self.wait(0.15)

    def scroll_el(self, target, top: float = 80, ms: int = 1400) -> None:
        loc = self.page.locator(target).first if isinstance(target, str) else target
        y = loc.evaluate("(el, top) => el.getBoundingClientRect().top + window.scrollY - top", top)
        self.scroll_to(max(0, y), ms)

    def jump_el(self, target, top: float = 80) -> None:
        loc = self.page.locator(target).first if isinstance(target, str) else target
        loc.evaluate("(el, top) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - top)", top)
        self.wait(0.2)

    def nav(self, path: str, ready: str, fade: float = 0.45, top: bool = True, reload: bool = False) -> None:
        """Route change with a short dissolve over the cut. Client-side by default; a full load
        where the site keeps per-kiln state across client-side changes (the Verify panel keeps
        the previous kiln's result), so one kiln's verification never shows on another's page."""
        assert not self.zoomed(), "navigate while zoomed"
        t_nav = time.time()
        if reload:
            self.page.goto(BASE + path, wait_until="networkidle")
            self.page.wait_for_function("document.fonts.status === 'loaded' && !!window.__v", timeout=30000)
        else:
            self.page.evaluate("p => { window.history.pushState({}, '', p); window.dispatchEvent(new PopStateEvent('popstate')); }", path)
        if top:
            self.page.evaluate("window.scrollTo(0, 0)")
        self.page.get_by_text(ready, exact=False).first.wait_for(state="visible", timeout=60000)
        self.page.wait_for_load_state("networkidle")
        self.wait(0.6)  # images decode, fonts settle
        # compose.py cuts [t_nav, t] out of the film (the page loading) and dissolves
        # from the last frame before the route change into the settled new page.
        t = time.time()
        self.fades.append({"t_nav": t_nav, "t": t, "d": fade, "path": path})
        self.wait(fade)

    # pointer
    def cursor(self, on: bool) -> None:
        self.page.evaluate("on => window.__v.cursor(on)", on)

    def glide(self, x: float, y: float, secs: float = 0.8) -> None:
        self.page.evaluate("([x, y, ms]) => window.__v.glide(x, y, ms)", [x, y, int(secs * 1000)])
        self.mouse = (x, y)

    def click(self, target, secs: float = 0.8) -> None:
        loc = self.page.locator(target).first if isinstance(target, str) else target.first
        b = self.box(loc)
        x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
        self.cursor(True)
        self.glide(x, y, secs)
        self.wait(0.12)
        self.page.evaluate("window.__v.press()")
        loc.evaluate("el => el.click()")
        self.wait(0.2)

    def ring(self, target=None) -> None:
        if target is None:
            self.page.evaluate("window.__v.ring(null)")
            return
        b = self.box(target)
        self.page.evaluate("r => window.__v.ring(r)", {"x": b["x"], "y": b["y"], "w": b["width"], "h": b["height"]})


def title_card(sub: str, url: bool = False) -> str:
    return ("<div class='t'><img src='/icons/icon.svg' alt=''>Bhatta</div>"
            f"<div class='s'>{sub}</div>" + ("<div class='u'>bhatta.aashanjaved.com</div>" if url else ""))


def phone_shot(browser) -> str:
    """The overview in Urdu at phone width, from a separate phone-sized page, as a data URL."""
    import base64
    ctx = browser.new_context(viewport={"width": 390, "height": 860}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              color_scheme="light")
    ctx.add_init_script("try { localStorage.setItem('bhatta.lang', 'ur'); } catch (e) {}")
    pg = ctx.new_page()
    pg.goto(BASE + "/", wait_until="networkidle")
    pg.wait_for_function("document.fonts.status === 'loaded'", timeout=20000)
    pg.wait_for_function("document.documentElement.dir === 'rtl'", timeout=20000)
    pg.wait_for_timeout(1500)
    png = pg.screenshot()
    ctx.close()
    return "data:image/png;base64," + base64.b64encode(png).decode()


def scene(d: Director, shot: str, only: str | None) -> None:
    p = d.page
    ids = [b for b, _ in CUES]
    start = ids.index(only) if only else 0

    def run(bid: str) -> bool:
        return ids.index(bid) >= start

    # b01 The claim, large. Slow push-in on the quote.
    if run("b01"):
        d.beat("b01")
        d.wait(0.6)
        d.cam(".hero-claim", 1.42, secs=3.2)
        d.hold()
        d.cam_out()

    # b02 The province count and its source.
    if run("b02"):
        line = p.locator("section.compare p.fine", has_text="10,394")
        d.scroll_el("section.compare", top=150, ms=1200)
        d.wait(0.2)
        d.beat("b02")
        d.cam(line, 1.6, secs=1.3)
        d.facts["b02"] = line.inner_text()
        d.hold()
        d.cam_out()

    # b03 Title card over the overview; behind it, the page moves to the explainer.
    if run("b03"):
        p.evaluate("h => window.__v.card(h)", title_card("Brick kiln conversions, checked from space and kept on a public record"))
        d.wait(0.8)
        d.beat("b03")
        d.jump_el(".explainer .stage", top=70)
        p.locator(".explainer .stage.is-3d canvas").wait_for(timeout=60000)
        d.hold()
        p.evaluate("window.__v.card(null)")
        d.wait(0.8)

    # b04 Rotate the two kilns.
    if run("b04"):
        if not run("b03"):
            d.jump_el(".explainer .stage", top=70)
            p.locator(".explainer .stage.is-3d canvas").wait_for(timeout=60000)
        st = d.box(".explainer .stage")
        d.beat("b04")
        d.cam(".explainer .stage", 1.4, secs=1.4, wait=False)
        d.wait(0.2)
        # Turned through the explainer's own rotateBy (what its arrow keys call), with no pointer drawn.
        if not p.evaluate("() => window.__v.rotate(1.25, 4200)"):
            raise SystemExit("could not reach the explainer's 3D scene to turn it")
        d.wait(0.3)
        p.evaluate("() => window.__v.rotate(-0.75, 3200)")
        d.hold()
        d.cam_out()

    # b05 Fire on: the two plumes and the smoke label.
    if run("b05"):
        d.click(".explainer-controls .toggle")
        p.locator(".explainer-notes", has_text="black carbon").wait_for(timeout=20000)
        d.wait(0.6)
        d.cursor(False)
        d.beat("b05")
        d.wait(2.6)
        d.cam(".explainer-notes", 1.55, secs=1.3)
        d.facts["b05"] = p.locator(".explainer-notes").inner_text()
        d.hold()
        d.cam_out()

    # b06 Drag "See it at 10 m" to the end; hold on the pixels.
    if run("b06"):
        sl = d.box(".explainer-controls input[type=range]")
        x0, y = sl["x"] + 9, sl["y"] + sl["height"] / 2
        d.cursor(True)
        d.glide(x0, y, 0.8)
        d.beat("b06")
        p.evaluate("() => window.__v.slide('.explainer-controls input[type=range]', 100, 3400)")
        d.wait(0.2)
        d.glide(sl["x"] + sl["width"] + 60, y + 70, 0.5)
        d.cursor(False)
        p.locator(".tenm-caption").wait_for(timeout=10000)
        d.cam(".explainer .stage", 1.4, secs=1.3)
        d.hold()

    # b07 Same, caption in view.
    if run("b07"):
        cap = p.locator(".tenm-caption")
        d.facts["b07"] = cap.inner_text()
        d.beat("b07")
        d.cam(cap, 1.6, secs=1.3)
        d.hold()
        d.cam_out()

    # b08 Scroll up to the counts and the brick wall.
    if run("b08"):
        d.scroll_to(0, 1400)
        d.wait(0.3)
        d.beat("b08")
        d.cam(".hero-seen", 1.45, secs=1.4)
        d.facts["b08"] = p.locator(".seen-lead").inner_text()
        d.hold()

    # b09 Highlight the FCBK row, then the undetermined row.
    if run("b09"):
        rows = p.locator(".hero-seen li.tally-row")
        fc, und = rows.nth(1), rows.nth(2)
        d.facts["b09"] = f"{fc.inner_text()} | {und.inner_text()}"
        d.beat("b09")
        d.ring(fc)
        d.into_line(4.3)
        d.ring(und)
        d.hold()
        d.ring(None)
        d.cam_out()

    # b10 The map: 3D on, Tour.
    if run("b10"):
        d.nav("/map", "Showing 8,879 of 8,879")
        d.wait(0.3)
        d.click(p.get_by_role("button", name="3D", exact=True), secs=0.6)
        d.wait(0.9)
        d.beat("b10")
        d.click(p.get_by_role("button", name="Tour", exact=True), secs=0.6)
        d.cursor(False)
        d.hold()
        d.wait(0.6)

    # b11 An FCBK kiln: chips, probabilities, calibrated answer.
    if run("b11"):
        d.nav(f"/kiln/{FCBK_KILN}", "At 90% confidence")
        p.locator(".chips img").first.wait_for(timeout=20000)
        d.beat("b11")
        main_answer = p.get_by_text("At 90% confidence", exact=False).first
        a, c = d.box(main_answer), d.box(".chips")
        d.cam(rect={"x": c["x"], "y": a["y"], "width": c["width"], "height": c["y"] + c["height"] - a["y"]}, scale=1.4, secs=1.4)
        d.facts["b11"] = main_answer.inner_text()
        d.hold()

    # b12 The measured-error line under the answer.
    if run("b12"):
        err = p.get_by_text("calls like this one was wrong", exact=False).first
        d.facts["b12"] = err.inner_text()
        d.beat("b12")
        d.cam(err, 1.7, secs=1.2)
        d.hold()
        d.cam_out()

    # b13 An undetermined kiln.
    if run("b13"):
        d.nav(f"/kiln/{UND_KILN}", "cannot separate")
        p.locator(".chips img").first.wait_for(timeout=20000)
        d.beat("b13")
        ans = p.get_by_text("cannot separate", exact=False).first
        a, c = d.box(ans), d.box(".chips")
        d.cam(rect={"x": c["x"], "y": a["y"], "width": c["width"], "height": c["y"] + c["height"] - a["y"]}, scale=1.4, secs=1.4)
        d.facts["b13"] = ans.inner_text()
        d.hold()
        d.cam_out()

    # b14 Back on the FCBK kiln: Verify on chain, the steps tick, the Merkle path turns green.
    if run("b14"):
        d.nav(f"/kiln/{FCBK_KILN}", "At 90% confidence")
        d.scroll_el(".panel.verify", top=75, ms=1200)
        d.wait(0.2)
        d.beat("b14")
        d.wait(0.3)
        d.click(p.locator(".panel.verify button.btn-primary"))
        d.cursor(False)
        p.locator(".merkle").wait_for(timeout=90000)
        d.wait(0.3)
        d.scroll_el(".merkle", top=66, ms=1000)
        d.wait(0.1)
        mk = d.box(".merkle")
        leaf = {"x": mk["x"], "y": mk["y"] + mk["height"] - 300, "width": mk["width"], "height": 300}
        root = {"x": mk["x"], "y": mk["y"], "width": mk["width"], "height": 300}
        d.cam(rect=leaf, scale=1.4, secs=0.9)
        d.cam(rect=root, scale=1.4, secs=2.4)
        verdict = p.locator(".panel.verify .verdict")
        verdict.wait_for(timeout=90000)
        d.facts["b14"] = verdict.inner_text()
        d.wait(0.6)
        vb = d.box(verdict)
        d.cam(rect={"x": mk["x"], "y": vb["y"] - 200, "width": mk["width"], "height": vb["height"] + 200}, scale=1.4, secs=1.3)
        d.hold()
        d.cam_out()

    # b15 The conflict kiln: Demo tag, the inspector finding, the Conflict.
    if run("b15"):
        d.nav(f"/kiln/{CONFLICT_KILN}", "Conflict: satellite and inspector disagree", reload=True)
        d.scroll_el(".timeline", top=110, ms=1200)
        d.wait(0.2)
        d.beat("b15")
        items = p.locator(".timeline > li")
        fin = items.filter(has_text="Inspector finding signed").first
        con = items.filter(has_text="Conflict").first
        a, b = d.box(fin), d.box(con)
        d.cam(rect={"x": a["x"], "y": a["y"], "width": max(a["width"], b["width"]), "height": b["y"] + b["height"] - a["y"]}, scale=1.4, secs=1.4)
        d.facts["b15"] = fin.inner_text()[:200]
        d.hold()

    # b16 The Conflict entry and its transaction link.
    if run("b16"):
        con = p.locator(".timeline > li").filter(has_text="Conflict").first
        d.facts["b16"] = con.inner_text()[:300]
        d.beat("b16")
        d.cam(con, 1.65, secs=1.2)
        d.hold()
        d.cam_out()

    # b17 The withdrawn certificate in the record.
    if run("b17"):
        d.nav(f"/kiln/{WITHDRAWN_KILN}", "Certificate withdrawn", reload=True)
        d.scroll_el(".timeline", top=110, ms=1200)
        d.wait(0.2)
        items = p.locator(".timeline > li")
        issued = items.filter(has_text="Certificate issued").first
        withdrawn = items.filter(has_text="Certificate withdrawn").first
        d.facts["b17"] = issued.inner_text()[:200] + " | " + withdrawn.inner_text()[:200]
        d.beat("b17")
        d.cam(issued, 1.6, secs=1.3)
        d.into_line(4.6)
        d.cam(withdrawn, 1.6, secs=1.3)
        d.hold()
        d.cam_out()

    # b18 The ranked queue; the CSV export.
    if run("b18"):
        d.nav("/inspect", "Public conflicts")
        d.beat("b18")
        d.click(p.get_by_role("button", name="Download CSV"), secs=1.0)
        d.cursor(False)
        d.wait(0.5)
        g = p.locator(".q-group-title")
        a = d.box(g.first)
        d.cam(rect={"x": a["x"], "y": a["y"] - 20, "width": 1216, "height": 520}, scale=1.4, secs=1.4)
        d.hold()
        d.cam_out()

    # b19 The pre-registered table, T1 to T6, three misses.
    if run("b19"):
        d.nav("/method", "Pre-registered results")
        tbl = p.locator("table").filter(has_text="T6").first
        d.scroll_el(p.get_by_text("Pre-registered results").first, top=150, ms=1200)
        d.wait(0.2)
        d.beat("b19")
        d.cam(tbl, 1.4, secs=1.4)
        d.facts["b19"] = tbl.inner_text()[:400]
        d.hold()
        d.cam_out()

    # b20 The ledger: season root, contract, events.
    if run("b20"):
        d.nav("/ledger", "Season roots")
        d.beat("b20")
        a = d.box(".chain-card")
        d.cam(rect={"x": a["x"], "y": a["y"], "width": a["width"], "height": 235}, scale=1.4, secs=1.4)
        d.hold()
        d.cam_out()

    # b21 Urdu on the overview, and the same page at phone width; then back.
    if run("b21"):
        d.nav("/", "8,879 kilns found")
        d.click(".lang-btn")
        p.wait_for_function("document.documentElement.dir === 'rtl'", timeout=10000)
        d.cursor(False)
        d.wait(0.5)
        d.beat("b21")
        p.evaluate("s => window.__v.phone(s)", shot)
        d.hold()
        d.wait(0.2)
        p.evaluate("window.__v.phone(null)")
        d.wait(0.2)
        d.click(".lang-btn", secs=0.6)
        p.wait_for_function("document.documentElement.dir === 'ltr'", timeout=10000)
        d.cursor(False)
        d.wait(0.3)

    # b22 Close on the overview with the URL.
    if run("b22"):
        p.evaluate("h => window.__v.card(h)", title_card("Public satellite data, a public ledger, and an honest answer", url=True))
        d.wait(0.7)
        d.beat("b22")
        d.hold()
        d.wait(1.6)


def main() -> None:
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    durations = line_durations()
    print("lines:", {k: round(v, 2) for k, v in durations.items()}, f"total {sum(durations.values()):.1f}s", flush=True)
    shutil.rmtree(RAW, ignore_errors=True)
    problems: list[str] = []
    with sync_playwright() as pw:
        # Chromium's new headless mode: no window ever opens, and WebGL runs on the GPU through
        # ANGLE's Metal backend. With SwiftShader (CPU) the explainer ran at 5 to 16 frames a second.
        browser = pw.chromium.launch(channel="chromium", headless=True,
                                     args=["--ignore-gpu-blocklist", "--force-device-scale-factor=1", "--hide-scrollbars",
                                           f"--remote-debugging-port={PORT}"])
        ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1, color_scheme="light",
                                  accept_downloads=True, locale="en-GB")
        ctx.add_init_script("try { localStorage.removeItem('bhatta.lang'); localStorage.removeItem('bhatta.theme'); } catch (e) {}")
        ctx.add_init_script(HELPERS)
        page = ctx.new_page()
        page.on("pageerror", lambda e: problems.append(f"pageerror: {e}"))
        page.on("console", lambda m: problems.append(f"console {m.type}: {m.text[:160]}") if m.type == "error" else None)
        renderer = page.evaluate("""() => { const g = document.createElement('canvas').getContext('webgl2');
            const e = g && g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'none'; }""")
        print("WebGL:", renderer, flush=True)
        page.goto(BASE + "/", wait_until="networkidle")
        page.wait_for_function("document.fonts.status === 'loaded'", timeout=20000)
        page.get_by_text("8,879 kilns found", exact=False).first.wait_for(timeout=30000)
        page.wait_for_timeout(1200)
        shot = phone_shot(browser)  # taken before the camera rolls, from its own phone-sized page
        d = Director(page, durations)
        sc = Screencast(PORT, "bhatta.aashanjaved.com", RAW, quality=93)
        sc.start()
        page.wait_for_timeout(700)
        t_start = time.time()
        try:
            scene(d, shot, only)
        finally:
            t_end = time.time()
            page.wait_for_timeout(300)
            sc.stop()
            page.wait_for_timeout(300)
            sc.save_index()
            TAKE.write_text(json.dumps({"start": t_start, "end": t_end, "marks": d.marks, "cams": d.cams, "fades": d.fades,
                                        "facts": d.facts, "only": only, "renderer": renderer,
                                        "durations": durations, "breath": BREATH, "tail": TAIL}, indent=1))
            ctx.close()
            browser.close()
    fr = json.loads((RAW / "frames.json").read_text())
    span = t_end - t_start
    inside = [f for f in fr if t_start <= f[0] <= t_end]
    print(f"take {span:.1f}s, {len(inside)} frames ({len(inside) / span:.1f} per second on average)")
    print("page problems:", problems or "none")


if __name__ == "__main__":
    main()
