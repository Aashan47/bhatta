import { useId, useState } from "react";
import { createWalletClient, custom, defineChain, type Abi, type EIP1193Provider } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getLedger, relayAttest, relayDispute } from "../api";
import { usePrefs } from "../i18n";
import { CHAIN_NAMES, FINDING_TYPES, findingDomain, kilnIdBytes32, readEip712Domain, readNonce, sha256Bytes } from "../lib/chain";
import type { FindingCode, Hex, KilnRecord, Ledger } from "../types";
import { Hash, TxLink } from "./ui";

declare global {
  interface Window {
    ethereum?: EIP1193Provider;
  }
}

async function hashFile(f: File | null): Promise<Hex> {
  if (!f) return sha256Bytes(new Uint8Array());
  return sha256Bytes(new Uint8Array(await f.arrayBuffer()));
}

type Phase =
  | { k: "idle" }
  | { k: "signing" }
  | { k: "relaying"; signature: Hex; signer: Hex }
  | { k: "relayed"; signature: Hex; signer: Hex; tx: Hex; ledger: Ledger }
  | { k: "rejected"; signature?: Hex; signer?: Hex; message: string }
  | { k: "error"; message: string };

const REVISION_TYPES = { Revision: FINDING_TYPES.Finding } as const;

export function SignFinding({ rec, season }: { rec: KilnRecord; season: number }) {
  const { t } = usePrefs();
  const fid = useId();
  const [finding, setFinding] = useState<FindingCode>(1);
  const [file, setFile] = useState<File | null>(null);
  const [evHash, setEvHash] = useState<Hex | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: "idle" });
  const [demoAddr, setDemoAddr] = useState<Hex | null>(null);
  const [revise, setRevise] = useState(false);
  const hasWallet = typeof window !== "undefined" && !!window.ethereum;

  async function sign(mode: "wallet" | "demo") {
    setPhase({ k: "signing" });
    try {
      const ledger = await getLedger();
      const evidence = evHash ?? (await hashFile(file));
      setEvHash(evidence);
      const eip712 = ledger.eip712 ?? (ledger.contract && !ledger.mock_chain ? await readEip712Domain({ contract: ledger.contract, rpc: ledger.rpc }) : null);
      const domain = findingDomain(ledger.chain_id, ledger.contract, eip712);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);
      let signer: Hex;
      let signature: Hex;
      let nonce = 0n;

      // The signed struct carries no inspector field: the contract recovers the signer and checks it
      // against the inspector address passed to attest().
      const messageFor = (nonce: bigint) => ({
        kilnId: kilnIdBytes32(rec.id),
        season,
        finding,
        evidenceHash: evidence,
        nonce,
        deadline,
      });


      if (mode === "wallet" && window.ethereum) {
        const chain = defineChain({
          id: ledger.chain_id,
          name: ledger.chain_name || CHAIN_NAMES[ledger.chain_id] || "chain",
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: { default: { http: [ledger.rpc] } },
        });
        const wallet = createWalletClient({ chain, transport: custom(window.ethereum) });
        const [account] = await wallet.requestAddresses();
        if (!account) throw new Error(t.sign.walletNone);
        const chainId = await wallet.getChainId();
        if (chainId !== ledger.chain_id) {
          try {
            await wallet.switchChain({ id: ledger.chain_id });
          } catch {
            setPhase({ k: "error", message: t.sign.wrongChain });
            return;
          }
        }
        nonce = ledger.contract ? ((await readNonce({ contract: ledger.contract, inspector: account, rpc: ledger.rpc, abi: ledger.abi as Abi | undefined })) ?? 0n) : 0n;
        signer = account;
        signature = revise
          ? await wallet.signTypedData({ account, domain, types: REVISION_TYPES, primaryType: "Revision", message: messageFor(nonce) })
          : await wallet.signTypedData({ account, domain, types: FINDING_TYPES, primaryType: "Finding", message: messageFor(nonce) });
      } else {
        const acct = privateKeyToAccount(generatePrivateKey());
        setDemoAddr(acct.address);
        signer = acct.address;
        if (ledger.contract && !ledger.mock_chain) nonce = (await readNonce({ contract: ledger.contract, inspector: acct.address, rpc: ledger.rpc })) ?? 0n;
        signature = revise
          ? await acct.signTypedData({ domain, types: REVISION_TYPES, primaryType: "Revision", message: messageFor(nonce) })
          : await acct.signTypedData({ domain, types: FINDING_TYPES, primaryType: "Finding", message: messageFor(nonce) });
      }

      setPhase({ k: "relaying", signature, signer });
      const res = await relayAttest({
        kiln_id: rec.id,
        season,
        finding,
        evidence_hash: evidence,
        inspector: signer,
        nonce: nonce.toString(),
        deadline: deadline.toString(),
        signature,
        revise,
      }).catch((e: Error) => ({ error: e.message, tx: undefined }));
      if (res.tx) setPhase({ k: "relayed", signature, signer, tx: res.tx, ledger });
      else setPhase({ k: "rejected", signature, signer, message: res.error ?? t.sign.rejected });
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setPhase({ k: "error", message: /reject|denied|cancel/i.test(m) ? t.sign.cancelled : m.split("\n")[0]! });
    }
  }

  const busy = phase.k === "signing" || phase.k === "relaying";
  return (
    <div className="action-body">
      <p>{t.sign.lead}</p>
      <div className="field">
        <label htmlFor={`${fid}-f`}>{t.sign.finding}</label>
        <select id={`${fid}-f`} value={finding} onChange={(e) => setFinding(Number(e.target.value) as FindingCode)}>
          {[1, 2, 3, 4].map((f) => (
            <option key={f} value={f}>
              {t.events.finding[f]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${fid}-e`}>{t.sign.evidence}</label>
        <input
          id={`${fid}-e`}
          type="file"
          onChange={async (e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setEvHash(await hashFile(f));
          }}
        />
        <p className="help">{t.sign.evidenceHelp}</p>
        <p className="help">
          {t.sign.hash}: {evHash ? <Hash value={evHash} /> : t.sign.evidenceNone}
        </p>
      </div>
      <label className="check">
        <input type="checkbox" checked={revise} onChange={(e) => setRevise(e.target.checked)} />
        <span>{t.sign.revise}</span>
      </label>
      <p className={`wallet-state ${hasWallet ? "ok" : ""}`}>{hasWallet ? t.sign.walletFound : t.sign.walletNone}</p>
      <div className="btn-row">
        {hasWallet && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => sign("wallet")}>
            {t.sign.connect}
          </button>
        )}
        <button type="button" className={`btn ${hasWallet ? "btn-secondary" : "btn-primary"}`} disabled={busy} onClick={() => sign("demo")}>
          {t.sign.demo}
        </button>
      </div>
      <p className="note-box">{t.sign.demoExplain}</p>
      <div aria-live="polite" className="phase">
        {demoAddr && (
          <p>
            {t.sign.demoKey}: <Hash value={demoAddr} />
          </p>
        )}
        {phase.k === "signing" && <p>{t.sign.signing}</p>}
        {(phase.k === "relaying" || phase.k === "relayed" || (phase.k === "rejected" && phase.signature)) && (
          <p>
            {t.sign.signed}. {t.sign.signature}: <Hash value={(phase as { signature: Hex }).signature} head={10} tail={8} />
          </p>
        )}
        {phase.k === "relaying" && <p>{t.sign.relaying}</p>}
        {phase.k === "relayed" && (
          <p className="verdict verdict-pass">
            {t.sign.relayed("")} <TxLink tx={phase.tx} explorer={phase.ledger.explorer} />
          </p>
        )}
        {phase.k === "rejected" && (
          <p className="verdict verdict-fail">
            {t.sign.rejected}: {phase.message}
          </p>
        )}
        {phase.k === "error" && <p className="verdict verdict-fail">{phase.message}</p>}
      </div>
    </div>
  );
}

export function DisputeForm({ rec, season }: { rec: KilnRecord; season: number }) {
  const { t } = usePrefs();
  const fid = useId();
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tx?: Hex; error?: string; explorer?: string | null } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (note.trim().length < 10) {
      setErr(t.disputeForm.tooShort);
      return;
    }
    setErr(null);
    setBusy(true);
    try {
      const evidence = file ? await hashFile(file) : sha256Bytes(new TextEncoder().encode(note.trim()));
      const ledger = await getLedger().catch(() => null);
      const res = await relayDispute({ kiln_id: rec.id, season, evidence_hash: evidence, note: note.trim() });
      setResult({ ...res, explorer: res.explorer ?? ledger?.explorer ?? "" });
    } catch (e2) {
      setResult({ error: (e2 as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="action-body" onSubmit={submit} noValidate>
      <p>{t.disputeForm.lead}</p>
      <div className="field">
        <label htmlFor={`${fid}-n`}>{t.disputeForm.note}</label>
        <textarea
          id={`${fid}-n`}
          rows={3}
          maxLength={280}
          value={note}
          placeholder={t.disputeForm.notePlaceholder}
          onChange={(e) => setNote(e.target.value)}
          aria-invalid={!!err}
          aria-describedby={`${fid}-p ${err ? `${fid}-err` : ""}`}
        />
        <p className="help" id={`${fid}-p`}>
          {t.disputeForm.privacy} <span dir="ltr">{note.length}/280</span>
        </p>
        {err && (
          <p className="field-error" id={`${fid}-err`}>
            {err}
          </p>
        )}
      </div>
      <div className="field">
        <label htmlFor={`${fid}-f`}>{t.disputeForm.evidence}</label>
        <input id={`${fid}-f`} type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <p className="help">{t.sign.evidenceHelp}</p>
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? t.disputeForm.submitting : t.disputeForm.submit}
      </button>
      <div aria-live="polite" className="phase">
        {result?.tx && (
          <p className="verdict verdict-pass">
            {t.disputeForm.filed("")} <TxLink tx={result.tx} explorer={result.explorer ?? ""} />
          </p>
        )}
        {result?.error && <p className="verdict verdict-fail">{result.error}</p>}
      </div>
    </form>
  );
}
