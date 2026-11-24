"""Real Docker smoke checks using locally installed exact image IDs."""
import argparse
import subprocess
import uuid
from compute.contract import digest
from compute.runner import execute

def run(language,image):
    image_id=subprocess.check_output(["docker","image","inspect","--format","{{.Id}}",image],text=True).strip()
    source=("from pathlib import Path\nprint(sum(map(int, Path('/inputs/data-1.txt').read_text().split(','))))"
            if language=="python" else "cat(sum(scan('/inputs/data-1.txt',sep=',',quiet=TRUE)), '\\n')")
    spec={"format":"papercolab-experiment-v1","id":str(uuid.uuid4()),"language":language,"image":image_id,
          "code":{"id":"code","revision":1,"body":source},
          "datasets":[{"id":"dataset","revision":1,"body":"1,2,3"}]}
    receipt=execute({"spec":spec,"sha256":digest(spec)})
    assert receipt["status"]=="succeeded" and receipt["log"].strip()=="6",receipt
    table={"name":"results","kind":"table","title":"Results","columns":["n","sum"],"rows":[[3,6]]}
    series={"name":"trend","kind":"series","title":"Trend","x_label":"n","y_label":"sum","points":[[1,1],[2,3],[3,6]]}
    import json
    lines=["PAPERCOLAB_OUTPUT_V1 "+json.dumps(x,separators=(",",":")) for x in (table,series)]
    spec["code"]["body"]=("\n".join("print("+repr(line)+")" for line in lines) if language=="python"
                           else "\n".join("cat("+json.dumps(line)+", '\\n', sep='')" for line in lines))
    receipt=execute({"spec":spec,"sha256":digest(spec)})
    assert receipt["status"]=="succeeded" and receipt["outputs"]==[table,series],receipt
    if language=="python":
        spec["code"]["body"]="print('PAPERCOLAB_OUTPUT_V1 invalid')"
        receipt=execute({"spec":spec,"sha256":digest(spec)})
        assert receipt["status"]=="failed" and receipt["outputs"]==[],receipt
        spec["code"]["body"]="print('x'*300000)"
        receipt=execute({"spec":spec,"sha256":digest(spec)})
        assert receipt["status"]=="output-limit",receipt["status"]
        spec["code"]["body"]="import time; time.sleep(30)"
        receipt=execute({"spec":spec,"sha256":digest(spec)},timeout=2)
        assert receipt["status"]=="timeout",receipt["status"]
        spec["code"]["body"]="from pathlib import Path\nPath('/inputs/data-1.txt').write_text('modified')"
        receipt=execute({"spec":spec,"sha256":digest(spec)})
        assert receipt["status"]=="failed",receipt["status"]
    print(language,"isolated runner contract passed")

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("language",choices=["python","r"])
    parser.add_argument("image")
    args=parser.parse_args()
    run(args.language,args.image)
