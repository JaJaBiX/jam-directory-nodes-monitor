import unittest

from monitor.__main__ import build_aggregated_orderbook, strip_node_orderbook


class MainModuleTest(unittest.TestCase):
    def test_build_aggregated_orderbook_deduplicates_offers(self) -> None:
        results = [
            {
                "node": "a.onion:5222",
                "ok": True,
                "orderbook_offers": [
                    {
                        "counterparty": "J5makerA",
                        "oid": "0",
                        "ordertype": "sw0absoffer",
                        "minsize": "100000",
                        "maxsize": "5000000",
                        "txfee": "0",
                        "cjfee": "200",
                    },
                    {
                        "counterparty": "J5makerB",
                        "oid": "1",
                        "ordertype": "sw0reloffer",
                        "minsize": "200000",
                        "maxsize": "9000000",
                        "txfee": "0",
                        "cjfee": "0.00003",
                    },
                ],
            },
            {
                "node": "b.onion:5222",
                "ok": True,
                "orderbook_offers": [
                    {
                        "counterparty": "J5makerA",
                        "oid": "0",
                        "ordertype": "sw0absoffer",
                        "minsize": "100000",
                        "maxsize": "5000000",
                        "txfee": "0",
                        "cjfee": "200",
                    },
                    {
                        "counterparty": "J5makerC",
                        "oid": "3",
                        "ordertype": "sw0absoffer",
                        "minsize": "300000",
                        "maxsize": "7000000",
                        "txfee": "10",
                        "cjfee": "600",
                    },
                ],
            },
            {
                "node": "c.onion:5222",
                "ok": False,
                "orderbook_offers": [
                    {
                        "counterparty": "J5makerD",
                        "oid": "2",
                        "ordertype": "sw0absoffer",
                        "minsize": "100000",
                        "maxsize": "5000000",
                        "txfee": "0",
                        "cjfee": "100",
                    }
                ],
            },
        ]

        aggregated = build_aggregated_orderbook(results)

        self.assertEqual(aggregated["offers_total"], 3)
        self.assertEqual(aggregated["makers_total"], 3)
        self.assertEqual(
            [offer["counterparty"] for offer in aggregated["offers"]],
            ["J5makerA", "J5makerB", "J5makerC"],
        )

    def test_strip_node_orderbook(self) -> None:
        nodes = [
            {
                "node": "a.onion:5222",
                "ok": True,
                "offers": 10,
                "orderbook_offers": [{"counterparty": "J5maker"}],
            }
        ]

        stripped = strip_node_orderbook(nodes)

        self.assertEqual(stripped[0]["node"], "a.onion:5222")
        self.assertNotIn("orderbook_offers", stripped[0])


if __name__ == "__main__":
    unittest.main()
