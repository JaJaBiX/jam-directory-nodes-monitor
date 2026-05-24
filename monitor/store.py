from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import shutil
from typing import Any


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(payload, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    tmp.replace(path)


def append_jsonl(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True) + "\n")


def load_history(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        return []
    return data


def parse_checked_at(value: Any) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def write_outputs(
    web_dir: Path,
    data_dir: Path,
    latest: dict[str, Any],
    max_history_samples: int,
    history_retention_days: int,
) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    web_data_dir = web_dir / "data"
    history_path = web_data_dir / "history.json"
    history = load_history(history_path)
    summary = latest.get("summary") or {}
    for item in latest["nodes"]:
        history.append(
            {
                "checked_at": latest["checked_at"],
                "node": item["node"],
                "ok": item["ok"],
                "offers": item["offers"],
                "fidelity_bonds": item["fidelity_bonds"],
                "makers": item["makers"],
                "latency_ms": item["latency_ms"],
                "nodes_ok": summary.get("nodes_ok"),
                "nodes_total": summary.get("nodes_total"),
                "offers_unique_total": summary.get("offers_unique_total"),
                "makers_unique_total": summary.get("makers_unique_total"),
            }
        )
    latest_checked_at = parse_checked_at(latest.get("checked_at")) or datetime.now(timezone.utc)
    cutoff = latest_checked_at - timedelta(days=max(1, min(30, history_retention_days)))
    history = [
        item
        for item in history
        if (
            (parsed := parse_checked_at(item.get("checked_at"))) is None
            or parsed >= cutoff
        )
    ]
    if max_history_samples > 0:
        history = history[-max_history_samples:]

    atomic_write_json(web_data_dir / "latest.json", latest)
    atomic_write_json(history_path, history)
    append_jsonl(data_dir / "probes.jsonl", latest)


def copy_static_site(source_web_dir: Path, dest_dir: Path) -> None:
    if dest_dir.exists():
        shutil.rmtree(dest_dir)
    shutil.copytree(source_web_dir, dest_dir, ignore=shutil.ignore_patterns(".github"))
