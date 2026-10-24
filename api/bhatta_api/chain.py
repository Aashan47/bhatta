"""Reads the KilnLedger contract's events and relays signed findings.

Reads go over a public RPC and are cached briefly. The relay pays gas for inspectors and citizens so
nobody needs a wallet with funds to put a signed finding or a dispute on the record. It never signs a
finding itself: the contract checks the inspector's own signature.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from pathlib import Path

EVENT_NAMES = [
    "SeasonPublished",
    "SeasonConfirmed",
    "SeasonActivated",
    "CorrectionPublished",
    "SatelliteProven",
    "FindingAttested",
    "FindingRevised",
    "Conflict",
    "Disputed",
    "Certified",
    "CertificateWithdrawn",
]


class Chain:
    def __init__(self, data_dir: Path, chain_info: dict, fixture: bool):
        self.fixture = fixture
        self.info = chain_info or {}
        self.rpc = os.environ.get("BHATTA_RPC", self.info.get("rpc", "https://ethereum-sepolia-rpc.publicnode.com"))
        self._abi = None
        abi_path = data_dir / "abi" / "KilnLedger.json"
        if abi_path.exists():
            raw = json.loads(abi_path.read_text(encoding="utf-8"))
            self._abi = raw["abi"] if isinstance(raw, dict) and "abi" in raw else raw
        self._w3 = None
        self._contract = None
        self._lock = threading.Lock()
        self._events_cache: tuple[float, list[dict]] = (0.0, [])

    @property
    def configured(self) -> bool:
        return bool(self._abi and self.info.get("contract")) and not self.fixture

    def _connect(self):
        if self._contract is not None:
            return self._contract
        from web3 import Web3

        self._w3 = Web3(Web3.HTTPProvider(self.rpc, request_kwargs={"timeout": 15}))
        self._contract = self._w3.eth.contract(
            address=Web3.to_checksum_address(self.info["contract"]), abi=self._abi
        )
        return self._contract

    def events(self, max_age: float = 60.0) -> list[dict]:
        if not self.configured:
            return list(self.info.get("demo_events", []))
        with self._lock:
            ts, cached = self._events_cache
            if time.time() - ts < max_age:
                return cached
            c = self._connect()
            start = int(self.info.get("deploy_block", 0))
            out: list[dict] = []
            names = {e["name"] for e in self._abi if e.get("type") == "event"}
            for name in EVENT_NAMES:
                if name not in names:
                    continue
                try:
                    logs = getattr(c.events, name)().get_logs(from_block=start)
                except Exception as exc:  # a flaky public RPC must not take the page down
                    out.append({"type": "RpcError", "detail": {"event": name, "error": str(exc)[:200]}})
                    continue
                for lg in logs:
                    out.append(
                        {
                            "type": name,
                            "tx": "0x" + lg["transactionHash"].hex().removeprefix("0x"),
                            "block": lg["blockNumber"],
                            "detail": {k: _plain(v) for k, v in dict(lg["args"]).items()},
                        }
                    )
            self._add_times(out)
            out.sort(key=lambda e: e.get("block", 0), reverse=True)
            self._events_cache = (time.time(), out)
            return out

    def _add_times(self, events: list[dict]) -> None:
        from datetime import datetime, timezone

        from .store import kiln_id_from_bytes32

        cache = getattr(self, "_block_times", {})
        for e in events:
            b = e.get("block")
            if b is None:
                continue
            if b not in cache:
                try:
                    cache[b] = int(self._w3.eth.get_block(b)["timestamp"])
                except Exception:
                    cache[b] = None
            ts = cache[b]
            e["time"] = datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else None
            kid = kiln_id_from_bytes32(e.get("detail", {}).get("kilnId"))
            if kid:
                e["kiln_id"] = kid
        self._block_times = cache

    def conflict_kilns(self) -> set[str]:
        return {e["kiln_id"] for e in self.events() if e.get("type") == "Conflict" and e.get("kiln_id")}

    def events_for(self, kiln_id_bytes32: str | None) -> list[dict]:
        if not kiln_id_bytes32:
            return []
        key = kiln_id_bytes32.lower()
        return [e for e in self.events() if str(e.get("detail", {}).get("kilnId", "")).lower() == key]


def _plain(v):
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex()
    if isinstance(v, int):
        return v if abs(v) < 2**53 else str(v)
    return v


class Relay:
    """Pays gas for a signed finding or a dispute. The contract, not this code, decides validity."""

    def __init__(self, chain: Chain):
        self.chain = chain
        self.key = os.environ.get("BHATTA_RELAYER_KEY", "")
        self._nonce_lock = threading.Lock()

    @property
    def configured(self) -> bool:
        return self.chain.configured and bool(self.key)

    def _send(self, fn) -> str:
        from web3.exceptions import ContractLogicError

        c = self.chain._connect()
        w3 = self.chain._w3
        acct = w3.eth.account.from_key(self.key)
        try:
            fn.call({"from": acct.address})
        except ContractLogicError as exc:
            raise RelayRejected(_revert_reason(c, exc)) from exc
        with self._nonce_lock:
            tx = fn.build_transaction(
                {
                    "from": acct.address,
                    "nonce": w3.eth.get_transaction_count(acct.address, "pending"),
                    "chainId": int(self.chain.info["chain_id"]),
                }
            )
            signed = acct.sign_transaction(tx)
            h = w3.eth.send_raw_transaction(signed.raw_transaction)
        self.chain._events_cache = (0.0, [])
        return "0x" + h.hex().removeprefix("0x")

    def attest(self, body: dict, revise: bool = False) -> str:
        from web3 import Web3

        c = self.chain._connect()
        args = (
            _b32(body["kiln_id"]),
            int(body["season"]),
            int(body["finding"]),
            _b32(body["evidence_hash"]),
            Web3.to_checksum_address(body["inspector"]),
            int(body["nonce"]),
            int(body["deadline"]),
            bytes.fromhex(str(body["signature"]).removeprefix("0x")),
        )
        fn = c.functions.revise(*args) if revise else c.functions.attest(*args)
        return self._send(fn)

    def dispute(self, body: dict) -> str:
        c = self.chain._connect()
        note = str(body.get("note", ""))[:280]
        fn = c.functions.dispute(_b32(body["kiln_id"]), int(body["season"]), _b32(body["evidence_hash"]), note)
        return self._send(fn)


class RelayRejected(Exception):
    pass


def _b32(v: str) -> bytes:
    """Accepts a 0x-prefixed 32-byte hex value or a short id string such as PK-ttnf2b3c."""
    v = str(v)
    if v.startswith("0x") and len(v) == 66:
        return bytes.fromhex(v[2:])
    raw = v.encode("utf-8")
    if len(raw) > 32:
        raise ValueError("id longer than 32 bytes")
    return raw.ljust(32, b"\0")


def _revert_reason(contract, exc) -> str:
    data = getattr(exc, "data", None)
    if isinstance(data, str) and data.startswith("0x") and len(data) >= 10:
        sel = data[:10].lower()
        from web3 import Web3

        for e in contract.abi:
            if e.get("type") == "error":
                sig = e["name"] + "(" + ",".join(i["type"] for i in e["inputs"]) + ")"
                if "0x" + Web3.keccak(text=sig).hex().removeprefix("0x")[:8] == sel:
                    return e["name"]
    m = re.search(r"custom error '([A-Za-z0-9_]+)", str(exc))
    if m:
        return m.group(1)
    return str(exc)[:200]

