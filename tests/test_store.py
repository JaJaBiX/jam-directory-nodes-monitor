import json
from pathlib import Path
import tempfile
import unittest

from monitor.store import write_outputs


class StoreModuleTest(unittest.TestCase):
    def test_write_outputs_keeps_only_month_of_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            web_dir = Path(tmp_dir) / "web"
            data_dir = Path(tmp_dir) / "data"
            history_path = web_dir / "data" / "history.json"
            history_path.parent.mkdir(parents=True, exist_ok=True)
            history_path.write_text(
                json.dumps(
                    [
                        {
                            "checked_at": "2026-04-10T00:00:00+00:00",
                            "node": "old.onion:5222",
                            "ok": True,
                            "offers": 1,
                            "fidelity_bonds": 0,
                            "makers": 1,
                            "latency_ms": 100,
                        },
                        {
                            "checked_at": "2026-05-10T00:00:00+00:00",
                            "node": "recent.onion:5222",
                            "ok": True,
                            "offers": 2,
                            "fidelity_bonds": 1,
                            "makers": 2,
                            "latency_ms": 120,
                        },
                    ]
                ),
                encoding="utf-8",
            )
            latest = {
                "checked_at": "2026-05-24T12:00:00+00:00",
                "network": "mainnet",
                "tor_socks": "127.0.0.1:9050",
                "summary": {
                    "nodes_ok": 1,
                    "nodes_total": 2,
                    "offers_unique_total": 9,
                    "makers_unique_total": 5,
                },
                "orderbook": {"offers": [], "offers_total": 9, "makers_total": 5},
                "nodes": [
                    {
                        "node": "a.onion:5222",
                        "ok": True,
                        "offers": 3,
                        "fidelity_bonds": 1,
                        "makers": 2,
                        "latency_ms": 200,
                    },
                    {
                        "node": "b.onion:5222",
                        "ok": False,
                        "offers": 0,
                        "fidelity_bonds": 0,
                        "makers": 0,
                        "latency_ms": None,
                    },
                ],
            }

            write_outputs(
                web_dir=web_dir,
                data_dir=data_dir,
                latest=latest,
                max_history_samples=0,
                history_retention_days=30,
            )

            history = json.loads(history_path.read_text(encoding="utf-8"))
            checked_at_values = {item["checked_at"] for item in history}
            self.assertNotIn("2026-04-10T00:00:00+00:00", checked_at_values)
            self.assertIn("2026-05-10T00:00:00+00:00", checked_at_values)
            self.assertIn("2026-05-24T12:00:00+00:00", checked_at_values)

            latest_rows = [
                item for item in history if item["checked_at"] == "2026-05-24T12:00:00+00:00"
            ]
            self.assertEqual(len(latest_rows), 2)
            for row in latest_rows:
                self.assertEqual(row["offers_unique_total"], 9)
                self.assertEqual(row["makers_unique_total"], 5)
                self.assertEqual(row["nodes_ok"], 1)
                self.assertEqual(row["nodes_total"], 2)


if __name__ == "__main__":
    unittest.main()
