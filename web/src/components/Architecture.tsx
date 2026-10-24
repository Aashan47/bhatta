import { useId } from "react";
import { usePrefs } from "../i18n";

type NodeId = "s2" | "det" | "cls" | "conf" | "root" | "ledger" | "insp" | "owners" | "browser";
interface Box {
  x: number;
  y: number;
}
const W = 150;
const H = 62;

const LAYOUT: Record<"h" | "v", { w: number; h: number; nodes: Record<NodeId, Box> }> = {
  h: {
    w: 980,
    h: 300,
    nodes: {
      s2: { x: 10, y: 30 },
      det: { x: 172, y: 30 },
      cls: { x: 334, y: 30 },
      conf: { x: 496, y: 30 },
      root: { x: 658, y: 30 },
      ledger: { x: 820, y: 30 },
      insp: { x: 820, y: 220 },
      owners: { x: 658, y: 220 },
      browser: { x: 496, y: 220 },
    },
  },
  v: {
    w: 360,
    h: 560,
    nodes: {
      s2: { x: 16, y: 16 },
      det: { x: 194, y: 16 },
      cls: { x: 194, y: 126 },
      conf: { x: 16, y: 126 },
      root: { x: 16, y: 236 },
      ledger: { x: 194, y: 236 },
      insp: { x: 194, y: 370 },
      owners: { x: 16, y: 370 },
      browser: { x: 105, y: 482 },
    },
  },
};

const EDGES: { from: NodeId; to: NodeId; kind: "flow" | "write" | "read" }[] = [
  { from: "s2", to: "det", kind: "flow" },
  { from: "det", to: "cls", kind: "flow" },
  { from: "cls", to: "conf", kind: "flow" },
  { from: "conf", to: "root", kind: "flow" },
  { from: "root", to: "ledger", kind: "write" },
  { from: "insp", to: "ledger", kind: "write" },
  { from: "owners", to: "ledger", kind: "write" },
  { from: "ledger", to: "browser", kind: "read" },
];

/** Point where the segment from a box's centre toward (tx, ty) leaves the box, plus a small gap. */
function exit(b: Box, tx: number, ty: number, gap = 6) {
  const cx = b.x + W / 2;
  const cy = b.y + H / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  const sx = dx === 0 ? Infinity : (W / 2 + gap) / Math.abs(dx);
  const sy = dy === 0 ? Infinity : (H / 2 + gap) / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function Architecture() {
  const { t } = usePrefs();
  const a = t.method.arch;
  const uid = useId().replace(/:/g, "");
  const labels: Record<NodeId, [string, string]> = {
    s2: [a.s2, a.s2sub],
    det: [a.det, a.detsub],
    cls: [a.cls, a.clssub],
    conf: [a.conf, a.confsub],
    root: [a.root, a.rootsub],
    ledger: [a.ledger, a.ledgersub],
    insp: [a.insp, a.inspsub],
    owners: [a.owners, a.ownerssub],
    browser: [a.browser, a.browsersub],
  };
  const kindOf: Record<NodeId, string> = {
    s2: "n-data",
    det: "n-ai",
    cls: "n-ai",
    conf: "n-ai",
    root: "n-chain",
    ledger: "n-chain n-ledger",
    insp: "n-people",
    owners: "n-people",
    browser: "n-people",
  };

  const render = (mode: "h" | "v") => {
    const L = LAYOUT[mode];
    return (
      <svg className={`arch arch-${mode}`} viewBox={`0 0 ${L.w} ${L.h}`} role="img" aria-labelledby={`${uid}-${mode}-d`}>
        <desc id={`${uid}-${mode}-d`}>{t.method.archDesc}</desc>
        <defs>
          <marker id={`${uid}-${mode}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0L10 5L0 10z" className="arch-head" />
          </marker>
        </defs>
        {EDGES.map((e, i) => {
          const A = L.nodes[e.from];
          const B = L.nodes[e.to];
          const p = exit(A, B.x + W / 2, B.y + H / 2);
          const q = exit(B, A.x + W / 2, A.y + H / 2);
          return <line key={i} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={`arch-edge arch-${e.kind}`} markerEnd={`url(#${uid}-${mode}-arrow)`} />;
        })}
        {(Object.keys(L.nodes) as NodeId[]).map((id) => {
          const b = L.nodes[id];
          const [title, sub] = labels[id];
          return (
            <g key={id} className={`arch-node ${kindOf[id]}`}>
              <rect x={b.x} y={b.y} width={W} height={H} rx={id === "ledger" ? 2 : 8} />
              {id === "ledger" && <path className="arch-zz" d={`M${b.x + 8} ${b.y + H - 7} l8 -5 l8 5 l8 -5 l8 5 l8 -5 l8 5 l8 -5 l8 5 l8 -5 l8 5 l8 -5 l8 5 l8 -5 l8 5 l8 -5 l8 5`} />}
              <text x={b.x + W / 2} y={b.y + 25} className="arch-title">
                {title}
              </text>
              <text x={b.x + W / 2} y={b.y + 45} className="arch-sub">
                {sub}
              </text>
            </g>
          );
        })}
      </svg>
    );
  };

  return (
    <figure className="arch-fig">
      {render("h")}
      {render("v")}
      <figcaption className="fine">{t.method.archDesc}</figcaption>
    </figure>
  );
}
