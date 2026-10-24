import { useEffect, useState } from "react";
import { getQueue } from "../api";

/** Fallback for 3D column heights when /api/kilns has no p_fcbk: read p(Zigzag) from the queue,
 *  only once 3D is switched on; p(FCBK) = 1 - p(Zigzag). */
export function usePFcbk(enabled: boolean): Map<string, number> | undefined {
  const [m, setM] = useState<Map<string, number>>();
  useEffect(() => {
    if (!enabled || m) return;
    let live = true;
    getQueue()
      .then((q) => {
        if (!live) return;
        const out = new Map<string, number>();
        for (const x of q) if (x.p_zigzag != null) out.set(x.id, 1 - x.p_zigzag);
        setM(out);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, m]);
  return m;
}
