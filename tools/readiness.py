"""Functional checks for the default single-node deployment; no load benchmark."""

import json
import os
import urllib.parse
import urllib.request


base = os.environ.get("BASE_URL", "http://127.0.0.1:8080").rstrip("/")
origin = urllib.parse.urlsplit(base)
origin = f"{origin.scheme}://{origin.netloc}"


def request(path, data=None, method=None, headers=None):
    return urllib.request.urlopen(
        urllib.request.Request(path, data=data, method=method, headers=headers or {}),
        timeout=5,
    )


with request(base + "/healthz") as response:
    assert json.load(response)["status"] == "ok"
with request(base + "/") as response:
    assert "轻测速" in response.read().decode()
with request(base + "/api/config") as response:
    config = json.load(response)
    assert config["protocolVersion"] == 2
    assert len(config["nodes"]) == 1
    assert config["performance"]["maxStreams"] == 24
    measurement_origins = config["performance"]["measurementOrigins"]
    assert len(measurement_origins) == 4

for measurement_origin in measurement_origins:
    with request(
        measurement_origin + "/api/download?bytes=65536&nonce=readiness",
        headers={"Origin": origin},
    ) as response:
        assert response.headers["Content-Encoding"] == "identity"
        assert "no-store" in response.headers["Cache-Control"]
        assert response.headers["Access-Control-Allow-Origin"] == origin
        assert response.headers["X-Test-Connection-ID"]
        assert response.headers["X-Test-Protocol"] == "HTTP/1.1"
        assert len(response.read()) == 65536

with request(measurement_origins[0] + "/api/download?stream=1&nonce=readiness") as response:
    assert response.headers.get("Content-Length") is None
    assert response.headers["Content-Encoding"] == "identity"
    assert "no-store" in response.headers["Cache-Control"]
    assert len(response.read(65536)) == 65536

body = os.urandom(16384)
with request(base + "/api/upload?nonce=readiness", data=body) as response:
    assert json.load(response)["bytes"] == len(body)

with request(
    base + "/api/upload-sessions",
    data=json.dumps({"warmupMs": 0, "durationMs": 1000}).encode(),
    headers={"Content-Type": "application/json"},
) as response:
    assert response.status == 201
    session_id = json.load(response)["id"]
try:
    with request(measurement_origins[0] + "/api/upload?session=" + session_id, data=body) as response:
        assert json.load(response)["bytes"] == len(body)
    with request(base + "/api/upload-sessions/" + session_id) as response:
        snapshot = json.load(response)
        assert snapshot["measuredBytes"] == len(body)
        assert snapshot["activeTcpConnections"] == 0
finally:
    with request(base + "/api/upload-sessions/" + session_id, method="DELETE") as response:
        assert response.status == 204

print("testspeed protocol v2 functional readiness passed")
