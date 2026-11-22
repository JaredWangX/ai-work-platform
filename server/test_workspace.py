import tempfile
import unittest
from datetime import datetime
from pathlib import Path
import workspace as w


class WorkspaceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        original = w.DATA
        self.addCleanup(setattr, w, "DATA", original)
        w.DATA = Path(self.tmp.name)
        w.initialize()

    def test_queries_use_real_rows_and_are_read_only(self):
        self.assertEqual(w.query("sales","SELECT COUNT(*),SUM(amount-refund) FROM orders")["rows"],[(63,32946)])
        self.assertTrue(w.query("sales","SELECT * FROM orders")["truncated"])
        with self.assertRaises(ValueError):w.query("sales","DELETE FROM orders")

    def test_workdays_advance_over_the_weekend(self):
        friday = datetime(2026,11,20,8,0,tzinfo=w.BJ)
        result=w.next_slot({"frequency":"每个工作日","time":"08:00"},friday.timestamp())
        self.assertEqual(datetime.fromtimestamp(result,w.BJ),datetime(2026,11,23,8,0,tzinfo=w.BJ))

    def test_claim_is_unique_and_workspace_private(self):
        request={"workspace":"a"*64,"action":"save","task":{"id":"qa","name":"QA","description":"周报","enabled":True,"frequency":"每天","time":"09:21"}}
        due=w.service(request)["next"]
        self.assertIsNotNone(w.claim(due))
        self.assertIsNone(w.claim(due))
        self.assertEqual(w.service({"action":"list","workspace":"b"*64})["jobs"],[])
        self.assertEqual(len(w.service({"action":"list","workspace":"a"*64})["jobs"][0]["runs"]),1)
