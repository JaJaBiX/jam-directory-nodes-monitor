from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path


DEFAULT_DATA_DIR = Path(os.environ.get("MONITOR_DATA_DIR", "/app/data"))
DEFAULT_WEB_DIR = Path(os.environ.get("MONITOR_WEB_DIR", "/app/web"))


@dataclass(frozen=True)
class Settings:
    nodes: tuple[str, ...]
    tor_socks_host: str
    tor_socks_port: int
    jm_network: str
    poll_interval_seconds: int
    probe_timeout_seconds: int
    orderbook_collect_seconds: int
    max_history_samples: int
    history_retention_days: int
    data_dir: Path
    web_dir: Path
    publish_enabled: bool
    publish_interval_seconds: int
    publish_remote_url: str
    publication_branch: str
    git_author_name: str
    git_author_email: str
    gh_preflight: bool


def parse_bool(value: str | None, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_nodes(value: str | None) -> tuple[str, ...]:
    if not value:
        return ()
    return tuple(node.strip() for node in value.split(",") if node.strip())


def load_nodes_file(path: str | None) -> tuple[str, ...]:
    if not path:
        return ()
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("Nodes file must contain a JSON list")
    nodes = []
    for item in data:
        if not isinstance(item, str):
            raise ValueError("Nodes file entries must be strings")
        if item.strip():
            nodes.append(item.strip())
    return tuple(nodes)


def load_settings(nodes_file: str | None = None) -> Settings:
    file_nodes = load_nodes_file(nodes_file)
    env_nodes = parse_nodes(os.environ.get("DIRECTORY_NODES"))
    nodes = file_nodes or env_nodes
    if not nodes:
        raise ValueError("No directory nodes configured")

    return Settings(
        nodes=nodes,
        tor_socks_host=os.environ.get("TOR_SOCKS_HOST", "127.0.0.1"),
        tor_socks_port=int(os.environ.get("TOR_SOCKS_PORT", "9050")),
        jm_network=os.environ.get("JM_NETWORK", "mainnet"),
        poll_interval_seconds=int(os.environ.get("POLL_INTERVAL_SECONDS", "300")),
        probe_timeout_seconds=int(os.environ.get("PROBE_TIMEOUT_SECONDS", "90")),
        orderbook_collect_seconds=int(os.environ.get("ORDERBOOK_COLLECT_SECONDS", "30")),
        max_history_samples=int(os.environ.get("MAX_HISTORY_SAMPLES", "0")),
        history_retention_days=max(
            1,
            min(30, int(os.environ.get("HISTORY_RETENTION_DAYS", "30"))),
        ),
        data_dir=Path(os.environ.get("MONITOR_DATA_DIR", str(DEFAULT_DATA_DIR))),
        web_dir=Path(os.environ.get("MONITOR_WEB_DIR", str(DEFAULT_WEB_DIR))),
        publish_enabled=parse_bool(os.environ.get("PUBLISH_ENABLED")),
        publish_interval_seconds=int(os.environ.get("PUBLISH_INTERVAL_SECONDS", "300")),
        publish_remote_url=os.environ.get("PUBLISH_REMOTE_URL", ""),
        publication_branch=os.environ.get("PUBLICATION_BRANCH", "pages"),
        git_author_name=os.environ.get("GIT_AUTHOR_NAME", "directory-nodes-monitor"),
        git_author_email=os.environ.get(
            "GIT_AUTHOR_EMAIL",
            "directory-nodes-monitor@users.noreply.github.com",
        ),
        gh_preflight=parse_bool(os.environ.get("GH_PREFLIGHT"), default=True),
    )
