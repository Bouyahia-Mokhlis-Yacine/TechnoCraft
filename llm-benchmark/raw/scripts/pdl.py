"""Parallel HTTP range downloader for a HF repo -> ~/models/<name>. usage: pdl.py <repo> [conns] [skip_prefix,...]"""
import os, sys, json, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
repo = sys.argv[1]; conns = int(sys.argv[2]) if len(sys.argv) > 2 else 16
dest = os.path.expanduser(f"~/models/{repo.split('/')[1]}"); os.makedirs(dest, exist_ok=True)
info = json.load(urllib.request.urlopen(f"https://huggingface.co/api/models/{repo}?blobs=true"))
skip = tuple(x for x in (sys.argv[3].split(",") if len(sys.argv) > 3 else []) if x)
files = [(s["rfilename"], s.get("size") or 0) for s in info["siblings"] if not (skip and s["rfilename"].startswith(skip))]
CH = 64 << 20
def get(url, path, start, end, tries=8):
    for t in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
            with urllib.request.urlopen(req, timeout=60) as r, open(path, "r+b") as f:
                f.seek(start); pos = start
                while chunk := r.read(1 << 20):
                    f.write(chunk); pos += len(chunk)
            if pos == end + 1: return
            start = pos
        except Exception as e:
            time.sleep(2 + t)
    raise RuntimeError(f"failed {path} {start}-{end}")
t0 = time.time(); total = sum(s for _, s in files)
for name, size in sorted(files, key=lambda x: x[1]):
    path = os.path.join(dest, name); os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path) and os.path.getsize(path) == size and not os.path.exists(path + ".part"): continue
    url = f"https://huggingface.co/{repo}/resolve/main/{name}"
    if size < CH:
        urllib.request.urlretrieve(url, path); continue
    # resumable: .part lists the chunk offsets already written
    done = set()
    if os.path.exists(path + ".part") and os.path.exists(path) and os.path.getsize(path) == size:
        done = {int(x) for x in open(path + ".part").read().split()}
    else:
        open(path + ".part", "w").close()
        with open(path, "wb") as f: f.truncate(size)
    lock = threading.Lock()
    def chunk(s):
        get(url, path, s, min(s + CH, size) - 1)
        with lock, open(path + ".part", "a") as f: f.write(f"{s}\n")
    with ThreadPoolExecutor(conns) as ex:
        list(ex.map(chunk, [s for s in range(0, size, CH) if s not in done]))
    os.remove(path + ".part")
    print(f"{time.strftime('%T')} {name} {size/1e9:.1f} GB ({time.time()-t0:.0f}s)", flush=True)
print(f"done {repo}: {total/1e9:.1f} GB in {time.time()-t0:.0f}s -> {dest}", flush=True)
