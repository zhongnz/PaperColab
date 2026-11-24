import json
import os
import unittest
import uuid
from unittest.mock import patch
from agents.client import TaskClient, ClientError, loopback_origin, validate_proposal
from agents.providers import ModelProvider

ID=str(uuid.uuid4())
TOKEN="pc-task-"+"x"*43
CONTEXT={"task_id":ID,"instructions":"Revise description","cell":{"source":"Two readings.","id":"cell"},
         "context":[{"id":"note","body":"Three readings."}]}
PROPOSAL={"after":"Three readings.","rationale":"Use supplied note.","evidence_ids":["note"]}


class Agents(unittest.TestCase):
    def test_scope_and_validation(self):
        calls=[]
        def transport(url, headers, body):
            calls.append((url,headers,body))
            return CONTEXT if body is None else {"task_id":ID,"suggestion":{"id":"s","status":"pending"}}
        client=TaskClient("http://127.0.0.1:8787",ID,TOKEN,transport)
        with self.assertRaises(ClientError):
            client.submit({**PROPOSAL,"evidence_ids":["other"]})
        self.assertEqual(len(calls),1)
        self.assertEqual(client.submit(PROPOSAL)["suggestion"]["status"],"pending")
        self.assertTrue(all(url.startswith("http://127.0.0.1:8787/api/delegated/"+ID) for url,_,_ in calls))
        for bad in ("https://example.com:443","http://localhost:8787","http://127.0.0.1:8787/other",
                    "http://127.0.0.1:8787@evil.example","http://127.0.0.1:8787?x=1"):
            with self.assertRaises(ClientError):loopback_origin(bad)
        with self.assertRaises(ClientError):TaskClient("http://127.0.0.1:8787",ID,"demo-quill")
        for bad in ({**PROPOSAL,"extra":True},{**PROPOSAL,"after":"Two readings."},{**PROPOSAL,"evidence_ids":["note","note"]}):
            with self.assertRaises(ClientError):validate_proposal(bad,CONTEXT)

    def test_provider_consent_and_payloads(self):
        calls=[]
        def model(url,headers,body,timeout):
            calls.append((url,headers,body))
            if "anthropic" in url:
                return {"stop_reason":"end_turn","content":[{"type":"text","text":json.dumps(PROPOSAL)}]}
            return {"choices":[{"finish_reason":"stop","message":{"content":json.dumps(PROPOSAL)}}]}
        with patch.dict(os.environ,{"OPENAI_API_KEY":"test-openai","ANTHROPIC_API_KEY":"test-anthropic",
                                    "PAPERCOLAB_TASK_TOKEN":TOKEN,"PAPERCOLAB_LOCAL_MODEL_URL":"http://127.0.0.1:11434"}):
            for kind in ("openai","anthropic"):
                with self.assertRaises(ClientError):ModelProvider(kind,"fixture",False,model).generate(CONTEXT)
            self.assertEqual(calls,[])
            for kind in ("openai","anthropic","local"):
                self.assertEqual(ModelProvider(kind,"fixture",kind!="local",model).generate({**CONTEXT,"token":TOKEN}),PROPOSAL)
        self.assertEqual(len(calls),3)
        for url,headers,body in calls:
            self.assertNotIn(TOKEN,json.dumps([url,headers,body]))
            self.assertNotIn(ID,json.dumps(body))
        self.assertEqual(calls[2][1],{})

    def test_model_invalid_output(self):
        def bad(url,headers,body,timeout):
            return {"choices":[{"finish_reason":"stop","message":{"content":"not JSON"}}]}
        with self.assertRaises(ClientError):
            ModelProvider("local","fixture",False,bad).generate(CONTEXT)
