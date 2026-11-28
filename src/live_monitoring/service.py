"""Loopback-only replay controller with durable per-account checkpoints."""

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
from threading import Event, RLock, Thread
from time import monotonic
from urllib.parse import parse_qs, urlsplit

import pandas as pd

from .archive import Archive, CONFIG, MINUTES, PRESETS, ROOT, SLOTS
from .evaluation import locked_thresholds
from .replay import Replay

SPEEDS = (1, 10, 60, 600, 3600)
ACCOUNT = re.compile(r"[a-zA-Z0-9_.-]{1,80}")


class Controller:
    def __init__(self, path, archive, thresholds):
        self.archive, self.thresholds = archive, thresholds
        self.lock = RLock()
        self.sessions = {}
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS replay (account TEXT PRIMARY KEY, state TEXT NOT NULL)")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.signature = json.dumps([archive.fingerprint, thresholds], sort_keys=True)
        self.halt = Event()

    def save(self, account, state):
        data = {**state["parameters"], "status": state["status"], "cursor": state["replay"].tick_count,
                "speed": state["speed"], "signature": self.signature}
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO replay VALUES (?, ?)", (account, json.dumps(data)))

    def load(self, account):
        if account in self.sessions:
            return self.sessions[account]
        row = self.db.execute("SELECT state FROM replay WHERE account = ?", (account,)).fetchone()
        if row is None:
            return None
        data = json.loads(row[0])
        if data["signature"] != self.signature:
            return None
        state = self.create(data)
        rewind = data["cursor"]
        for _ in range(rewind):
            state["replay"].advance()
        state["status"] = "paused" if data["status"] == "running" else data["status"]
        self.register(account, state)
        return state

    def register(self, account, state):
        if account not in self.sessions and len(self.sessions) >= 8:
            removable = next((k for k, v in self.sessions.items() if v["status"] != "running"), None)
            if removable is None:
                raise ValueError("Eight replays are already running. Try again after one finishes.")
            del self.sessions[removable]
        self.sessions[account] = state

    def create(self, data):
        start, end, preset = (data.get(k) for k in ("start", "end", "preset"))
        if any(not isinstance(d, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in (start, end)):
            raise ValueError("Choose valid start and end dates.")
        if (pd.Timestamp(end) - pd.Timestamp(start)).days not in range(7):
            raise ValueError("Choose up to seven consecutive days.")
        speed = self.speed(data.get("speed"))
        tape = self.archive.tape(start, end, preset)
        return {"parameters": {"start": start, "end": end, "preset": preset}, "speed": speed, "status": "running",
                "replay": Replay(self.archive, tape, self.thresholds), "credit": 0., "wall": monotonic()}

    @staticmethod
    def speed(value):
        if type(value) is not int or value not in SPEEDS:
            raise ValueError("Choose a supported playback speed.")
        return value

    def command(self, account, data):
        with self.lock:
            action = data.get("action")
            state = self.load(account)
            if action == "reset":
                with self.db:
                    self.db.execute("DELETE FROM replay WHERE account = ?", (account,))
                self.sessions.pop(account, None)
                return
            if action == "start":
                if state and state["status"] in ("running", "paused"):
                    raise ValueError("Stop or reset your current replay before starting another.")
                state = self.create(data)
                self.register(account, state)
            elif not state:
                raise ValueError("Start a replay first.")
            elif action == "pause" and state["status"] == "running":
                self.update_clock(account, state)
                if state["status"] == "running":
                    state["status"] = "paused"
            elif action == "resume" and state["status"] == "paused":
                state.update(status="running", wall=monotonic())
            elif action == "stop":
                state.update(status="stopped", credit=0.)
            elif action == "step" and state["status"] == "paused":
                self.advance(state)
            elif action == "speed":
                speed = self.speed(data.get("speed"))
                if state["status"] == "running":
                    self.update_clock(account, state)
                state["speed"] = speed
            else:
                raise ValueError("This control is unavailable in the current state.")
            self.save(account, state)

    @staticmethod
    def advance(state):
        replay = state["replay"]
        replay.advance()
        if replay.tick_count == replay.tape.size:
            state.update(status="finished", credit=0.)

    def update_clock(self, account, state):
        now = monotonic()
        state["credit"] += (now - state["wall"]) * state["speed"]
        state["wall"] = now
        base = MINUTES * 60
        ticks = min(int(state["credit"] // base), 12)
        for _ in range(ticks):
            if state["status"] != "running":
                break
            state["credit"] -= base
            self.advance(state)
        if ticks:
            self.save(account, state)

    def schedule(self):
        while not self.halt.wait(.15):
            with self.lock:
                for account, state in self.sessions.items():
                    if state["status"] == "running":
                        try:
                            self.update_clock(account, state)
                        except Exception:
                            logging.exception("Live replay failed while finalizing an interval.")
                            state["status"] = "failed"
                            self.save(account, state)

    def snapshot(self, account, scope=None, limit=SLOTS):
        with self.lock:
            state = self.load(account)
            common = {"presets": PRESETS, "speeds": SPEEDS,
                      "min_date": CONFIG["calibration_start"], "max_date": CONFIG["archive_end"],
                      "default_date": CONFIG["evaluation_start"], "mode": "Simulated Live Monitoring — Historical Replay"}
            if state is None:
                return {**common, "status": "idle"}
            replay = state["replay"]
            if scope not in replay.ref.index or scope[0] == "merchant-channel":
                scope = ("network", "all")
            return {**common, "status": state["status"], "speed": state["speed"], **state["parameters"],
                    **replay.snapshot(scope, limit)}


def handler(controller, secret):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format, *args):
            pass

        def reply(self, code, body):
            value = json.dumps(body, allow_nan=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(value)))
            self.end_headers()
            self.wfile.write(value)

        def serve(self, write=False):
            token = self.headers.get("Authorization", "")
            account = self.headers.get("X-Replay-Account", "")
            if not hmac.compare_digest(token.encode(), secret) or not ACCOUNT.fullmatch(account):
                self.reply(403, {"error": "Forbidden"})
                return
            url = urlsplit(self.path)
            if url.path != "/replay":
                self.reply(404, {"error": "Not found"})
                return
            try:
                if write:
                    size = int(self.headers.get("Content-Length", "0"))
                    if not 1 <= size <= 4096:
                        raise ValueError("Invalid request size.")
                    body = json.loads(self.rfile.read(size))
                    if not isinstance(body, dict):
                        raise ValueError("Expected an object.")
                    controller.command(account, body)
                query = parse_qs(url.query)
                scope = (query.get("kind", ["network"])[0], query.get("name", ["all"])[0])
                limit = max(1, min(SLOTS, int(query.get("limit", [SLOTS])[0])))
                self.reply(200, controller.snapshot(account, scope, limit))
            except (ValueError, TypeError, OverflowError) as error:
                self.reply(400, {"error": str(error)})
            except (BrokenPipeError, ConnectionResetError):
                return
            except Exception:
                logging.exception("Live monitoring request failed.")
                self.reply(500, {"error": "Live monitoring failed. See the local service log."})

        def do_GET(self):
            self.serve()

        def do_POST(self):
            self.serve(write=True)

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--state", type=Path, default=ROOT / "runs/live-monitoring/replay.sqlite3")
    args = parser.parse_args()
    secret = os.environ.get("LIVE_MONITORING_TOKEN", "")
    if len(secret) < 24:
        parser.error("Set LIVE_MONITORING_TOKEN to a shared random token of at least 24 characters.")
    args.state.parent.mkdir(parents=True, exist_ok=True)
    archive = Archive()
    _ = archive.reference
    controller = Controller(args.state, archive, locked_thresholds(archive))
    with ThreadingHTTPServer(("127.0.0.1", args.port),
                             handler(controller, ("Bearer " + secret).encode())) as server:
        thread = Thread(target=controller.schedule, daemon=True)
        thread.start()
        print(f"Training replay service ready on 127.0.0.1:{args.port}", flush=True)
        try:
            server.serve_forever()
        finally:
            controller.halt.set()
            thread.join()
            controller.db.close()


if __name__ == "__main__":
    main()
