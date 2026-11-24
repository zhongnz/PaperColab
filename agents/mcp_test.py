"""Exercise actual SDK stdio JSON-RPC against a live loopback task API."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
from threading import Thread
from http.server import ThreadingHTTPServer
from server.service import Service
from server.http_app import Api
from server.__main__ import make_handler


def run():
    with tempfile.TemporaryDirectory() as tmp:
        service=Service(Path(tmp)/"trial.sqlite",demo=True)
        server=ThreadingHTTPServer(("127.0.0.1",0),make_handler(Api(service)))
        thread=Thread(target=server.serve_forever,daemon=True);thread.start()
        proc=None
        try:
            lead=service.actor_by_token("demo-ada")
            assistant=service.actor_by_token("demo-quill")
            project=service.projects(lead)[0]["id"]
            block=next(b for b in service.project(lead,project)["blocks"] if b["rich"] and "two readings" in b["quote"])
            note=service.add_object(lead,project,"note","Assigned evidence","Three readings.")
            task=service.create_agent_task(lead,project,block["stableId"],assistant["id"],"Use the note.",[note["id"]])
            env={**os.environ,"PAPERCOLAB_URL":"http://127.0.0.1:"+str(server.server_address[1]),
                 "PAPERCOLAB_TASK_ID":task["task"]["id"],"PAPERCOLAB_TASK_TOKEN":task["token"]}
            proc=subprocess.Popen([sys.executable,"-m","agents.mcp_server"],env=env,stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE,text=True,encoding="utf-8")
            lines=queue.Queue()
            def read():
                for line in proc.stdout:
                    lines.put(line)
                lines.put(None)
            Thread(target=read,daemon=True).start()
            def send(message):
                proc.stdin.write(json.dumps({"jsonrpc":"2.0",**message})+"\n");proc.stdin.flush()
            def call(i,method,params):
                send({"id":i,"method":method,"params":params})
                while True:
                    line=lines.get(timeout=20)
                    assert line is not None,"MCP server closed"
                    response=json.loads(line)
                    if response.get("id")==i:return response
            init=call(1,"initialize",{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fixture","version":"1"}})
            assert "result" in init,init
            send({"method":"notifications/initialized"})
            tools=call(2,"tools/list",{})["result"]["tools"]
            assert {t["name"] for t in tools}=={"read_assigned_context","submit_cell_proposal"}
            context=call(3,"tools/call",{"name":"read_assigned_context","arguments":{}})
            assert not context.get("error") and not context["result"].get("isError"),context
            payload=json.dumps(context)
            assert note["id"] in payload and task["token"] not in payload
            proposal={"after":block["quote"].replace("two readings","three readings"),"rationale":"Use note.","evidence_ids":[note["id"]]}
            result=call(4,"tools/call",{"name":"submit_cell_proposal","arguments":proposal})
            assert not result.get("error") and not result["result"].get("isError"),result
            replay=call(5,"tools/call",{"name":"submit_cell_proposal","arguments":proposal})
            assert replay.get("error") or replay.get("result",{}).get("isError"),replay
            with service.lock:
                state=service.project(lead,project)
                assert next(b for b in state["blocks"] if b["stableId"]==block["stableId"])["quote"]==block["quote"]
                suggestion=next(s for s in state["suggestions"] if s["actor_id"]==assistant["id"])
                assert suggestion["status"]=="pending"
                service.accept(lead,project,suggestion["id"])
                assert "three readings" in service._block_row(project,block["stableId"])["quote"]
        finally:
            if proc:
                proc.terminate()
                try:proc.wait(timeout=5)
                except subprocess.TimeoutExpired:proc.kill();proc.wait()
            server.shutdown();server.server_close();thread.join();service.close()
    print("Standard MCP stdio delegated-task test passed.")

if __name__=="__main__":
    run()
