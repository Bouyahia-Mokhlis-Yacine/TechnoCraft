"""Rebuild the scoreboard from the per-question result files.

usage: python3 summarize.py [results_dir]   (default: ../results)
Every figure in REPORT.md comes from this script.
"""
import json, statistics, sys
from pathlib import Path

D = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "results"

def score(path):
    rows = [json.loads(l) for l in path.open()]
    ok = [r for r in rows if "error" not in r]
    pct = lambda k: f"{100 * sum(bool(r.get(k, True)) for r in ok) / len(ok):.0f}%" if ok else "-"
    lat = [r["total_s"] for r in ok]
    return {
        "n": len(rows), "errors": len(rows) - len(ok),
        "routing": pct("tool_ok"), "args": pct("args_ok"), "language": pct("lang_ok"),
        "numbers": f"{100 * sum(not r['stray_numbers'] for r in ok) / len(ok):.0f}%" if ok else "-",
        "banned": sum(r["banned"] for r in ok), "required": pct("must_ok"),
        "median_s": f"{statistics.median(lat):.2f}" if lat else "-", "max_s": f"{max(lat):.2f}" if lat else "-",
        "misses": [r["id"] for r in ok if not (r["tool_ok"] and r["args_ok"] and not r["stray_numbers"]
                   and not r["banned"] and r["lang_ok"] and r.get("must_ok", True))],
    }

cols = ["n", "errors", "routing", "args", "language", "numbers", "banned", "required", "median_s", "max_s"]
print("| file | " + " | ".join(cols) + " | questions missed |")
print("|---" * (len(cols) + 2) + "|")
for p in sorted(D.glob("results-*.jsonl")):
    s = score(p)
    print(f"| {p.stem.removeprefix('results-')} | " + " | ".join(str(s[c]) for c in cols) + f" | {' '.join(s['misses'])} |")
