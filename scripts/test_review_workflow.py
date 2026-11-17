import copy
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from review_support import decorate, save_review
from validate_publication import validate


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.base = json.loads((ROOT/'data/base_assets.json').read_text())
        self.asset = next(a for a in self.base['assets'] if a['name']=='Creoate')

    def test_review_cannot_change_nav_and_resolution_preserves_risk(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            before = copy.deepcopy(self.base)
            with self.assertRaises(ValueError):
                save_review(path, self.asset['id'], {'state':'open','market_value_usd':0}, self.base)
            with self.assertRaises(ValueError):
                save_review(path, self.asset['id'], {'state':'resolved','resolution':''}, self.base)
            save_review(path, self.asset['id'], {'state':'resolved','resolution':'Reviewed; recovery evidence still outstanding','owner':'Reviewer'}, self.base)
            self.assertEqual(self.base,before)
            decorate(self.base,path,dt.date(2026,11,17))
            self.assertEqual(self.asset['nav_risk']['level'],'urgent')
            self.assertEqual(self.asset['review_workflow']['state'],'resolved')
            self.assertEqual(self.asset['market_value_usd'],1299263.75)
            self.assertFalse(self.asset['performance_bridge']['complete'])
            self.assertIsNone(self.asset['performance_bridge']['contributions_usd'])

    def test_bridge_accounts_for_flows_but_not_as_return(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)
            entry={'from_date':'2025-12-31','to_date':'2026-06-30','source':'Test statement',
                'contributions_usd':100,'distributions_usd':50,'fx_usd':-10,'fees_usd':5}
            (path/'performance_inputs.json').write_text(json.dumps({'assets':{self.asset['id']:entry}}))
            decorate(self.base,path,dt.date(2026,11,17))
            self.assertAlmostEqual(self.asset['performance_bridge']['unexplained_change_usd'],self.asset['change_since_previous_usd']-35)
            entry['to_date']='2026-03-31'
            (path/'performance_inputs.json').write_text(json.dumps({'assets':{self.asset['id']:entry}}))
            decorate(self.base,path,dt.date(2026,11,17))
            self.assertFalse(self.asset['performance_bridge']['complete'])

    def test_freshness_does_not_use_access_date(self):
        with tempfile.TemporaryDirectory() as temp:
            self.asset['nav_review']['sources']=[{'url':'https://example.com','event_date':'2024-01-01','accessed_at':'2026-11-17'}, {'url':'https://example.com/undated','event_date':None,'accessed_at':'2026-11-17'}]
            decorate(self.base,Path(temp),dt.date(2026,11,17))
            sources=self.asset['nav_review']['sources']
            self.assertEqual(sources[0]['freshness'],'Older than 180 days')
            self.assertEqual(sources[1]['freshness'],'Undated; freshness unknown')

    def test_publication_rejects_modified_dataset(self):
        self.assertEqual(validate(ROOT/'data/base_assets.json',ROOT/'data/import_preview.json')['holdings'],28)
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'base.json'
            self.asset['market_value_usd']=0
            p.write_text(json.dumps(self.base))
            with self.assertRaisesRegex(ValueError,'differs from reviewed import'):
                validate(p, ROOT/'data/import_preview.json')

    def test_preview_does_not_replace_dataset(self):
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)/'untouched.json'
            output.write_text('sentinel')
            preview=Path(temp)/'preview.json'
            command=[sys.executable,str(ROOT/'scripts/import_portfolio_update.py'),
                '--workbook',str(ROOT/'MVOF Master with update Nov26.xlsx'),
                '--base',str(ROOT/'data/valuation_snapshots/2025-12-31.json'),
                '--research',str(ROOT/'data/market_research_2026-11-17.json'),
                '--output',str(output),'--preview-report',str(preview)]
            subprocess.run(command,check=True,capture_output=True)
            self.assertEqual(output.read_text(),'sentinel')
            report=json.loads(preview.read_text())
            self.assertFalse(report['applied'])
            self.assertEqual(report['matched_count'],28)


if __name__=='__main__':
    unittest.main()
