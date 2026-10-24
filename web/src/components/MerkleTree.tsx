import { usePrefs } from "../i18n";
import { shortHex } from "../lib/chain";
import type { Hex } from "../types";

export interface ProofLevel {
  sibling: Hex;
  /** true when the sibling sorts first, so it sits on the left of the pair (OpenZeppelin sorted pairs) */
  siblingLeft: boolean;
  out: Hex;
}

export type TreeOutcome = "pending" | "match" | "mismatch" | "noroot";

/** The proof path drawn bottom-up: the leaf, the sibling at each level, the folded node above, and the
 *  root read from the contract. Levels light up as `revealed` grows. */
export function MerkleTree({
  leaf,
  levels,
  chainRoot,
  revealed,
  outcome,
  leafBad,
}: {
  leaf: Hex;
  levels: ProofLevel[];
  chainRoot: Hex | null;
  revealed: number;
  outcome: TreeOutcome;
  leafBad: boolean;
}) {
  const { t } = usePrefs();
  const m = t.verify.tree;
  const ROW = 44;
  const W = 360;
  const NW = 108;
  const NH = 24;
  const cx = W / 2;
  const n = levels.length;
  const H = (n + 1) * ROW + 84;
  const yOf = (lvl: number) => H - 44 - lvl * ROW; // level 0 = leaf at the bottom
  const node = (x: number, y: number, label: string, cls: string, title: string, key: string, delay = 0) => (
    <g key={key} className={`mk-node ${cls}`} transform={`translate(${x - NW / 2}, ${y - NH / 2})`} style={{ ["--d" as string]: `${delay}ms` }}>
      <title>{title}</title>
      <rect width={NW} height={NH} rx={5} />
      <text x={NW / 2} y={NH / 2 + 4}>
        {label}
      </text>
    </g>
  );
  const done = revealed >= n;
  const rootCls = !done ? (revealed >= n ? "lit" : "") : outcome === "match" ? "lit is-match" : outcome === "pending" ? "lit" : "lit is-bad";

  return (
    <figure className="merkle">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={m.label(n)} className={`merkle-svg ${done && outcome === "match" ? "path-ok" : ""}`}>
        {/* edges */}
        {levels.map((lv, i) => {
          const y0 = yOf(i);
          const y1 = yOf(i + 1);
          const sx = lv.siblingLeft ? cx - NW - 4 : cx + NW + 4;
          const lit = revealed > i ? "lit" : "";
          return (
            <g key={`e${i}`} className={`mk-edge ${lit}`} style={{ ["--d" as string]: `${i * 90}ms` }}>
              <line className="mk-path" x1={cx} y1={y0 - NH / 2} x2={cx} y2={y1 + NH / 2} />
              <line x1={sx} y1={y0 - NH / 2} x2={cx + (lv.siblingLeft ? -20 : 20)} y2={y1 + NH / 2} />
            </g>
          );
        })}
        {node(cx, yOf(0), shortHex(leaf, 4, 4), `mk-leaf lit ${leafBad ? "is-bad" : ""}`, `${m.leaf}: ${leaf}`, "leaf")}
        <text className="mk-cap" x={cx} y={yOf(0) + NH / 2 + 16} textAnchor="middle">
          {m.leaf}
        </text>
        {levels.map((lv, i) => {
          const sx = lv.siblingLeft ? cx - NW - 4 : cx + NW + 4;
          const top = i === n - 1;
          return (
            <g key={`l${i}`}>
              {node(sx, yOf(i), shortHex(lv.sibling, 4, 4), `mk-sib ${revealed > i ? "lit" : ""}`, `${m.sibling} ${i + 1}: ${lv.sibling}`, `s${i}`)}
              {node(cx, yOf(i + 1), shortHex(lv.out, 4, 4), top ? `mk-root ${rootCls}` : `mk-mid ${revealed > i ? "lit" : ""}`, `${top ? m.folded : m.level(i + 1)}: ${lv.out}`, `o${i}`, (i + 1) * 90)}
            </g>
          );
        })}
        {n === 0 && node(cx, yOf(1), shortHex(leaf, 4, 4), `mk-root ${rootCls}`, m.folded, "o0")}
        <text className="mk-cap" x={cx} y={yOf(n + 1) + 8} textAnchor="middle">
          {chainRoot ? m.onChain(shortHex(chainRoot, 4, 4)) : m.noRoot}
        </text>
      </svg>
      <figcaption className="fine" aria-live="polite">
        {!done ? m.folding(Math.min(revealed + 1, n), n) : outcome === "match" ? m.match : outcome === "noroot" ? m.noRootLong : outcome === "mismatch" ? m.mismatchTop : m.folding(n, n)}
        {leafBad && <> {m.leafBad}</>}
      </figcaption>
    </figure>
  );
}
