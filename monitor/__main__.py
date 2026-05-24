from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import sys
import time

from .config import Settings, load_settings
from .probe import probe_directory_node
from .publish import publish
from .store import write_outputs


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def build_summary(results: list[dict], orderbook: dict) -> dict:
    ok_results = [item for item in results if item["ok"]]
    max_offer_node = max(ok_results, key=lambda item: int(item["offers"]), default=None)
    offers_reported_total = sum(int(item["offers"]) for item in results)
    makers_reported_total = sum(int(item["makers"]) for item in results)
    offers_unique_total = int(orderbook.get("offers_total", 0))
    makers_unique_total = int(orderbook.get("makers_total", 0))
    return {
        "nodes_total": len(results),
        "nodes_ok": len(ok_results),
        "nodes_failed": len(results) - len(ok_results),
        # Canonical public metric: unique offers deduplicated across DN responses.
        "offers_total": offers_unique_total,
        "offers_unique_total": offers_unique_total,
        # Reported sum before deduplication is kept for diagnostics.
        "offers_reported_total": offers_reported_total,
        "max_node_offers": int(max_offer_node["offers"]) if max_offer_node else 0,
        "max_node": max_offer_node["node"] if max_offer_node else None,
        "fidelity_bonds_total": sum(int(item["fidelity_bonds"]) for item in results),
        "makers_total": makers_unique_total,
        "makers_unique_total": makers_unique_total,
        "makers_reported_total": makers_reported_total,
    }


def build_aggregated_orderbook(results: list[dict]) -> dict:
    deduped: dict[tuple[str, str, str], dict] = {}
    for node in results:
        if not node.get("ok"):
            continue
        for offer in node.get("orderbook_offers", []):
            counterparty = str(offer.get("counterparty", "")).strip()
            oid = str(offer.get("oid", "")).strip()
            ordertype = str(offer.get("ordertype", "")).strip()
            if not counterparty or not oid or not ordertype:
                continue
            key = (counterparty, oid, ordertype)
            if key in deduped:
                continue
            deduped[key] = {
                "counterparty": counterparty,
                "oid": oid,
                "ordertype": ordertype,
                "minsize": offer.get("minsize"),
                "maxsize": offer.get("maxsize"),
                "txfee": offer.get("txfee"),
                "cjfee": offer.get("cjfee"),
            }

    offers = sorted(
        deduped.values(),
        key=lambda item: (
            item["counterparty"],
            item["oid"],
            item["ordertype"],
        ),
    )
    makers = {offer["counterparty"] for offer in offers}
    return {
        "offers": offers,
        "offers_total": len(offers),
        "makers_total": len(makers),
    }


def strip_node_orderbook(results: list[dict]) -> list[dict]:
    return [{k: v for k, v in node.items() if k != "orderbook_offers"} for node in results]


def run_probe(settings: Settings) -> dict:
    checked_at = utc_now()
    results: list[dict] = []
    with ThreadPoolExecutor(max_workers=min(len(settings.nodes), 8)) as executor:
        futures = {
            executor.submit(
                probe_directory_node,
                node,
                settings.tor_socks_host,
                settings.tor_socks_port,
                settings.jm_network,
                settings.probe_timeout_seconds,
                settings.orderbook_collect_seconds,
            ): node
            for node in settings.nodes
        }
        for future in as_completed(futures):
            results.append(future.result())
    results.sort(key=lambda item: item["node"])
    orderbook = build_aggregated_orderbook(results)
    summary = build_summary(results, orderbook)
    latest = {
        "checked_at": checked_at,
        "network": settings.jm_network,
        "tor_socks": f"{settings.tor_socks_host}:{settings.tor_socks_port}",
        "summary": summary,
        "orderbook": orderbook,
        "nodes": strip_node_orderbook(results),
    }
    write_outputs(
        settings.web_dir,
        settings.data_dir,
        latest,
        settings.max_history_samples,
        settings.history_retention_days,
    )
    return latest


def command_run_once(args: argparse.Namespace) -> int:
    settings = load_settings(args.nodes_file)
    latest = run_probe(settings)
    print(f"checked_at={latest['checked_at']}")
    print(
        "nodes_ok={nodes_ok}/{nodes_total} offers_total={offers_total} "
        "offers_reported_total={offers_reported_total} "
        "fidelity_bonds_total={fidelity_bonds_total}".format(**latest["summary"])
    )
    if args.publish or settings.publish_enabled:
        publish(settings)
    return 0


def command_daemon(args: argparse.Namespace) -> int:
    settings = load_settings(args.nodes_file)
    last_publish = 0.0
    while True:
        started = time.time()
        try:
            latest = run_probe(settings)
            print(
                (
                    "{checked_at} nodes_ok={nodes_ok}/{nodes_total} "
                    "offers={offers_total} offers_reported={offers_reported_total}"
                ).format(
                    checked_at=latest["checked_at"],
                    **latest["summary"],
                ),
                flush=True,
            )
            if settings.publish_enabled and (
                time.time() - last_publish >= settings.publish_interval_seconds
            ):
                publish(settings)
                last_publish = time.time()
        except Exception as exc:
            print(f"monitor run failed: {exc}", file=sys.stderr, flush=True)
        elapsed = time.time() - started
        time.sleep(max(1, settings.poll_interval_seconds - elapsed))


def command_publish(args: argparse.Namespace) -> int:
    settings = load_settings(args.nodes_file)
    publish(settings)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    run_once = subparsers.add_parser("run-once")
    run_once.add_argument("--nodes-file", default=None)
    run_once.add_argument("--publish", action="store_true")
    run_once.set_defaults(func=command_run_once)

    daemon = subparsers.add_parser("daemon")
    daemon.add_argument("--nodes-file", default=None)
    daemon.set_defaults(func=command_daemon)

    publish_cmd = subparsers.add_parser("publish")
    publish_cmd.add_argument("--nodes-file", default=None)
    publish_cmd.set_defaults(func=command_publish)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
