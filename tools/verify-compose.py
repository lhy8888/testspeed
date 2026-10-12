"""Check the Snap Compose override on standard Docker, not Snap/AppArmor itself."""

import copy
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parent.parent
PROJECT = "testspeed-snap-validation"
OWNER_LABEL = "org.testspeed.validation-token"
PROJECT_LABEL = "com.docker.compose.project=" + PROJECT
PORTS = (9750,)
BASE_URL = "http://127.0.0.1:9750"
DOCKER = ["docker", "--host=unix:///var/run/docker.sock"]


def run(command, *, environment, check=True):
    result = subprocess.run(
        command, env=environment, capture_output=True, text=True, check=False
    )
    if check and result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip())
    return result


def resource_ids(kind, *, environment, token=None):
    command = DOCKER + [kind, "ls", "--quiet", "--filter", "label=" + PROJECT_LABEL]
    if kind == "container":
        command.append("--all")
    if token:
        command += ["--filter", "label=" + OWNER_LABEL + "=" + token]
    return run(command, environment=environment).stdout.split()


def cleanup(*, environment, token):
    errors = []
    for kind in ("container", "network"):
        try:
            ids = resource_ids(kind, environment=environment, token=token)
            if ids:
                command = DOCKER + [kind, "rm"]
                if kind == "container":
                    command.append("--force")
                run(command + ids, environment=environment)
        except RuntimeError as error:
            errors.append(str(error))
    if errors:
        raise RuntimeError("Validation cleanup failed: " + "; ".join(errors))


def check_config(compose, *, environment):
    base = json.loads(run(compose + ["config", "--format", "json"], environment=environment).stdout)
    snap_command = compose + ["--file", str(ROOT / "compose.snap.yaml")]
    snap = json.loads(run(snap_command + ["config", "--format", "json"], environment=environment).stdout)
    normal_service = base["services"]["testspeed"]
    snap_service = snap["services"]["testspeed"]
    assert normal_service["security_opt"] == ["no-new-privileges:true"]
    assert not snap_service.get("security_opt"), "Snap override must remove no-new-privileges"
    assert snap_service["read_only"] is True
    assert snap_service["cap_drop"] == ["ALL"]
    assert Path(snap_service["build"]["context"]) == ROOT
    assert len(snap_service["ports"]) == 1
    assert snap_service["environment"]["TEST_TRANSPORT"] == "websocket"
    assert snap_service["environment"]["MEASUREMENT_PORTS"] == ""
    assert snap_service["environment"]["MAX_TEST_STREAMS"] == "30"
    comparable_base = copy.deepcopy(base)
    comparable_snap = copy.deepcopy(snap)
    comparable_base["services"]["testspeed"].pop("security_opt", None)
    comparable_snap["services"]["testspeed"].pop("security_opt", None)
    assert comparable_base == comparable_snap, "Snap override changed fields beyond security_opt"
    print("PASS normal/Snap merged config: only security_opt removed", flush=True)
    http = json.loads(run(compose + ["--file", str(ROOT / "compose.http.yaml"), "config", "--format", "json"], environment=environment).stdout)
    http_service = http["services"]["testspeed"]
    assert len(http_service["ports"]) == 5
    assert http_service["read_only"] is True and http_service["cap_drop"] == ["ALL"]
    assert http_service["security_opt"] == normal_service["security_opt"]
    assert http_service["environment"]["TEST_TRANSPORT"] == "http"
    assert http_service["environment"]["MEASUREMENT_PORTS"] == "8081,8082,8083,8084"
    assert http_service["environment"]["MAX_TEST_STREAMS"] == "24"
    comparable_http = copy.deepcopy(http)
    comparable_default = copy.deepcopy(base)
    for service in (comparable_http["services"]["testspeed"], comparable_default["services"]["testspeed"]):
        service.pop("ports")
        for variable in ("TEST_TRANSPORT", "MEASUREMENT_PORTS", "MAX_TEST_STREAMS"):
            service["environment"].pop(variable)
    assert comparable_http == comparable_default, "HTTP override changed unrelated default settings"
    print("PASS optional HTTP config: four data ports, max 24, default WebSocket config unchanged", flush=True)
    return snap_command


def main():
    selected = os.environ.get("COMPOSE_COMMAND")
    compose_cli = json.loads(selected) if selected else ["docker", "compose"]
    if not isinstance(compose_cli, list) or not compose_cli or not all(isinstance(value, str) and value for value in compose_cli):
        raise ValueError("COMPOSE_COMMAND must be a nonempty JSON array of command arguments")
    environment = os.environ.copy()
    for name in ("DOCKER_CONTEXT", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        environment.pop(name, None)
    environment["DOCKER_HOST"] = "unix:///var/run/docker.sock"
    version = run(compose_cli + ["version", "--short"], environment=environment).stdout.strip()
    compose = compose_cli + ["--project-name", PROJECT, "--project-directory", str(ROOT), "--file", str(ROOT / "compose.yaml")]
    snap_command = check_config(compose, environment=environment)

    for kind in ("container", "network", "volume"):
        if resource_ids(kind, environment=environment):
            raise RuntimeError("Refusing to reuse an existing " + PROJECT + " project")
    for port in PORTS:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", port))
    image = os.environ.get("TESTSPEED_IMAGE", "testspeed:ci")
    run(DOCKER + ["image", "inspect", "--format", "{{.Id}}", image], environment=environment)
    token = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="testspeed-compose-validation-") as temporary:
        overlay = Path(temporary) / "runtime.yaml"
        overlay.write_text(
            "services:\n  testspeed:\n"
            "    image: " + json.dumps(image) + "\n"
            "    build: !reset null\n    restart: 'no'\n"
            "    ports: !override\n"
            + "      - '127.0.0.1:9750:8080'\n"
            + "    environment:\n      PUBLIC_ORIGIN: " + json.dumps(BASE_URL) + "\n"
            "    labels:\n      " + OWNER_LABEL + ": " + json.dumps(token) + "\n"
            "networks:\n  default:\n    labels:\n      " + OWNER_LABEL + ": " + json.dumps(token) + "\n"
        )
        runtime_command = snap_command + ["--file", str(overlay)]
        runtime_config = json.loads(run(runtime_command + ["config", "--format", "json"], environment=environment).stdout)
        runtime_service = runtime_config["services"]["testspeed"]
        assert not runtime_service.get("build")
        assert runtime_service["image"] == image
        assert runtime_service["restart"] == "no"
        assert len(runtime_service["ports"]) == 1
        assert {int(port["published"]) for port in runtime_service["ports"]} == set(PORTS)
        assert all(port["host_ip"] == "127.0.0.1" for port in runtime_service["ports"])
        try:
            run(runtime_command + ["up", "--detach", "--no-build", "--pull", "never"], environment=environment)
            ids = resource_ids("container", environment=environment, token=token)
            assert len(ids) == 1, "Expected one newly created validation container"
            template = "|".join(("{{json .Config.User}}", "{{json .HostConfig.ReadonlyRootfs}}", "{{json .HostConfig.CapDrop}}", "{{json .HostConfig.SecurityOpt}}", "{{json .State.Running}}"))
            fields = run(DOCKER + ["inspect", "--format", template, ids[0]], environment=environment).stdout.strip().split("|")
            user, read_only, cap_drop, security_opt, running = map(json.loads, fields)
            assert user == "65532:65532"
            assert read_only is True and cap_drop == ["ALL"] and running is True
            assert not any("no-new-privileges" in option for option in security_opt or [])
            deadline = time.monotonic() + 30
            while True:
                try:
                    with urllib.request.urlopen(BASE_URL + "/healthz", timeout=1) as response:
                        assert json.load(response)["status"] == "ok"
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.25)
            readiness_environment = environment.copy()
            readiness_environment["BASE_URL"] = BASE_URL
            readiness_environment["TEST_TRANSPORT"] = "websocket"
            result = run([sys.executable, str(ROOT / "tools/readiness.py")], environment=readiness_environment)
            print(result.stdout.strip(), flush=True)
            print("PASS Compose " + version + ": single-port WebSocket Snap override runtime on standard Docker, port 9750, non-root/read-only/ALL dropped/no NNP", flush=True)
        finally:
            cleanup(environment=environment, token=token)
    print("PASS validation-owned containers and networks cleaned; real Snap/AppArmor was not exercised", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, OSError, RuntimeError, ValueError) as error:
        print("Compose validation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
