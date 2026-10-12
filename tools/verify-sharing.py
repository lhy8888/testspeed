"""Exercise opt-in sharing on its own labelled Docker Compose named volume.

The probe never mounts a host data directory or reuses an existing resource.
Expiry/corruption checks edit only the newly created test database while its
container is stopped; no application debug endpoint or helper image is needed.
"""

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parent.parent
OWNER_LABEL = "org.testspeed.sharing-validation-token"
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]
PORT = 9760
BASE_URL = "http://127.0.0.1:" + str(PORT)
SHARE_VARIABLES = {"SHARE_DB_PATH", "SHARE_WRITE_TOKEN", "SHARE_RETENTION_HOURS", "SHARE_MAX_RESULTS"}


def run(command, *, environment, check=True, binary=False, input_data=None):
    result = subprocess.run(command, env=environment, capture_output=True,
                            text=not binary, input=input_data, check=False)
    if check and result.returncode:
        error = result.stderr if result.stderr else result.stdout
        if isinstance(error, bytes):
            error = error.decode("utf-8", errors="replace")
        raise RuntimeError(error.strip())
    return result


def resources(kind, *, environment, project, owner=None):
    command = DOCKER + [kind, "ls", "--quiet", "--filter", "label=com.docker.compose.project=" + project]
    if kind == "container":
        command.append("--all")
    if owner:
        command += ["--filter", "label=" + OWNER_LABEL + "=" + owner]
    return run(command, environment=environment).stdout.split()


def inspect_owned(kind, resource, *, environment, owner):
    data = json.loads(run(DOCKER + [kind, "inspect", resource], environment=environment).stdout)[0]
    labels = data["Config"].get("Labels") if kind == "container" else data.get("Labels")
    assert (labels or {}).get(OWNER_LABEL) == owner, "Refusing to use a resource not owned by this validation"
    return data


def cleanup(*, environment, project, owner):
    errors = []
    for kind in ("container", "network", "volume"):
        for resource in resources(kind, environment=environment, project=project, owner=owner):
            try:
                inspect_owned(kind, resource, environment=environment, owner=owner)
                arguments = DOCKER + [kind, "rm"]
                if kind == "container":
                    arguments.append("--force")
                run(arguments + [resource], environment=environment)
            except (AssertionError, RuntimeError) as error:
                errors.append(str(error))
    if errors:
        raise RuntimeError("Sharing validation cleanup failed: " + "; ".join(errors))


def request(path, *, method="GET", body=None, headers=None):
    data = None if body is None else json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request_headers = dict(headers or {})
    if data is not None:
        request_headers["Content-Type"] = "application/json"
    call = urllib.request.Request(BASE_URL + path, data=data, headers=request_headers, method=method)
    # Local container probes must stay local even when the host has a proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open(call, timeout=4)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        payload = response.read(65537)
        assert len(payload) <= 65536, "Unexpectedly large result-sharing response"
        return response.status, dict(response.headers), json.loads(payload) if payload else None


def ready():
    deadline = time.monotonic() + 30
    while True:
        try:
            status, _, body = request("/healthz")
            assert status == 200 and body["status"] == "ok"
            return
        except (OSError, AssertionError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)


def client_report():
    return {
        "schemaVersion": 1, "completedAt": "2026-10-12T11:00:00Z",
        "node": {"id": "sharing-validation", "name": "Local validation node"},
        "testType": "full", "measurementPolicy": "fixed", "transport": "websocket", "mode": "manual",
        "download": {"mbps": 1000, "durationMs": 10000, "measuredBytes": 1250000000, "totalBytes": 1400000000, "completionReason": "duration", "complete": True},
        "upload": {"mbps": 20, "durationMs": 10000, "measuredBytes": 25000000, "totalBytes": 30000000, "completionReason": "duration", "complete": True},
        "latency": {
            "idle": {"medianMs": 20, "jitterMs": 1, "samples": 2, "failed": 0, "attempts": 2},
            "download": {"medianMs": 30, "jitterMs": 2, "samples": 2, "failed": 1, "attempts": 3},
            "upload": {"medianMs": 40, "jitterMs": 3, "samples": 2, "failed": 0, "attempts": 2},
        }, "connections": {"downloadPeak": 8, "uploadPeak": 8},
    }


def get_created(created, expected):
    status, headers, body = request("/api/results/" + created["id"])
    assert status == 200, "Actual created result could not be read"
    assert body["id"] == created["id"] and body["provenance"] == "client-reported"
    assert body["result"] == expected, "Persistence changed the client report"
    assert "deleteToken" not in body and "no-store" in headers.get("Cache-Control", "")
    return body


def database_archive(container, *, environment, owner):
    info = inspect_owned("container", container, environment=environment, owner=owner)
    assert not info["State"]["Running"], "Database inspection requires the owned test container to be stopped"
    archive = run(DOCKER + ["cp", container + ":/var/lib/testspeed", "-"], environment=environment, binary=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:*") as files:
        members = files.getmembers()
        directory = next(member for member in members if member.isdir() and member.name.rstrip("/") == "testspeed")
        database = next(member for member in members if member.isfile() and member.name == "testspeed/results.sqlite")
        assert (directory.uid, directory.gid, directory.mode & 0o777) == (65532, 65532, 0o750), "Image directory did not initialize a private, writable non-root named volume: uid=%d gid=%d mode=%04o" % (directory.uid, directory.gid, directory.mode & 0o777)
        assert (database.uid, database.gid, database.mode & 0o777) == (65532, 65532, 0o600), "SQLite database is not owned privately by the app user: uid=%d gid=%d mode=%04o" % (database.uid, database.gid, database.mode & 0o777)
        assert database.size <= 4 * 1024 * 1024
        payload = files.extractfile(database).read()
    return payload


def replace_database(container, payload, *, environment, owner):
    info = inspect_owned("container", container, environment=environment, owner=owner)
    assert not info["State"]["Running"], "Refusing to edit a live database"
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w") as files:
        member = tarfile.TarInfo("results.sqlite")
        member.size = len(payload)
        member.uid = member.gid = 65532
        member.mode = 0o600
        member.mtime = int(time.time())
        files.addfile(member, io.BytesIO(payload))
    run(DOCKER + ["cp", "--archive", "-", container + ":/var/lib/testspeed/"], environment=environment, binary=True, input_data=archive.getvalue())


def check_config(compose, *, environment):
    base = json.loads(run(compose + ["config", "--format", "json"], environment=environment).stdout)
    sharing = json.loads(run(compose + ["--file", str(ROOT / "compose.share.yaml"), "config", "--format", "json"], environment=environment).stdout)
    normal = base["services"]["testspeed"]
    optional = sharing["services"]["testspeed"]
    assert not normal["environment"].get("SHARE_DB_PATH") and not normal.get("volumes"), "Default deployment unexpectedly enables persistence"
    assert optional["environment"]["SHARE_DB_PATH"] == "/var/lib/testspeed/results.sqlite"
    assert optional["read_only"] is True and optional["cap_drop"] == ["ALL"]
    assert optional["security_opt"] == ["no-new-privileges:true"]
    assert len(optional["volumes"]) == 1
    mount = optional["volumes"][0]
    assert {key: mount[key] for key in ("type", "source", "target")} == {"type": "volume", "source": "testspeed-results", "target": "/var/lib/testspeed"}
    assert not mount.get("read_only") and not mount.get("volume", {}).get("nocopy"), "Named volume must initialize from the private image directory"
    comparable_base, comparable_sharing = copy.deepcopy(base), copy.deepcopy(sharing)
    comparable_sharing.pop("volumes", None)
    service = comparable_sharing["services"]["testspeed"]
    service.pop("volumes", None)
    for name in SHARE_VARIABLES:
        service["environment"].pop(name)
    assert comparable_base == comparable_sharing, "Optional sharing changed unrelated deployment settings"
    print("PASS sharing Compose merge: default disabled; only opt-in storage/env added; non-root/read-only/cap-drop/NNP retained", flush=True)


def main():
    environment = os.environ.copy()
    for name in ("DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        environment.pop(name, None)
    environment.update({"DOCKER_HOST": "unix:///var/run/docker.sock", "PORT": str(PORT), "SHARE_WRITE_TOKEN": "", "SHARE_RETENTION_HOURS": "1", "SHARE_MAX_RESULTS": "128"})
    selected = os.environ.get("COMPOSE_COMMAND")
    compose_cli = json.loads(selected) if selected else ["docker", "compose"]
    if not isinstance(compose_cli, list) or not compose_cli or not all(isinstance(argument, str) and argument for argument in compose_cli):
        raise ValueError("COMPOSE_COMMAND must be a nonempty JSON array")
    owner = uuid.uuid4().hex
    project = "testspeed-sharing-validation-" + owner[:12]
    compose = compose_cli + ["--project-name", project, "--project-directory", str(ROOT), "--file", str(ROOT / "compose.yaml")]
    check_config(compose, environment=environment)
    for kind in ("container", "network", "volume"):
        assert not resources(kind, environment=environment, project=project), "Refusing to reuse an existing validation project"
    with socket.socket() as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        probe.bind(("127.0.0.1", PORT))
    image = os.environ.get("TESTSPEED_IMAGE", "testspeed:ci")
    run(DOCKER + ["image", "inspect", image], environment=environment)
    with tempfile.TemporaryDirectory(prefix="testspeed-sharing-validation-") as temporary:
        directory = Path(temporary)
        overlay = directory / "runtime.yaml"
        overlay.write_text(
            "services:\n  testspeed:\n    image: " + json.dumps(image) + "\n"
            "    build: !reset null\n    restart: 'no'\n"
            "    ports: !override\n      - '127.0.0.1:9760:8080'\n"
            "    environment:\n      PUBLIC_ORIGIN: " + json.dumps(BASE_URL) + "\n      GEOIP_ENABLED: 'false'\n      TRUSTED_PROXIES: ''\n"
            "    labels:\n      " + OWNER_LABEL + ": " + json.dumps(owner) + "\n"
            "networks:\n  default:\n    labels:\n      " + OWNER_LABEL + ": " + json.dumps(owner) + "\n", encoding="utf-8")
        volume_labels = directory / "volume-labels.yaml"
        volume_labels.write_text("volumes:\n  testspeed-results:\n    labels:\n      " + OWNER_LABEL + ": " + json.dumps(owner) + "\n", encoding="utf-8")
        sharing_command = compose + ["--file", str(ROOT / "compose.share.yaml"), "--file", str(overlay), "--file", str(volume_labels)]
        runtime = json.loads(run(sharing_command + ["config", "--format", "json"], environment=environment).stdout)["services"]["testspeed"]
        assert runtime["image"] == image and not runtime.get("build")
        assert runtime["ports"] == [{"mode": "ingress", "host_ip": "127.0.0.1", "target": 8080, "published": str(PORT), "protocol": "tcp"}]
        created = None
        try:
            # First exercise the default deployment with the same owned container.
            default_command = compose + ["--file", str(overlay)]
            run(default_command + ["up", "--detach", "--no-build", "--pull", "never"], environment=environment)
            ready()
            status, _, _ = request("/api/results", method="POST", body=client_report())
            assert status == 404, "Default deployment must reject sharing without opening a database"
            assert not resources("volume", environment=environment, project=project, owner=owner), "Default deployment created a persistence volume"
            print("PASS actual default container: result sharing disabled, no named volume created", flush=True)
            run(sharing_command + ["up", "--detach", "--no-build", "--pull", "never", "--force-recreate"], environment=environment)
            ready()
            containers = resources("container", environment=environment, project=project, owner=owner)
            volumes = resources("volume", environment=environment, project=project, owner=owner)
            assert len(containers) == len(volumes) == 1
            container, volume = containers[0], volumes[0]
            info = inspect_owned("container", container, environment=environment, owner=owner)
            inspect_owned("volume", volume, environment=environment, owner=owner)
            assert info["Config"]["User"] == "65532:65532"
            assert info["HostConfig"]["ReadonlyRootfs"] is True and info["HostConfig"]["CapDrop"] == ["ALL"]
            assert any(option in ("no-new-privileges", "no-new-privileges:true") for option in info["HostConfig"]["SecurityOpt"])
            assert [{"Name": mount["Name"], "Destination": mount["Destination"], "RW": mount["RW"]} for mount in info["Mounts"]] == [{"Name": volume, "Destination": "/var/lib/testspeed", "RW": True}]
            expected = client_report()
            private_agent = "testspeed-private-validation-agent-" + owner
            status, _, _ = request("/api/results", method="POST", body=expected, headers={"Origin": "https://untrusted.example"})
            assert status == 403, "Cross-origin result creation bypassed the existing API origin boundary"
            status, response_headers, created = request("/api/results", method="POST", body=expected, headers={"Origin": BASE_URL, "User-Agent": private_agent, "X-Forwarded-For": "198.51.100.123"})
            assert status == 201 and len(created["id"]) == len(created["deleteToken"]) == 32
            assert response_headers.get("Access-Control-Allow-Origin") == BASE_URL
            assert created["id"] != created["deleteToken"] and created["url"] == "/share.html?id=" + created["id"]
            original = get_created(created, expected)
            status, _, _ = request("/api/results/" + created["id"], method="DELETE", headers={"Origin": BASE_URL, "X-Delete-Token": "a" * 32})
            assert status == 403, "Unauthorized deletion succeeded"
            get_created(created, expected)
            run(DOCKER + ["stop", "--time", "10", container], environment=environment)
            payload = database_archive(container, environment=environment, owner=owner)
            assert private_agent.encode() not in payload and b"198.51.100.123" not in payload and created["deleteToken"].encode() not in payload
            database = directory / "results.sqlite"
            database.write_bytes(payload)
            with sqlite3.connect(database) as connection:
                columns = [row[1] for row in connection.execute("PRAGMA table_info(shared_results)")]
                assert columns == ["id", "created_at", "expires_at", "report", "delete_hash"]
                rows = connection.execute("SELECT id,report,delete_hash FROM shared_results").fetchall()
                assert len(rows) == 1 and rows[0][0] == created["id"]
                assert json.loads(rows[0][1]) == expected
                assert rows[0][2] == hashlib.sha256(created["deleteToken"].encode()).digest()
                assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
            run(DOCKER + ["start", container], environment=environment)
            ready()
            assert get_created(created, expected) == original
            print("PASS actual opt-in container: private non-root volume/database, exact persisted report after restart, no IP/UA/plain deletion token in SQLite, unauthorized deletion rejected", flush=True)
            # Read validation rejects damaged records, rather than returning arbitrary JSON.
            run(DOCKER + ["stop", "--time", "10", container], environment=environment)
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE shared_results SET report=? WHERE id=?", (b'{"unexpected":"<script>alert(1)</script>"}', created["id"]))
            replace_database(container, database.read_bytes(), environment=environment, owner=owner)
            run(DOCKER + ["start", container], environment=environment)
            ready()
            status, _, bad = request("/api/results/" + created["id"])
            assert status == 503 and "<script>" not in json.dumps(bad)
            # Restore only this test row and make it expired while the app is stopped.
            run(DOCKER + ["stop", "--time", "10", container], environment=environment)
            with sqlite3.connect(database) as connection:
                connection.execute("UPDATE shared_results SET report=?,expires_at=? WHERE id=?", (json.dumps(expected, separators=(",", ":"), ensure_ascii=False).encode(), int(time.time() * 1000) - 1000, created["id"]))
            replace_database(container, database.read_bytes(), environment=environment, owner=owner)
            run(DOCKER + ["start", container], environment=environment)
            ready()
            status, _, _ = request("/api/results/" + created["id"])
            assert status == 404, "Expired result remains public"
            print("PASS actual offline test-row mutation: corrupt result rejected with 503; expired result rejected with 404", flush=True)
            status, _, replacement = request("/api/results", method="POST", body=expected)
            assert status == 201
            get_created(replacement, expected)
            status, _, _ = request("/api/results/" + replacement["id"], method="DELETE", headers={"X-Delete-Token": replacement["deleteToken"]})
            assert status == 204
            status, _, _ = request("/api/results/" + replacement["id"])
            assert status == 404
            print("PASS actual result creation/read/revocation after expiry maintenance", flush=True)
            # Optional write authentication remains private and public reads stay usable.
            write_token = "validation-write-" + owner
            authentication = directory / "authentication.yaml"
            authentication.write_text("services:\n  testspeed:\n    environment:\n      SHARE_WRITE_TOKEN: " + json.dumps(write_token) + "\n", encoding="utf-8")
            authenticated_command = sharing_command + ["--file", str(authentication)]
            run(authenticated_command + ["up", "--detach", "--no-build", "--pull", "never", "--force-recreate"], environment=environment)
            ready()
            containers = resources("container", environment=environment, project=project, owner=owner)
            assert len(containers) == 1
            container = containers[0]
            for authorization in (None, "Bearer incorrect"):
                headers = {"Origin": BASE_URL}
                if authorization:
                    headers["Authorization"] = authorization
                status, _, _ = request("/api/results", method="POST", body=expected, headers=headers)
                assert status == 401, "Optional write authentication accepted a missing or wrong token"
            status, _, authenticated = request("/api/results", method="POST", body=expected, headers={"Origin": BASE_URL, "Authorization": "Bearer " + write_token})
            assert status == 201
            get_created(authenticated, expected)
            run(DOCKER + ["stop", "--time", "10", container], environment=environment)
            payload = database_archive(container, environment=environment, owner=owner)
            assert write_token.encode() not in payload and authenticated["deleteToken"].encode() not in payload
            run(DOCKER + ["start", container], environment=environment)
            ready()
            status, _, _ = request("/api/results/" + authenticated["id"], method="DELETE", headers={"Authorization": "Bearer " + write_token})
            assert status == 204
            status, _, _ = request("/api/results/" + authenticated["id"])
            assert status == 404
            print("PASS optional write-token deployment: missing/wrong token rejected, authorized create/public read/admin revocation succeed; tokens absent from SQLite", flush=True)
        finally:
            cleanup(environment=environment, project=project, owner=owner)
    for kind in ("container", "network", "volume"):
        assert not resources(kind, environment=environment, project=project, owner=owner)
    print("PASS only validation-owned containers/network/new named volume cleaned; no production resources accessed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, OSError, RuntimeError, ValueError, sqlite3.Error, StopIteration) as error:
        print("Sharing Compose validation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
