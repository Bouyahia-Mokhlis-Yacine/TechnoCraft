"""Two-turn tool-call probe: prints the server's error body if the tool-result turn is rejected."""
import json, sys, requests
sys.argv = ["bench.py"]; sys.path.insert(0, "/home/jovyan/llm-bench")
import bench
U = "http://127.0.0.1:8000/v1/chat/completions"
body = lambda m: {"model": "gemma", "messages": m, "tools": bench.TOOLS, "temperature": 0, "max_tokens": 400, "chat_template_kwargs": {"reasoning_effort": "low"}}
msgs = [{"role": "system", "content": bench.SYSTEM}, {"role": "user", "content": "Why was MER-6434 flagged?"}]
r = requests.post(U, json=body(msgs)).json(); m = r["choices"][0]["message"]
print("turn1 tool_calls:", json.dumps(m.get("tool_calls"))[:300])
tc = m["tool_calls"][0]
msgs += [{"role": "assistant", "content": m.get("content") or "", "tool_calls": m["tool_calls"]},
         {"role": "tool", "tool_call_id": tc["id"], "content": json.dumps(bench.fixture("explain_merchant", {"merchant": "MER-6434"}))}]
r = requests.post(U, json=body(msgs)); print("turn2 status", r.status_code); print(r.text[:1500])
