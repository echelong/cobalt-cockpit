"""One bounded operator invocation; no daemon, installer, inference or transcript access."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

MAX_INPUT = 24000
MAX_OUTPUT = 2000000


def load_config(path):
    p = Path(path)
    if not p.is_absolute():
        raise ValueError("configuration_required")
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("private_operator_configuration_required")
        raw = stream.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError("configuration_too_large")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("invalid_configuration")
    return value


def dispatch(request):
    capability = request.get("capability")
    if capability not in ("memory", "browser"):
        raise ValueError("invalid_capability")
    # The host's switch is independent of the private file's switch. A disabled
    # call does not even open that file, inspect Git or start the browser worker.
    if request.get("enabled") is not True:
        return {"capability": capability, "status": "disabled", "duration_ms": 0}
    config = load_config(request.get("configuration_path", ""))
    if config.get(capability + "_enabled") is not True:
        return {"capability": capability, "status": "disabled", "duration_ms": 0}
    arguments = request.get("arguments", {})
    if not isinstance(arguments, dict):
        raise ValueError("invalid_arguments")
    # Cross-session exclusive effects. Locks release on process termination.
    # Never put endpoint strings, contents or credentials on disk.
    if 'lock_directory' in config:
        raise ValueError('lock_directory_not_configurable')
    directory = Path(f"/mnt/mem2/cobalt-capabilities-{os.getuid()}/locks")
    base = Path('/mnt/mem2').resolve(strict=True)
    if not directory.is_absolute() or '..' in directory.parts or not directory.resolve().is_relative_to(base):
        raise ValueError("lock_directory_must_use_mem2")
    if any(p.is_symlink() for p in [directory, *directory.parents] if p != base and p.is_relative_to(base)):
        raise ValueError("symlink_lock_directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid != os.getuid() or directory.stat().st_mode & 0o077:
        raise ValueError("private_lock_directory_required")
    # One lock across all endpoints/capabilities prevents independently configured
    # clients from widening the host's conservative ownership policy.
    digest = hashlib.sha256(b"cobalt-capabilities-exclusive").hexdigest()
    fd = os.open(directory / (digest + ".lock"), os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, "w") as lock:
        info = os.fstat(lock.fileno())
        if info.st_uid != os.getuid() or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError("invalid_lock_owner")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {"capability": capability, "status": "error", "error": "resource_busy"}
        if capability == "memory":
            from hindsight import Hindsight
            return Hindsight(config, request.get("repo", "")).execute(request.get("operation", "status"), arguments)
        worker = Path(__file__).with_name("browser.mjs")
        # A scrubbed child environment prevents implicit proxies/CDP credentials.
        env = {k: v for k, v in os.environ.items() if k in ("PATH", "LANG", "LC_ALL", "TMPDIR")}
        try:
            result = subprocess.run(["node", str(worker)], input=json.dumps({"config": config, "arguments": arguments}),
                                    capture_output=True, text=True, timeout=40, env=env, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return {"capability": capability, "status": "unavailable", "error": "worker_unavailable_or_timeout", "executed": False}
        if result.returncode or len(result.stdout) > MAX_OUTPUT:
            return {"capability": capability, "status": "error", "error": "worker_failed", "executed": False}
        return json.loads(result.stdout)


def main():
    try:
        raw = sys.stdin.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("request_too_large")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("invalid_request")
        result = dispatch(request)
    except Exception:
        # Never disclose exception strings, endpoints or raw service bodies.
        result = {"status": "error", "error": "invalid_configuration_or_request", "executed": False}
    print(json.dumps(result, ensure_ascii=True))


if __name__ == "__main__":
    main()
