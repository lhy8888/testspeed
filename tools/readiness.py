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
    page = response.read().decode()
    assert 'id="download-value"' in page
    assert 'id="more-info-button"' in page
    assert 'src="app.js"' in page or 'src="/app.js"' in page
with request(base + "/api/config") as response:
    config = json.load(response)
    assert config["protocolVersion"] == 2
    assert len(config["nodes"]) == 1
    performance = config["performance"]
    transport = os.environ.get("TEST_TRANSPORT", "websocket")
    assert transport in ("websocket", "http")
    assert performance["transport"] == transport
    assert performance["defaultMode"] == "manual"
    maximum_streams = performance["maxStreams"]
    assert 1 <= maximum_streams <= 30
    assert performance["defaultStreams"] == min(8, maximum_streams)
    measurement_origins = performance["measurementOrigins"]
    assert measurement_origins and len(set(measurement_origins)) == len(measurement_origins)
    if transport == "websocket":
        assert measurement_origins == [origin]
        assert maximum_streams == int(os.environ.get("EXPECTED_MAX_STREAMS", "30"))
    else:
        capacity = sum(4 if measurement_origin == origin else 6 for measurement_origin in measurement_origins)
        assert maximum_streams <= capacity
    if "EXPECTED_MAX_STREAMS" in os.environ:
        assert maximum_streams == int(os.environ["EXPECTED_MAX_STREAMS"])
    if "EXPECTED_ORIGIN_COUNT" in os.environ:
        assert len(measurement_origins) == int(os.environ["EXPECTED_ORIGIN_COUNT"])

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

print(f"testspeed protocol v2 {transport} configuration and HTTP diagnostic readiness passed")
