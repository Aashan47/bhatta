import { useMemo } from "react";
import { STATUS_ORDER, type Status } from "../types";

const STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/** Kilns per brick: the smallest round number that keeps the wall at about 300 bricks or fewer. */
export function brickScale(counts: Record<Status, number>, maxBricks = 300): number {
  const bricksAt = (n: number) => STATUS_ORDER.reduce((a, s) => a + Math.ceil((counts[s] ?? 0) / n), 0);
  return STEPS.find((n) => bricksAt(n) <= maxBricks) ?? STEPS[STEPS.length - 1]!;
}

/** One brick per N kilns, laid in running bond, grouped by status. Counts round up so a status with
 *  any kilns shows at least one brick. Decorative for assistive tech: the tally beside it has the
 *  exact numbers. */
export function BrickWall({ counts, scale, cols = 18 }: { counts: Record<Status, number>; scale: number; cols?: number }) {
  const bricks = useMemo(() => {
    const out: Status[] = [];
    for (const s of STATUS_ORDER) for (let i = 0; i < Math.ceil((counts[s] ?? 0) / scale); i++) out.push(s);
    return out;
  }, [counts, scale]);
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
            style={{ animationDelay: `${Math.min(i * 4, 900)}ms` }}
          />
        );
      })}
    </svg>
  );
}
