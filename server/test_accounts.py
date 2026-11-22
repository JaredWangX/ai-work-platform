import base64
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import workspace as w
import connections


class TeamTest(unittest.TestCase):
    def setUp(self):
        root=tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        for ctx in [patch.object(w,"DATA",Path(root.name)),patch.object(connections,"crypt",return_value=AESGCM(bytes(range(32))))]:
            ctx.start();self.addCleanup(ctx.stop)
        w.initialize()
        self.guest="3"*64
        self.owner=self.call(self.guest,"register",login="qa-admin",password="new-password-qa")["session"]

    def call(self,token,action,**params):
        return w.service(dict(action=action,workspace=token,params=params))

    def test_team_scope_and_revocation(self):
        with self.assertRaises(ValueError):self.call(self.guest,"connections")
        code=self.call(self.owner,"invite",note="review")["code"]
        member=self.call("2"*64,"register",login="reviewer",password="review-pass-qa",invite=code)
        self.assertEqual(member["role"],"member")
        token=member["session"]
        self.assertEqual(self.call(self.owner,"members")["members"][1]["id"],member["person"]["id"])
        with self.assertRaises(ValueError):self.call(token,"invite",note="no")
        team=member["space"];mine=next(s["id"] for s in member["spaces"] if s["id"]!=team)
        switched=self.call(token,"switchTeam",space=mine)
        with self.assertRaises(ValueError):self.call(token,"members")
        back=self.call(switched["session"],"switchTeam",space=team)["session"]
        self.call(self.owner,"removeMember",id=member["person"]["id"])
        with self.assertRaises(ValueError):self.call(back,"syncIndex")

    def test_sync_conflicts_and_recovery(self):
        payload=b"Example 17"
        dig=hashlib.sha256(payload).hexdigest()
        self.call(self.owner,"syncPut",hash=dig,data=base64.b64encode(payload).decode())
        change={"key":"knowledge/one","parts":[dig],"base":[]}
        self.assertTrue(self.call(self.owner,"syncCommit",changes=[change])["ok"])
        self.assertTrue(self.call(self.owner,"syncCommit",changes=[change])["conflict"])
        other=self.call("4"*64,"register",login="other",password="another-pass-qa")["session"]
        self.assertEqual(self.call(other,"syncIndex")["records"],{})
        with self.assertRaises(ValueError):self.call(other,"syncGet",hash=dig)
        self.call(self.owner,"setPrefs",rev=0,preferences="我的偏好",enabled=True)
        self.assertIsNone(self.call(other,"getPrefs")["value"])
        code=self.call(self.owner,"issueRecovery",current="new-password-qa")["code"]
        self.call("5"*64,"recover",login="qa-admin",code=code,password="recovered-pass-qa")
        with self.assertRaises(ValueError):self.call(self.owner,"members")
        logged=self.call("5"*64,"login",login="qa-admin",password="recovered-pass-qa")
        self.assertEqual(self.call(logged["session"],"getPrefs")["value"]["preferences"],"我的偏好")
