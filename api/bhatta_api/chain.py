"""Reads the KilnLedger contract's events and relays signed findings.

Reads go over a public RPC and are cached briefly. The relay pays gas for inspectors and citizens so
nobody needs a wallet with funds to put a signed finding or a dispute on the record. It never signs a
finding itself: the contract checks the inspector's own signature.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path

EVENT_NAMES = [
    "SeasonPublished",
    "SeasonCorrected",
    "SatelliteProven",
    "FindingRecorded",
    "FindingRevised",
    "Conflict",
    "Disputed",
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
            out.sort(key=lambda e: e.get("block", 0), reverse=True)
            self._events_cache = (time.time(), out)
            return out

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
