"""Run with python3 from any directory. Uses an isolated Compose project and volumes."""

import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
CANARY = "private-message-and-token-canary"
PROJECT = "space-log-test-" + uuid4().hex[:10]


def main():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {**os.environ, "SPACE_LOG_PORT": str(port)}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml") as override:
        # Exercise the production driver on disposable containers without building the apps.
        override.write('services:\n  loki:\n    ports: ["127.0.0.1::3100"]\n')
        for service in ("server", "events", "worker"):
            override.write(f"  {service}:\n    build: !reset null\n    image: node:22-alpine\n    stop_grace_period: 1s\n    command: [sleep, '600']\n    ports: !reset []\n")
        override.flush()
        compose = ["docker", "compose", "--env-file", os.devnull, "-p", PROJECT,
                   "-f", "compose.yaml", "-f", "compose.monitoring.yaml", "-f", override.name]

        def run(*args):
            return subprocess.check_output([*compose, *args], cwd=ROOT, env=env, text=True)

        try:
            run("up", "-d", "--no-deps", "loki", "log-collector")
            endpoint = "http://" + run("port", "loki", "3100").strip()
            startup_deadline = time.monotonic() + 60
            while True:
                try:
                    with urlopen(f"{endpoint}/ready", timeout=2) as response:
                        if response.status == 200:
                            break
                except (URLError, TimeoutError, ConnectionError):
                    pass
                if time.monotonic() >= startup_deadline:
                    raise TimeoutError("Loki did not become ready")
                time.sleep(1)
            access = {"msg": "http_request_completed", "httpMethod": "POST", "statusCode": 503, "durationMs": 42}
            malformed = [{"httpMethod": CANARY}, {"httpMethod": ["POST"]}, {"statusCode": 600},
                         {"statusCode": "503"}, {"durationMs": 3.5}, {"durationMs": -1}, {"durationMs": CANARY}]
            trace_id = str(uuid4())
            trace = {"msg": "agent_turn_phase", "traceId": trace_id, "phase": "execution", "status": "started"}
            tool_id = uuid4().hex
            tool = {**trace, "phase": "tool", "status": "completed", "toolId": tool_id}
            invalid_traces = [{"traceId": CANARY}, {"traceId": trace_id + CANARY}, {"traceId": None},
                              {"phase": CANARY}, {"status": CANARY}, {"phase": ["execution"]}, {"status": "allowed"}]
            inputs = {
                "server": [json.dumps({"msg": "api_request_failed", "req": {"url": "/?q=" + CANARY},
                                       "requestId": CANARY, "authorization": CANARY}),
                           json.dumps({**access, "user": CANARY, "route": CANARY, "reqId": CANARY}),
                           *(json.dumps({**access, **fields}) for fields in malformed),
                           json.dumps({**trace, "prompt": CANARY, "args": CANARY}),
                           *(json.dumps({**trace, **fields}) for fields in invalid_traces),
                           json.dumps({"msg": "metrics_listener_unavailable"}), json.dumps({"msg": CANARY}), "{invalid-json-" + CANARY],
                "events": ["CDC interrupted; retained WAL will replay Error: " + CANARY, CANARY, json.dumps(trace)],
                "worker": ["Worker ready", "worker_operation_failed " + CANARY,
                           json.dumps({**tool, "tool": CANARY, "result": CANARY}),
                           json.dumps({**tool, "toolId": CANARY}), json.dumps(access)],
            }

            def emit(service, *lines):
                run("exec", "-T", service, "sh", "-c", 'printf "%s\\n" "$@" > /proc/1/fd/1', "sh", *lines)

            def await_events(expected):
                query = urlencode({"query": '{service_name=~".+"}'})
                deadline = time.monotonic() + 45
                while True:
                    try:
                        with urlopen(f"{endpoint}/loki/api/v1/query_range?{query}", timeout=3) as response:
                            streams = json.load(response)["data"]["result"]
                        assert all(value not in json.dumps(s["stream"]) for s in streams for value in (trace_id,tool_id)), "Trace ID became a label"
                        assert CANARY not in json.dumps(streams), "Private data reached Loki"
                        actual = {(s["stream"]["service_name"], value[1]) for s in streams for value in s["values"]}
                        assert actual <= expected, f"Unexpected log events: {actual - expected}"
                        if actual == expected:
                            return
                    except (URLError, TimeoutError, ConnectionError):
                        pass
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Expected operational events did not reach Loki")
                    time.sleep(1)

            run("up", "-d", "--no-deps", *inputs)
            for service, lines in inputs.items():
                emit(service, *lines)
            # A well-formed Forward record with a nil body and a private attribute, then an invalid frame.
            header = b"\x93\xacspace-server\xce" + int(time.time()).to_bytes(4, "big")
            canary = CANARY.encode()
            with socket.create_connection(("127.0.0.1", port), timeout=3) as conn:
                conn.sendall(header + b"\x82\xa3log\xc0\xa5token\xd9" + bytes([len(canary)]) + canary)
                conn.sendall(b"\xc1" + canary)
            expected = {("space-server", "api_request_failed"), ("space-events", "cdc_interrupted"),
                        ("space-worker", "worker_ready"), ("space-server", "metrics_listener_unavailable"),
                        ("space-server", json.dumps(access, separators=(",", ":"))),
                        ("space-worker", json.dumps(tool, separators=(",", ":"))),
                        ("space-server", json.dumps(trace, separators=(",", ":")))}
            await_events(expected)

            # A persistent source and one restarted offline must both deliver again after recovery.
            run("stop", "log-collector")
            run("restart", "events")
            emit("server", CANARY)
            emit("events", CANARY)
            run("start", "log-collector")
            with socket.create_connection(("127.0.0.1", port), timeout=5):
                pass
            emit("server", json.dumps({"msg": "shutdown_failed"}))
            emit("events", "CDC ready")
            await_events(expected | {("space-server", "shutdown_failed"), ("space-events", "cdc_ready")})
            selector = '{service_name="space-server"} | json | msg="http_request_completed" | statusCode >= 500'
            with urlopen(f"{endpoint}/loki/api/v1/query_range?" + urlencode({"query": selector}), timeout=5) as response:
                [match] = json.load(response)["data"]["result"]
                assert [json.loads(row[1]) for row in match["values"]] == [access]
            trace_selector = '{service_name=~"space-(worker|server)"} | json | msg="agent_turn_phase" | traceId="' + trace_id + '"'
            with urlopen(f"{endpoint}/loki/api/v1/query_range?" + urlencode({"query": trace_selector}), timeout=5) as response:
                streams = json.load(response)["data"]["result"]
                assert sorted(json.loads(row[1])["phase"] for stream in streams for row in stream["values"]) == ["execution", "tool"]
            assert CANARY not in run("logs", "log-collector"), "Private data reached collector diagnostics"
            print("Verified all three services, collector restart recovery, projected event bodies and private-field exclusion.")
        finally:
            run("down", "--volumes", "--remove-orphans")


if __name__ == "__main__":
    main()
