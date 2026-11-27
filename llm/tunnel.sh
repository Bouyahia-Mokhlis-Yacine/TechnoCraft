#!/bin/bash
# Opens (or checks) the SSH tunnel from this machine to the model on the HPC notebook.
# After it succeeds the backend uses LLM_URL=http://127.0.0.1:18000/v1
# Needs the "hpc" host in ~/.ssh/config (set up by the hpc-mcp ssh setup).
LOCAL=${LLM_LOCAL_PORT:-18000}
if ! curl -sf "http://127.0.0.1:$LOCAL/v1/models" >/dev/null; then
  pkill -f "ssh -f -N -L $LOCAL:127.0.0.1:8000 hpc" 2>/dev/null
  ssh -f -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L "$LOCAL:127.0.0.1:8000" hpc || { echo "ssh tunnel failed (is the notebook running?)"; exit 1; }
  sleep 1
fi
if curl -sf "http://127.0.0.1:$LOCAL/v1/models" >/dev/null; then
  echo "model reachable at http://127.0.0.1:$LOCAL/v1"
else
  echo "tunnel is open but the model does not answer: run ~/llm-serve/assistantctl.sh status on the notebook"; exit 1
fi
