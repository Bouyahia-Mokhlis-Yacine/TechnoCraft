#!/bin/bash
# Final config check for Gemma 4 26B A4B: both question sets with the refusal-language rule added.
cd ~/llm-bench
until curl -sf localhost:8000/v1/models >/dev/null; do sleep 10; done
export SYSTEM_EXTRA=$'\n8. Refusals and short replies follow rule 6 too: a Darija question gets a Darija answer and an Arabic-script question an Arabic-script answer, never English. Never repeat the prohibited words, not even to say you avoid them.'
~/venv/bin/python -u bench.py http://127.0.0.1:8000 gemma results-final26b-a.jsonl > bench-final26b-a.log 2>&1; sed -n '/^== /,$p' bench-final26b-a.log
QUESTIONS=questions_b.json ~/venv/bin/python -u bench.py http://127.0.0.1:8000 gemma results-final26b-b.jsonl > bench-final26b-b.log 2>&1; sed -n '/^== /,$p' bench-final26b-b.log
