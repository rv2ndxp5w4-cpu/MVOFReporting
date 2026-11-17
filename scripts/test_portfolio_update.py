import copy
import json
import tempfile
import unittest
from pathlib import Path

import openpyxl
from import_portfolio_update import import_update

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "MVOF Master with update Nov26.xlsx"


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.base = json.loads((ROOT / "data/valuation_snapshots/2025-12-31.json").read_text())
        self.research = json.loads((ROOT / "data/market_research_2026-11-17.json").read_text())

    def test_reconciles_preserves_history_and_is_repeatable(self):
        before = copy.deepcopy(self.base)
        output = import_update(self.base, WORKBOOK, self.research)
        self.assertEqual(self.base, before)
        self.assertEqual(len(output["assets"]), 28)
        self.assertAlmostEqual(sum(a["market_value_usd"] for a in output["assets"]), 39675446.18870169)
        self.assertAlmostEqual(sum(a["book_cost_usd"] for a in output["assets"]), 67483446.51137753)
        old = {a["id"]: a for a in before["assets"]}
        for a in output["assets"]:
            for key in ("id", "name", "company_snapshot_sheet2", "investment_date", "original_investment_usd", "value_2023_usd"):
                self.assertEqual(a.get(key), old[a["id"]].get(key), (a["name"], key))
            self.assertEqual(a["previous_market_value_usd"], old[a["id"]]["market_value_usd"])
            self.assertTrue(all(e in a["timeline"] for e in old[a["id"]]["timeline"]))
            self.assertEqual(len(a["valuation_history"]), 3)
            self.assertIn("assessment", a["nav_review"])
        again = import_update(output, WORKBOOK, self.research)
        self.assertEqual(output["assets"], again["assets"])

    def test_wrong_legal_identity_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            w = openpyxl.load_workbook(WORKBOOK, data_only=True)
            w.active["C11"] = "Unrelated Fund"
            path = Path(temp) / "wrong.xlsx"
            w.save(path)
            with self.assertRaisesRegex(ValueError, "legal name changed"):
                import_update(self.base, path, self.research)

    def test_changed_value_without_control_total_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            w = openpyxl.load_workbook(WORKBOOK, data_only=True)
            w.active["K11"] = 1
            path = Path(temp) / "wrong.xlsx"
            w.save(path)
            with self.assertRaisesRegex(ValueError, "totals do not reconcile"):
                import_update(self.base, path, self.research)


if __name__ == "__main__":
    unittest.main()
