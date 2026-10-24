import { useMemo } from "react";
import { STATUS_ORDER, type Status } from "../types";

/** One brick per kiln, laid in running bond, grouped by status. The overview's signature element.
 *  Decorative for assistive tech: the counts beside it carry the same information as text. */
export function BrickWall({ counts, cols = 18 }: { counts: Record<Status, number>; cols?: number }) {
  const bricks = useMemo(() => {
    const out: Status[] = [];
    for (const s of STATUS_ORDER) for (let i = 0; i < (counts[s] ?? 0); i++) out.push(s);
    return out;
  }, [counts]);
  const n = bricks.length;
  const c = Math.max(6, Math.min(cols, n));
  const rows = Math.ceil(n / c);
  const bw = 20, bh = 9, gap = 2;
  const W = c * (bw + gap) + bw / 2 + gap;
  const H = rows * (bh + gap) + gap;
  return (
    <svg className="brickwall" viewBox={`0 0 ${W} ${H}`} role="presentation" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="bw-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="4" className="hatch-bg" />
          <rect width="1.6" height="4" className="hatch-fg" />
        </pattern>
      </defs>
      {bricks.map((s, i) => {
        const r = Math.floor(i / c);
        const col = i % c;
        const offset = r % 2 ? (bw + gap) / 2 : 0;
        return (
          <rect
            key={i}
            className={`brick brick-${s}`}
            x={gap + col * (bw + gap) + offset}
            y={gap + r * (bh + gap)}
            width={bw}
            height={bh}
            rx={1.4}
            style={{ animationDelay: `${Math.min(i * 6, 900)}ms` }}
          />
        );
      })}
    </svg>
  );
}
