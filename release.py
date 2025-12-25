#!/usr/bin/env python3
"""Redeploy NexaQuill backend/frontend/worker to Azure resources."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Dict, Iterable, List

ROOT = Path(__file__).resolve().parent
AZURE_DIR = ROOT / "scripts" / "azure"

RESOURCE_GROUP = "nexaquill-rg"
LOCATION = "swedencentral"
ACR_NAME = "nexaquillacr12230947"
PLAN_NAME = "nexaquill-api-plan"
API_APP = "nexaquill-api-web"
FRONTEND_APP = "nexaquill-frontend-web"
WORKER_GROUP = "nexaquill-worker-aci"
WORKER_CONTAINER = "nexaquill-worker"
FRONTEND_HOST = f"https://{FRONTEND_APP}.azurewebsites.net"
API_HOST = f"https://{API_APP}.azurewebsites.net"

BACKEND_IMAGE = "nexaquill-backend:prod"
FRONTEND_IMAGE = "nexaquill-frontend:prod"


class CommandError(RuntimeError):
    pass


def run(cmd: List[str], *, capture: bool = False) -> str:
    """Run a command and echo it."""
    print("\n$", " ".join(cmd), flush=True)
    try:
        result = subprocess.run(
            cmd,
            check=True,
            text=True,
            capture_output=capture,
        )
    except subprocess.CalledProcessError as exc:
        if exc.stdout:
            sys.stdout.write(exc.stdout)
        if exc.stderr:
            sys.stderr.write(exc.stderr)
        raise CommandError(f"Command failed: {' '.join(cmd)}") from exc
    return result.stdout.strip() if capture else ""


def command_succeeds(cmd: List[str]) -> bool:
    try:
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except subprocess.CalledProcessError:
        return False


def load_env(path: Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value
    return env


def ensure_appservice_plan() -> None:
    if command_succeeds(["az", "appservice", "plan", "show", "-g", RESOURCE_GROUP, "-n", PLAN_NAME]):
        print(f"App Service plan {PLAN_NAME} already exists")
        return
    run([
        "az",
        "appservice",
        "plan",
        "create",
        "-g",
        RESOURCE_GROUP,
        "-n",
        PLAN_NAME,
        "--is-linux",
        "--sku",
        "B1",
        "--location",
        LOCATION,
    ])


def ensure_webapp(name: str, image: str, acr_server: str, acr_user: str, acr_pass: str) -> None:
    if not command_succeeds(["az", "webapp", "show", "-g", RESOURCE_GROUP, "-n", name]):
        run([
            "az",
            "webapp",
            "create",
            "-g",
            RESOURCE_GROUP,
            "-p",
            PLAN_NAME,
            "-n",
            name,
            "--deployment-container-image-name",
            f"{acr_server}/{image}",
        ])
    run([
        "az",
        "webapp",
        "config",
        "container",
        "set",
        "-g",
        RESOURCE_GROUP,
        "-n",
        name,
        "--container-image-name",
        f"{acr_server}/{image}",
        "--container-registry-url",
        f"https://{acr_server}",
        "--container-registry-user",
        acr_user,
        "--container-registry-password",
        acr_pass,
    ])


def set_appsettings(app: str, items: Dict[str, str]) -> None:
    cmd = ["az", "webapp", "config", "appsettings", "set", "-g", RESOURCE_GROUP, "-n", app, "--settings"]
    for key, value in items.items():
        cmd.append(f"{key}={value}")
    run(cmd)


def restart_webapp(app: str) -> None:
    run(["az", "webapp", "restart", "-g", RESOURCE_GROUP, "-n", app])


def build_images(
    acr_server: str,
    acr_user: str,
    acr_pass: str,
    builder: str,
    frontend_env: Dict[str, str],
) -> None:
    run(["docker", "login", acr_server, "-u", acr_user, "-p", acr_pass])
    if not command_succeeds(["docker", "buildx", "inspect", builder]):
        run(["docker", "buildx", "create", "--name", builder, "--use"])
    else:
        run(["docker", "buildx", "use", builder])

    run([
        "docker",
        "buildx",
        "build",
        "--builder",
        builder,
        "--platform",
        "linux/amd64,linux/arm64",
        "-t",
        f"{acr_server}/{BACKEND_IMAGE}",
        str(ROOT / "backend"),
        "--push",
    ])
    frontend_build_cmd = [
        "docker",
        "buildx",
        "build",
        "--builder",
        builder,
        "--platform",
        "linux/amd64,linux/arm64",
        "-t",
        f"{acr_server}/{FRONTEND_IMAGE}",
    ]
    backend_url = frontend_env.get("NEXT_PUBLIC_BACKEND_URL")
    if backend_url:
        frontend_build_cmd.extend(["--build-arg", f"NEXT_PUBLIC_BACKEND_URL={backend_url}"])
    frontend_build_cmd.extend([str(ROOT / "frontend"), "--push"])
    run(frontend_build_cmd)


def create_worker(acr_server: str, acr_user: str, acr_pass: str, backend_env: Dict[str, str]) -> None:
    worker_env = [
        {"name": key, "value": value}
        for key, value in backend_env.items()
    ]
    body = {
        "location": LOCATION,
        "properties": {
            "containers": [
                {
                    "name": WORKER_CONTAINER,
                    "properties": {
                        "image": f"{acr_server}/{BACKEND_IMAGE}",
                        "command": ["uv", "run", "python", "-m", "nexaquill_api.worker"],
                        "resources": {
                            "requests": {"cpu": 1.0, "memoryInGb": 1.5}
                        },
                        "environmentVariables": worker_env,
                    },
                }
            ],
            "imageRegistryCredentials": [
                {
                    "server": acr_server,
                    "username": acr_user,
                    "password": acr_pass,
                }
            ],
            "restartPolicy": "Always",
            "osType": "Linux",
            "sku": "Standard",
        },
    }

    with tempfile.NamedTemporaryFile("w", delete=False) as tmp:
        json.dump(body, tmp)
        tmp.flush()
        run([
            "az",
            "rest",
            "--method",
            "put",
            "--url",
            f"https://management.azure.com/subscriptions/{get_subscription_id()}/resourceGroups/{RESOURCE_GROUP}/providers/Microsoft.ContainerInstance/containerGroups/{WORKER_GROUP}?api-version=2024-11-01-preview",
            "--body",
            f"@{tmp.name}",
            "--headers",
            "Content-Type=application/json",
        ])


def get_subscription_id() -> str:
    return run(["az", "account", "show", "--query", "id", "-o", "tsv"], capture=True)


def get_acr_credentials() -> Dict[str, str]:
    server = run(["az", "acr", "show", "-n", ACR_NAME, "--query", "loginServer", "-o", "tsv"], capture=True)
    user = run(["az", "acr", "credential", "show", "-n", ACR_NAME, "--query", "username", "-o", "tsv"], capture=True)
    password = run([
        "az",
        "acr",
        "credential",
        "show",
        "-n",
        ACR_NAME,
        "--query",
        "passwords[0].value",
        "-o",
        "tsv",
    ], capture=True)
    return {"server": server, "user": user, "password": password}


def get_default_hostname(app_name: str) -> str:
    host = run([
        "az",
        "webapp",
        "show",
        "-g",
        RESOURCE_GROUP,
        "-n",
        app_name,
        "--query",
        "defaultHostName",
        "-o",
        "tsv",
    ], capture=True)
    return f"https://{host}"


def main() -> None:
    parser = argparse.ArgumentParser(description="Deploy NexaQuill release")
    parser.add_argument("--skip-build", action="store_true", help="Skip docker buildx steps")
    parser.add_argument("--builder", default="nexa-bx", help="Docker buildx builder name")
    args = parser.parse_args()

    backend_env = load_env(AZURE_DIR / "backend.env")
    frontend_env = load_env(AZURE_DIR / "frontend.env")

    creds = get_acr_credentials()
    acr_server = creds["server"]
    acr_user = creds["user"]
    acr_pass = creds["password"]

    if not args.skip_build:
        build_images(acr_server, acr_user, acr_pass, args.builder, frontend_env)

    ensure_appservice_plan()

    ensure_webapp(API_APP, BACKEND_IMAGE, acr_server, acr_user, acr_pass)
    api_settings = backend_env.copy()
    api_settings["WEBSITES_PORT"] = "8000"
    api_settings["CORS_ALLOW_ORIGINS"] = FRONTEND_HOST
    set_appsettings(API_APP, api_settings)
    restart_webapp(API_APP)
    api_url = get_default_hostname(API_APP)

    ensure_webapp(FRONTEND_APP, FRONTEND_IMAGE, acr_server, acr_user, acr_pass)
    fe_settings = frontend_env.copy()
    fe_settings["WEBSITES_PORT"] = "3000"
    fe_settings["NEXTAUTH_URL"] = FRONTEND_HOST
    fe_settings["NEXT_PUBLIC_BACKEND_URL"] = api_url
    set_appsettings(FRONTEND_APP, fe_settings)
    restart_webapp(FRONTEND_APP)

    create_worker(acr_server, acr_user, acr_pass, backend_env)

    frontend_url = get_default_hostname(FRONTEND_APP)

    print("\nDeployment complete:")
    print(f"  API URL: {api_url}")
    print(f"  Frontend URL: {frontend_url}")


if __name__ == "__main__":
    main()
