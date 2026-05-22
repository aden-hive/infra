#!/usr/bin/env python3
"""
Local↔remote colony parity check.

Compares two `hive serve` instances after pushing the same colony to both
and sending the same prompt. The two HTTP endpoints are passed in via env
(LOCAL_URL, LOCAL_TOKEN, REMOTE_URL, REMOTE_TOKEN, REMOTE_HOST_HEADER).

The shell wrapper (parity-test.sh) sets these up — it spawns the local
`hive serve`, spawns a remote sandbox, opens an SSH tunnel to the
orchestrator, and POSTs the colony tar to both. Then it invokes us with:

  python3 parity-test.py compare \\
    --session-id <local_sid>:<remote_sid> \\
    --report /tmp/parity-<run>/report.json

We GET the parity-relevant endpoints from each side, compare them
along the dimensions in PARITY_DIMENSIONS, and print a PASS/FAIL matrix.

Why a separate Python script: the comparison logic does enough JSON
diffing that bash alone gets ugly. Keeping it Python lets us reuse the
existing test conventions in core/framework/server/tests/.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path


# ---------------------------------------------------------------------------
# Parity dimensions
# ---------------------------------------------------------------------------
#
# Each (label, lambda) extracts a comparable value from the {local, remote}
# response bundle. The lambda receives a dict with "session", "events",
# "skills", "workers", "config_llm", "credentials" — whatever was fetched.
# Returning a value that compares unequal between the two sides surfaces
# as a FAIL row in the report.
#
# The "agent_path" comparator is a special case — both sides have an
# agent_path under colonies/<name>/, but the prefixes differ
# (~/.config/Hive/users/<hash>/ vs /root/.hive). We compare suffixes.

@dataclass
class Bundle:
    """Everything we GET'd from one side."""
    session: dict
    events: list
    skills: dict
    workers: dict
    config_llm: dict
    credentials: dict


def _agent_path_suffix(p: str | None) -> str | None:
    """Strip everything before /colonies/ so local & remote paths match."""
    if not p:
        return p
    idx = p.find("/colonies/")
    return p[idx:] if idx >= 0 else p


def _first_tool_call(events: list) -> str | None:
    """Return the .data.name of the first tool_call_started event."""
    for ev in events:
        if ev.get("type") == "tool_call_started":
            data = ev.get("data") or {}
            return data.get("name")
    return None


def _has_llm_auth_error(events: list) -> bool:
    """True if any error event mentions an LLM auth/credential failure."""
    needles = ("AuthenticationError", "missing_auth", "Invalid Hive API key",
               "Missing Anthropic API Key")
    for ev in events:
        if ev.get("type") not in ("error", "stream_error", "exception"):
            continue
        blob = json.dumps(ev.get("data") or {})
        if any(n in blob for n in needles):
            return True
    return False


def _credential_ids(creds_resp: dict) -> set[str]:
    return {c.get("credential_id") for c in (creds_resp.get("credentials") or [])
            if c.get("credential_id")}


PARITY_DIMENSIONS = [
    ("queen_id",
     "Queen identity loaded from metadata.json",
     lambda b: b.session.get("queen_id")),
    ("queen_phase",
     "Queen phase after import (working / paused / etc.)",
     lambda b: b.session.get("queen_phase")),
    ("colony_name",
     "Colony display name",
     lambda b: b.session.get("colony_name")),
    ("has_worker",
     "Whether the worker config was loaded",
     lambda b: bool(b.session.get("has_worker"))),
    ("agent_path_suffix",
     "agent_path under colonies/, ignoring HIVE_HOME prefix",
     lambda b: _agent_path_suffix(b.session.get("agent_path"))),
    ("llm_provider",
     "Active LLM provider",
     lambda b: b.config_llm.get("provider")),
    ("llm_model",
     "Active LLM model",
     lambda b: b.config_llm.get("model")),
    ("llm_has_api_key",
     "LLM provider has an API key — must be true on both",
     lambda b: bool(b.config_llm.get("has_api_key"))),
    ("hive_credential_present",
     "Encrypted store has a credential id 'hive'",
     lambda b: "hive" in _credential_ids(b.credentials)),
    ("skills_count",
     "Number of skills in the colony catalog",
     lambda b: len(b.skills.get("skills") or [])),
    ("skills_names",
     "Set equality of skill names",
     lambda b: sorted(s.get("name") for s in (b.skills.get("skills") or []) if s.get("name"))),
    ("first_tool_call",
     "Name of the first tool_call_started event (None if queen replied without tools)",
     lambda b: _first_tool_call(b.events)),
    ("no_llm_auth_error",
     "Neither side may have logged an LLM auth error",
     lambda b: not _has_llm_auth_error(b.events)),
]


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get(url: str, *, token: str | None = None, host_header: str | None = None,
         timeout: float = 10.0) -> dict | list:
    req = urllib.request.Request(url)
    if token:
        req.add_header("X-Hive-Token", token)
    if host_header:
        req.add_header("Host", host_header)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"GET {url} → {e.code}: {body[:300]}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise RuntimeError(f"GET {url} → {e}")


def fetch_bundle(base: str, session_id: str, *, token: str | None = None,
                 host_header: str | None = None) -> Bundle:
    """Pull the parity-relevant endpoints from one side."""
    def g(path: str, *, default=None):
        try:
            return _get(f"{base}{path}", token=token, host_header=host_header)
        except RuntimeError as e:
            print(f"  (warning, fetch {path}: {e})", file=sys.stderr)
            return default

    session = g(f"/api/sessions/{session_id}", default={}) or {}
    events_resp = g(f"/api/sessions/{session_id}/events/history?limit=200",
                    default={"events": []}) or {}
    events = events_resp.get("events") if isinstance(events_resp, dict) else (events_resp or [])
    skills = g(f"/api/sessions/{session_id}/colony/skills", default={"skills": []}) or {"skills": []}
    workers = g(f"/api/sessions/{session_id}/workers", default={"workers": []}) or {"workers": []}
    config_llm = g("/api/config/llm", default={}) or {}
    credentials = g("/api/credentials", default={"credentials": []}) or {"credentials": []}
    return Bundle(session=session, events=events, skills=skills, workers=workers,
                  config_llm=config_llm, credentials=credentials)


# ---------------------------------------------------------------------------
# Comparison + report
# ---------------------------------------------------------------------------

def compare(local: Bundle, remote: Bundle) -> tuple[list[dict], bool]:
    rows = []
    overall_pass = True
    for label, desc, extract in PARITY_DIMENSIONS:
        try:
            lv = extract(local)
            rv = extract(remote)
        except Exception as e:  # noqa: BLE001
            rows.append({"dimension": label, "pass": False, "local": "<error>",
                         "remote": "<error>", "description": desc, "error": str(e)})
            overall_pass = False
            continue
        # Special-case: llm_has_api_key + no_llm_auth_error must be True on
        # *both* sides, not just equal between them. A False/False parity
        # would silently pass.
        if label in ("llm_has_api_key", "no_llm_auth_error", "hive_credential_present"):
            ok = bool(lv) and bool(rv)
        else:
            ok = lv == rv
        if not ok:
            overall_pass = False
        rows.append({"dimension": label, "pass": ok, "local": lv, "remote": rv,
                     "description": desc})
    return rows, overall_pass


def print_matrix(rows: list[dict]) -> None:
    width = max(len(r["dimension"]) for r in rows)
    print()
    print(f"{'dimension':<{width}}  pass  local                          remote")
    print(f"{'-' * width}  ----  -----------------------------  -----------------------------")
    for r in rows:
        mark = "✓" if r["pass"] else "✗"
        lv = json.dumps(r["local"], default=str)[:30]
        rv = json.dumps(r["remote"], default=str)[:30]
        print(f"{r['dimension']:<{width}}  {mark}     {lv:<30}  {rv:<30}")
    print()


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--local-url", default=os.environ.get("LOCAL_URL"),
                        help="e.g. http://127.0.0.1:44625")
    parser.add_argument("--local-token", default=os.environ.get("LOCAL_TOKEN", ""),
                        help="X-Hive-Token for the local hive serve")
    parser.add_argument("--remote-url", default=os.environ.get("REMOTE_URL"),
                        help="e.g. http://127.0.0.1:5007 (orchestrator host-header proxy)")
    parser.add_argument("--remote-host-header",
                        default=os.environ.get("REMOTE_HOST_HEADER"),
                        help="e.g. 8787-<sandbox-id>.vm.open-hive.com")
    parser.add_argument("--local-session-id", required=True)
    parser.add_argument("--remote-session-id", required=True)
    parser.add_argument("--report", required=True, help="Where to write the JSON report")
    args = parser.parse_args()

    if not all([args.local_url, args.remote_url, args.remote_host_header]):
        print("error: --local-url, --remote-url, --remote-host-header all required",
              file=sys.stderr)
        return 2

    print(f"→ fetching local bundle from {args.local_url}/api/sessions/{args.local_session_id}")
    local = fetch_bundle(args.local_url, args.local_session_id, token=args.local_token)
    print(f"→ fetching remote bundle from {args.remote_url} (Host: {args.remote_host_header})"
          f" sid={args.remote_session_id}")
    remote = fetch_bundle(args.remote_url, args.remote_session_id,
                          host_header=args.remote_host_header)

    rows, overall = compare(local, remote)
    print_matrix(rows)

    report = {
        "timestamp": int(time.time()),
        "overall_pass": overall,
        "dimensions": rows,
        "local_url": args.local_url,
        "remote_url": args.remote_url,
        "remote_host_header": args.remote_host_header,
    }
    Path(args.report).parent.mkdir(parents=True, exist_ok=True)
    Path(args.report).write_text(json.dumps(report, indent=2, default=str))
    print(f"→ report: {args.report}")

    if overall:
        print("PASS")
        return 0
    print("FAIL")
    return 1


if __name__ == "__main__":
    sys.exit(main())
