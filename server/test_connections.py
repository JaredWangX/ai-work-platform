import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import connections
import workspace


class ConnectionsTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for item in [patch.object(workspace,"DATA",Path(self.tmp.name)),patch.object(connections,"crypt",return_value=AESGCM(bytes(range(32))))]:
            item.start();self.addCleanup(item.stop)
        workspace.initialize()
        self.a="a"*64
        self.b="b"*64

    def call(self, action, who=None, **fields):
        return workspace.service({"action":action,"workspace":who or self.a,**fields})

    def test_csv_read_scope_and_schedule(self):
        self.call("saveConnection",config={"kind":"database","engine":"CSV","id":"orders-qa","name":"明细","csv":"城市,金额,编号\n上海,65,001\n上海,20,002\n北京,14,003"})
        rows=self.call("query",source="orders-qa",sql='SELECT 城市, SUM(金额) AS 合计 FROM records GROUP BY 城市 ORDER BY 合计 DESC')
        self.assertEqual(rows["rows"],[["上海",85],["北京",14]])
        with self.assertRaises(ValueError):self.call("query",self.b,source="orders-qa",sql="SELECT * FROM records")
        with self.assertRaises(ValueError):self.call("query",source="orders-qa",sql="DELETE FROM records")
        self.assertNotIn("rows",self.call("connections")["items"][0])
        self.assertEqual(self.call("connections",self.b)["items"],[])
        job=dict(id="job",name="统计",description="总金额",frequency="每天",time="18:00",enabled=True,source="orders-qa")
        due=self.call("save",task=job)["next"]
        self.assertIn("owner",workspace.claim(due)[1])
        with self.assertRaises(ValueError):self.call("removeConnection",id="orders-qa")
        self.call("remove",id="job");self.call("removeConnection",id="orders-qa")
        self.assertEqual(self.call("connections")["items"],[])

    def test_model_secrets_and_edit(self):
        spec=dict(id="model-a",kind="model",name="私有",endpoint="https://model.example/v1",model="business",secret="fixture-secret")
        with patch.object(connections,"model_json",return_value={"choices":[{"message":{"content":"ok"}}]}) as provider:
            self.call("saveConnection",config=spec)
            self.call("saveConnection",config={**spec,"secret":""})
            self.assertEqual(provider.call_args.args[0]["secret"],"fixture-secret")
            self.call("saveConnection",config={**spec,"endpoint":"https://other.example/v1","secret":""})
            self.assertEqual(provider.call_args.args[0]["secret"],"")
        self.call("activateModel",id="model-a")
        self.assertEqual(self.call("activeModel")["model"],"business")
        self.assertNotIn("secret",self.call("activeModel"));self.assertEqual(self.call("activeModel",self.b),{})
        self.assertNotIn(b"fixture-secret",Path(workspace.DATA,"tasks.sqlite").read_bytes())
        with self.assertRaises(ValueError):self.call("activateModel",self.b,id="model-a")

    def test_network_and_sql_boundaries(self):
        with patch.dict("os.environ",{"WORKSPACE_PRIVATE_HOSTS":""}):
            with self.assertRaises(ValueError):connections.address("127.0.0.1",443)
        cfg={"engine":"PostgreSQL","table":"orders","schema":"public"}
        self.assertIn('"public"."orders"',connections.sql_for(cfg,"SELECT COUNT(*) FROM orders"))
        for query in ["SELECT * FROM members","DELETE FROM orders","SELECT secret_fn() FROM orders","SELECT * FROM orders; SELECT * FROM orders"]:
            with self.assertRaises(ValueError):connections.sql_for(cfg,query)
