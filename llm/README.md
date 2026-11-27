# Assistant model: serving and backend contract

The "Ask the Dashboard" assistant can use a local LLM to understand free-form questions in English,
French and Algerian Darija, and to phrase answers. The model is **Gemma 4 26B A4B (FP8)**. Why this
model was chosen: [`../llm-benchmark/REPORT.md`](../llm-benchmark/REPORT.md).

### Why this model (summary of the benchmark)

Same 56 questions (English, French, Darija in Latin and Arabic script), same prompt, measured from
the backend machine on 2026-11-27:

| Model | Where it runs | Correct tool | Prohibited terms | Typical / slowest answer |
|---|---|---|---|---|
| **Gemma 4 26B A4B (chosen)** | Our HPC slice | 94–96% | 0 | **0.8 s / 1.4 s** |
| DeepSeek V4 Pro | Hosted API (abroad) | 100% | 1 | 5.4–6.6 s / 19.6 s |
| DeepSeek V4.1 Flash | Hosted API (abroad) | 97–100% | 1, confirmed an allegation | 2.5–2.8 s / 5.1 s |
| Best other self-hosted (Gemma 31B, Qwen3.8 27B) | Our HPC slice | 96–100% | 1–3 | 1.5–2.8 s / up to 8 s |

DeepSeek V4 Pro is slightly more accurate, but it is 7–8× slower. It also needs internet, sends
engine data to a third party and is billed per token. The backend guards and output check
(section 3) cover the 26B's few misses. Full report: `../llm-benchmark/REPORT.md`, sections 4–7.

The model never sees the database and never computes a number. It picks one of 9 read-only query
functions, the backend runs it with the existing engine code, and the model rephrases the result.

## 1. Where it runs

| | |
|---|---|
| Host | ENSIA HPC notebook `main2`, one H100 NVL MIG slice (47 GB) |
| Server | vLLM 0.34, OpenAI-compatible API, bound to `127.0.0.1:8000` on the notebook only |
| Model name | `assistant` (alias `gemma`) |
| From the backend | SSH tunnel: `http://127.0.0.1:18000/v1` |
| Data | Stays on the HPC and the backend machine. No third-party API. |

## 2. Start it

```bash
# 1. On the notebook (Jupyter terminal or `ssh hpc`): start the model (~1.5 min to load)
~/llm-serve/assistantctl.sh start        # also: stop | restart | status | logs

# 2. On the machine that runs the backend: open the tunnel
./llm/tunnel.sh                          # -> model reachable at http://127.0.0.1:18000/v1
./llm/tunnel.sh --watch                  # or: keep it up, reopening it within 20 s when it drops

# 3. Check the whole loop (tools, languages, refusals, 8 concurrent users)
python3 llm/smoke_test.py
```

- `assistantctl.sh` restarts vLLM automatically if it crashes.
- It does **not** survive a notebook restart. After a restart:
  1. Start the HPC agent: `mkdir -p ~/.hpc-agent && nohup python3 ~/hpc_agent.py >~/.hpc-agent/agent.log 2>&1 &`
  2. Run step 1 again.
- The source of the script is [`hpc/assistantctl.sh`](hpc/assistantctl.sh). To install or update it, copy the file to `~/llm-serve/` on the notebook.

## 3. Backend contract

### Files

| File | Use |
|---|---|
| [`contract/system-prompt.txt`](contract/system-prompt.txt) | The system prompt, used as is. Replace `{{AS_OF}}` with the data date (e.g. `Friday 13 November 2026`) and `{{RUN_ID}}` with `snapshot.run.run_id`. |
| [`contract/tools.json`](contract/tools.json) | The 9 tool definitions, sent as `tools` in every request |

The prompt was validated in the benchmark. If you change it, rerun the benchmark (see `llm-benchmark/REPORT.md`, section 9).

The prompt names the prohibited terms on purpose, so it can forbid them. It is backend input and is never shown in the UI.

### Request

Use `POST {LLM_URL}/chat/completions`, the standard OpenAI format:

```json
{
  "model": "assistant",
  "messages": [{"role": "system", "content": "<system prompt>"}, {"role": "user", "content": "<question>"}],
  "tools": "<contents of tools.json>",
  "tool_choice": "auto",
  "temperature": 0,
  "max_tokens": 600
}
```

### Tool loop (at most 3 rounds)

1. Send the request.
2. If `message.tool_calls` is empty, `message.content` is the answer, and the loop ends.
3. Otherwise:
   - Append the assistant message, with its `content` and `tool_calls`.
   - For each call, run the tool and append `{"role": "tool", "tool_call_id": <id>, "content": JSON.stringify(result)}`.
   - Go back to step 1.

Do not send `reasoning_content` back; Gemma does not need it.

```ts
for (let round = 0; round < 3; round++) {
  const msg = (await chat(messages)).choices[0].message;
  if (!msg.tool_calls?.length) return msg.content;
  messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: msg.tool_calls });
  for (const tc of msg.tool_calls) {
    const result = runTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'));
    messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
  }
}
```

### Tools mapped to existing code

Each tool maps to an intent that `web/src/lib/assistant.ts` already answers.

The simplest executor calls `answer()` with the matching question below. It returns `{ text, table, scope, evidence, intent }`, and that object is the tool result. `llm-benchmark/raw/scripts/fixtures.ts` does exactly this. A cleaner version would call the intent functions directly with the arguments.

| Tool | Arguments | Equivalent `answer()` question |
|---|---|---|
| `network_summary` | period, channel, merchant (all optional) | `Network summary for <period> [on <channel>] [for <merchant>]` |
| `explain_merchant` | merchant | `Why was <merchant> flagged?` |
| `merchant_health` | merchant | `health of <merchant>` |
| `open_incidents` | merchant (optional) | `Show unresolved incidents and exposure [for <merchant>]` |
| `forecast` | merchant (optional) | `Forecast for the next 7 days [for <merchant>]` |
| `channel_activity` | period, channel (optional) | `Which channels show concurrent abnormal behaviour <period> [on <channel>]` |
| `top_declines` | period (optional) | `Which merchants have the most declines <period>` |
| `activity_shortfall` | period (optional) | `Which merchants had the largest activity shortfall <period>` |
| `next_checks` | merchant (optional) | `What should I check first [for <merchant>]` |

**Value mappings**

- **Periods:** `today`, `yesterday`, `this_week` (the default), `last_week`, and `last_30_days` (pass "this month" in the `answer()` question).
- **Channels:** `ecommerce`, `pos`, `mobile`, `nfc`, `transfer`.
- **Unknown merchant:** return `{"error": "MER-xxxx is not in this run."}`. The model then tells the user.

### Rules the backend must keep

These rules are what made the model safe in testing:

1. **Guards first.** Run the existing deterministic checks before calling the model: prohibited terms, card data, write actions. A refused question never reaches the model.
2. **Allowlist.** Run only the 9 tools above, read-only, and check that `merchant` matches `^MER-\d{4}$`.
3. **Output check.** Before showing the answer, apply two checks:
   - Reject it if it matches the `PROHIBITED` regex in `assistant.ts`.
   - Reject it if it contains a number that is not in the tool results or the question.

   If the answer fails either check, show the deterministic answer instead.
4. **Keep the evidence.** Show the `evidence` links and the `scope` line from the tool results under the model's text.
5. **Fallback.** If the model is unset, unreachable, too slow or rejected, the existing deterministic `answer()` replies, marked `fallback` (`model_off`, `model_offline`, `model_rejected`) and labelled in the chat. The platform works without the HPC.

### In the app

**Conversation history.** The request carries the last 6 questions and final answers of the conversation before the current question (`[system, user, assistant, …, user]`). Tool calls of earlier turns are not resent; prompt rule 9 tells the model to call a tool again for every number.

**Page context.** Questions from the assistant panel on other pages carry `page: { path, search }`. The app then adds a `page_context` tool (no arguments; returns the page's figures by panel name from `web/src/lib/page-context.ts`) and one system line naming the page and its panels. Checked with interpretation questions on the overview, merchant, alert, incident and data pages in English, French and Darija: all answered by the model from the page's figures.

**Composed reports.** With a signed-in account the app also offers `compose_report` (`web/src/lib/custom-report.ts`): a title and ordered sections chosen from 15 kinds, filled from the engine at render time. When a report is on screen or was made earlier in the conversation, its spec is put in the system prompt with an instruction to change it through `compose_report` + `report_id` (complete updated spec, everything else kept). Report requests get 6 rounds instead of 4, and `max_tokens` is 1500 so a spec fits. A report edit ("remove the incidents section") is not refused by the write guard; case actions (close, assign, acknowledge, escalate, reopen) still are.

**File requests.** `generate_report` also makes an Alerts brief (`type: alerts`, period / severity / merchant / channel), and `export_data` takes a transaction `status`. If a question asks for a file and the model replies without calling a file tool (it sometimes claims "linked below" after a long conversation), the app asks once more with `tool_choice` naming the tool, without resending the tool-less reply; vLLM's named function calling then forces the call. With conversation history, the system prompt adds one line: answer the latest message in its own language.

**Selections.** A question from the panel can carry up to 4 selected parts of the page (`selection`: kind, panel, text, chart tooltip, date, table row, links), validated by `web/src/lib/selection.ts`. They are appended to the user message under a `[The user selected these parts of the page…]` block, with one more system line telling the model to answer about them first (`day_detail` for a dated bar or row, the merchant / incident tools for an id). Their numbers count as known figures in the output check.

**App tools.** Besides the 9 tools in `tools.json`, the app adds 9 tools defined in `web/src/lib/assistant-tools.ts` (their `category` enum is filled from the current run): `day_detail`, `incident_detail`, `list_alerts`, `compare_merchants`, `simulate_disruption`, `collective_anomalies`, `engine_quality`, `generate_report` (PDF link), `export_data` (CSV link). Prompt rules 9–11 (history, links, simulations) were added for them. After the change, the 32 set-A questions through the app still gave 25 model answers, 6 guard refusals and 1 rules answer (median 0.93 s, max 2.2 s); rerun the benchmark itself before relying on new numbers.


Implemented in `web/src/lib/llm.ts` and used by `POST /api/v1/assistant`. The variables below go in `web/.env.local` (template: `web/.env.example`). Each reply carries `source: "model" | "rules"`. Checked on 2026-11-27 with the 32 set-A questions through the app: 25 answered by the model, 6 refused by the guards, 1 answered by the rules (a clarifying question replaced); median 0.92 s, max 1.23 s; no answer rejected.

### Environment variables

```bash
LLM_URL=http://127.0.0.1:18000/v1   # unset = deterministic assistant only
LLM_MODEL=assistant
LLM_TIMEOUT_MS=12000                 # whole question, all rounds
```

## 4. Performance

Measured through the tunnel by `smoke_test.py`, on 2026-11-27:

| | |
|---|---|
| One question, tool call included | 0.6–1.1 s |
| Refusal (no tool) | 0.3–0.6 s |
| 8 users at once | median 1.4 s, max 1.6 s |
| Concurrency limit | 8 sequences, 16k-token context each. The next request waits in a queue. |

## 5. Known limits

- **Clarifying questions.** It sometimes asks a clarifying question instead of calling a tool when a question is vague (e.g. "what should I check first?" in Darija).
- **Script of Darija refusals.**
  - An Arabic-script refusal can come back in Darija in Latin script.
  - The one remaining English refusal in the benchmark (closing an incident) is caught by the write guard before the model.
- **Availability.**
  - The model depends on the notebook and the tunnel. If either is down the assistant runs in fallback mode (built-in answers, clearly labelled), so check the tunnel before a demo.
  - The shared GPU slice can be taken by another tenant if the notebook is recreated. See `llm-benchmark/REPORT.md` for why that matters for speed.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `tunnel.sh`: ssh fails | The notebook is stopped, or its SSH bridge is down. Start the notebook, and run `ssh hpc true` once. |
| Tunnel open, but the model does not answer | On the notebook, run `~/llm-serve/assistantctl.sh status`, then `logs` |
| `status` says loading for more than 3 min | Check `logs` for CUDA out-of-memory errors: something else is using the GPU slice (`nvidia-smi`). |
| Slow answers (more than 2 s for a single user) | The MIG slice is shared with another tenant. See `nvidia-smi` for "Shared Memory-Usage". |
