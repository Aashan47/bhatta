import { useState, type ReactNode } from "react";
import type { Abi } from "viem";
import { chipUrl, FIXTURE, getLedger } from "../api";
import { usePrefs } from "../i18n";
import {
  computeLeaf,
  DEFAULT_RPC,
  evidenceHash,
  processProof,
  readCurrentRoot,
  sha256Bytes,
} from "../lib/chain";
import { prefersReducedMotion } from "../lib/util";
import { STATUS_CODE, type Hex, type KilnRecord, type Ledger } from "../types";
import { CheckGlyph, CrossGlyph, Hash, TxLink } from "./ui";

type StepKey = "evidence" | "leaf" | "root" | "proof" | "tx";
type StepState = "idle" | "run" | "pass" | "fail" | "skip";
interface Step {
  key: StepKey;
  state: StepState;
  detail?: ReactNode;
}

const KEYS: StepKey[] = ["evidence", "leaf", "root", "proof", "tx"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, prefersReducedMotion() ? 0 : ms));

function Compare({ a, b, la, lb }: { a: string; b: string; la: string; lb: string }) {
  return (
    <dl className="cmp-hash">
      <div>
        <dt>{la}</dt>
        <dd>
          <Hash value={a} head={10} tail={8} copy={false} />
        </dd>
      </div>
      <div>
        <dt>{lb}</dt>
        <dd>
          <Hash value={b} head={10} tail={8} copy={false} />
        </dd>
      </div>
    </dl>
  );
}

export function VerifyPanel({ rec, modelSha }: { rec: KilnRecord; modelSha?: Hex }) {
  const { t } = usePrefs();
  const [steps, setSteps] = useState<Step[]>(KEYS.map((key) => ({ key, state: "idle" })));
  const [running, setRunning] = useState(false);
  const [ledger, setLedger] = useState<Ledger | null>(null);
  const [done, setDone] = useState<null | "pass" | "fail">(null);

  const set = (key: StepKey, state: StepState, detail?: ReactNode) =>
    setSteps((s) => s.map((x) => (x.key === key ? { key, state, detail } : x)));

  async function run() {
    setRunning(true);
    setDone(null);
    setSteps(KEYS.map((key) => ({ key, state: "idle" })));
    let ok = true;
    const fail = (k: StepKey, d: ReactNode) => {
      ok = false;
      set(k, "fail", d);
    };

    // 1. Evidence hash from the chip bytes and the model output.
    set("evidence", "run");
    await sleep(250);
    const model = rec.observation.model_sha256 ?? modelSha;
    if (!model) {
      set("evidence", "skip", t.verify.evidenceMissingModel);
    } else {
      try {
        const res = await fetch(chipUrl(rec.observation.chip));
        if (!res.ok) throw new Error(`${res.status} for chip`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const chipSha = sha256Bytes(bytes);
        const ev = evidenceHash(rec, chipSha, model);
        const detail = (
          <>
            <p>{t.verify.evidenceDetail(bytes.length)}</p>
            <Compare a={ev} b={rec.chain.evidence_hash} la={t.verify.computed} lb={t.verify.expected} />
          </>
        );
        if (ev.toLowerCase() === rec.chain.evidence_hash.toLowerCase()) set("evidence", "pass", detail);
        else
          fail(
            "evidence",
            <>
              <p>{t.verify.evidenceMismatch}</p>
              {detail}
            </>,
          );
      } catch (e) {
        fail("evidence", (e as Error).message);
      }
    }

    // 2. Leaf from the record.
    set("leaf", "run");
    await sleep(250);
    const bp = rec.observation.probs ? Math.round(rec.observation.probs.Zigzag * 10000) : 0;
    const leaf = computeLeaf(rec.id, rec.chain.season, rec.chain.status_code, rec.chain.p_zigzag_bp, rec.chain.evidence_hash);
    if (rec.chain.status_code !== STATUS_CODE[rec.status] || rec.chain.p_zigzag_bp !== bp) {
      fail("leaf", t.verify.statusMismatch);
    } else if (leaf.toLowerCase() !== rec.chain.leaf.toLowerCase()) {
      fail(
        "leaf",
        <>
          <p>{t.verify.leafMismatch}</p>
          <Compare a={leaf} b={rec.chain.leaf} la={t.verify.computed} lb={t.verify.expected} />
        </>,
      );
    } else {
      set(
        "leaf",
        "pass",
        <>
          <p className="mono-line" dir="ltr">
            keccak256(keccak256(abi.encode(kilnId, {rec.chain.season}, {rec.chain.status_code}, {rec.chain.p_zigzag_bp}, evidenceHash)))
          </p>
          <Compare a={leaf} b={rec.chain.leaf} la={t.verify.computed} lb={t.verify.expected} />
        </>,
      );
    }

    // 3. Root from the contract.
    set("root", "run");
    let root: Hex | null = null;
    let lg: Ledger | null = null;
    try {
      lg = await getLedger();
      setLedger(lg);
      if (lg.mock_chain || FIXTURE) {
        root = lg.seasons.find((x) => x.season === rec.chain.season)?.root ?? null;
        if (root)
          set(
            "root",
            "pass",
            <>
              <p>{t.verify.rootMock}</p>
              <Hash value={root} head={10} tail={8} />
            </>,
          );
        else fail("root", t.verify.rootNoContract);
      } else if (!lg.contract) {
        fail("root", t.verify.rootNoContract);
      } else {
        const rpc = lg.rpc ?? DEFAULT_RPC;
        root = await readCurrentRoot({ contract: lg.contract, season: rec.chain.season, rpc, abi: lg.abi as Abi | undefined });
        set(
          "root",
          "pass",
          <>
            <p>{t.verify.rootFrom(new URL(rpc).host)}</p>
            <Hash value={root} head={10} tail={8} />
          </>,
        );
      }
    } catch (e) {
      fail("root", t.verify.rootError((e as Error).message.split("\n")[0] ?? ""));
    }

    // 4. Proof.
    set("proof", "run");
    await sleep(300);
    if (!root) {
      set("proof", "skip");
    } else {
      const { root: folded } = processProof(leaf, rec.chain.proof);
      const d = (
        <>
          <p>{t.verify.proofLevels(rec.chain.proof.length)}</p>
          <Compare a={folded} b={root} la={t.verify.computed} lb={t.verify.onChain} />
        </>
      );
      if (folded.toLowerCase() === root.toLowerCase()) set("proof", "pass", d);
      else
        fail(
          "proof",
          <>
            <p>{t.verify.proofMismatch}</p>
            {d}
          </>,
        );
    }

    // 5. Transaction link.
    set("tx", "run");
    await sleep(150);
    const season = lg?.seasons.find((x) => x.season === rec.chain.season);
    if (season && lg) set("tx", "pass", <TxLink tx={season.tx} explorer={lg.explorer} sample={lg.mock_chain} />);
    else set("tx", "skip");

    setDone(ok ? "pass" : "fail");
    setRunning(false);
  }

  const mock = FIXTURE || ledger?.mock_chain;
  return (
    <section className="panel verify" aria-labelledby="verify-h">
      <h2 id="verify-h" className="panel-title">
        {t.verify.title}
      </h2>
      <p>{t.verify.lead}</p>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.key} className={`step step-${s.state}`}>
            <span className="step-mark" aria-hidden="true">
              {s.state === "pass" ? <CheckGlyph /> : s.state === "fail" ? <CrossGlyph /> : s.state === "run" ? <span className="spin" /> : null}
            </span>
            <div className="step-body">
              <p className="step-title">
                {t.verify.steps[s.key]}
                {(s.state === "pass" || s.state === "fail" || s.state === "skip") && (
                  <span className={`step-word step-word-${s.state}`}>
                    {s.state === "pass" ? t.verify.pass : s.state === "fail" ? t.verify.fail : t.verify.skip}
                  </span>
                )}
              </p>
              {s.detail && <div className="step-detail">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>
      <div aria-live="polite">
        {done === "pass" && <p className="verdict verdict-pass">{mock ? t.verify.allPassMock : t.verify.allPass}</p>}
        {done === "fail" && <p className="verdict verdict-fail">{t.verify.someFail}</p>}
      </div>
      <button type="button" className="btn btn-primary" onClick={run} disabled={running}>
        {running ? t.verify.running : done ? t.verify.rerun : t.verify.run}
      </button>
    </section>
  );
}
