#!/usr/bin/env python3
"""Minimal Python client of the wire-tools-ts bind registry, used by
BindRegistryPythonClient.test.ts to prove the on-disk protocol documented in
docs/bind-registry/README.md is implementable outside Node.

Usage:
    register_ports.py <port>...

Takes the registry lock, reads every live registration (deleting stale ones),
refuses ports another live process holds, writes this process's registration
atomically, releases the lock, and prints one JSON report line. If the lock is
held when it first tries, it first prints the line `waiting-for-lock`.

The report line:

    {"pid": ..., "executable": ..., "registrationFile": ...,
     "lockDirectory": ..., "registeredPorts": [...]}

where registeredPorts are the ports other live registrations hold. It then
waits for EOF on stdin, deletes its registration, and exits 0.

Exit codes:
    0  registered, then released on stdin EOF
    2  usage error
    3  a requested port is held by another live registration
    4  the registry lock could not be taken within the bounded wait
    5  a live process's registration cannot be read or is not valid (it is
       kept, and nothing is written)
"""

import hashlib
import json
import os
import sys
import time

REGISTRY_PATH_ENV_VAR = "WIRE_BIND_REGISTRY_PATH"
REGISTRY_DIRECTORY_NAME = "wire-platform-bind-config"
REGISTRY_FILE_SUFFIX = ".bind-config.json"
TEMPORARY_FILE_SUFFIX = ".tmp"
LOCK_PREFIX = "wire-cluster-ports"
LOCK_KEY_LENGTH = 16
LOCK_DIRECTORY_SUFFIX = ".lock.lock"
LOCK_STALE_SECONDS = 30
LOCK_WAIT_SECONDS = 25
LOCK_RETRY_SECONDS = 0.1
WAITING_FOR_LOCK_LINE = "waiting-for-lock"

MAXIMUM_PID = 2_147_483_647
MINIMUM_PORT = 1
MAXIMUM_PORT = 65_535

EXIT_USAGE = 2
EXIT_PORT_HELD = 3
EXIT_LOCK_TIMEOUT = 4
EXIT_REGISTRATION_UNREADABLE = 5


class RegistrationUnreadable(Exception):
    """A live pid's registration that cannot be read or is not valid. It is never deleted."""

    def __init__(self, path, pid, cause):
        super().__init__(f"registration {path} of live pid {pid} cannot be read or is not valid: {cause}")


def node_tmpdir():
    """os.tmpdir() as Node computes it on POSIX: TMPDIR, TMP, TEMP, then /tmp."""
    path = next(
        (os.environ[name] for name in ("TMPDIR", "TMP", "TEMP") if os.environ.get(name)),
        "/tmp",
    )
    return path[:-1] if len(path) > 1 and path.endswith("/") else path


def registry_path():
    override = os.environ.get(REGISTRY_PATH_ENV_VAR)
    if override:
        return override
    return os.path.join(node_tmpdir(), REGISTRY_DIRECTORY_NAME)


def lock_directory(registry):
    key = hashlib.sha256(os.path.abspath(registry).encode()).hexdigest()[:LOCK_KEY_LENGTH]
    return os.path.join(node_tmpdir(), f"{LOCK_PREFIX}-{key}{LOCK_DIRECTORY_SUFFIX}")


def acquire_lock(directory):
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    announced = False
    while True:
        try:
            os.mkdir(directory)
            return
        except FileExistsError:
            pass
        try:
            stale = os.stat(directory).st_mtime < time.time() - LOCK_STALE_SECONDS
        except FileNotFoundError:
            continue
        if stale:
            try:
                os.rmdir(directory)
            except FileNotFoundError:
                pass
            continue
        if time.monotonic() >= deadline:
            sys.stderr.write(f"bind registry lock {directory} still held after {LOCK_WAIT_SECONDS}s\n")
            sys.exit(EXIT_LOCK_TIMEOUT)
        if not announced:
            print(WAITING_FOR_LOCK_LINE, flush=True)
            announced = True
        time.sleep(LOCK_RETRY_SECONDS)


def executable_of(pid):
    """Basename of argv[0] in /proc/<pid>/cmdline, or "" when it is unreadable."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as cmdline:
            first = cmdline.read().split(b"\0")[0]
    except OSError:
        return ""
    return os.path.basename(first.decode(errors="replace"))


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def remove_quietly(path):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def registered_port(value):
    """A port from a registration: an integer, or an integral float (JSON `20500.0`), in range; bools refused."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    port = int(value)
    return port if MINIMUM_PORT <= port <= MAXIMUM_PORT else None


def validated_registration(registration):
    """`(executable, ports)` of a parsed registration; ValueError names the first rule it breaks."""
    if not isinstance(registration, dict):
        raise ValueError("a registration must be a JSON object")
    executable = registration.get("executable")
    if not isinstance(executable, str):
        raise ValueError("executable must be a string")
    registered = registration.get("ports")
    if not isinstance(registered, list):
        raise ValueError("ports must be an array")
    ports = [registered_port(value) for value in registered]
    if None in ports:
        raise ValueError(f"ports must be integers in {MINIMUM_PORT}..{MAXIMUM_PORT}")
    if len(set(ports)) != len(ports):
        raise ValueError("ports must be distinct")
    return executable, ports


def registration_pid(name, suffix):
    """The pid in `<pid><suffix>`, or None unless it is a positive pid without a leading zero."""
    stem = name[: -len(suffix)]
    if not (stem.isascii() and stem.isdigit()) or stem.startswith("0"):
        return None
    pid = int(stem)
    return pid if pid <= MAXIMUM_PID else None


def live_registered_ports(registry, own_pid, own_written):
    """Ports of every live registration; stale files are deleted.

    This process's own file counts once it has written it. Before that, a file
    under its pid belongs to a dead process that had the same pid: it is skipped
    (never deleted) and the first write replaces it.
    """
    ports = set()
    temporary_suffix = f"{REGISTRY_FILE_SUFFIX}{TEMPORARY_FILE_SUFFIX}"
    for name in os.listdir(registry):
        path = os.path.join(registry, name)
        if name.endswith(temporary_suffix):
            pid = registration_pid(name, temporary_suffix)
            if pid is None or (pid != own_pid and not pid_alive(pid)):
                remove_quietly(path)
            continue
        if not name.endswith(REGISTRY_FILE_SUFFIX):
            continue
        pid = registration_pid(name, REGISTRY_FILE_SUFFIX)
        if pid is None or not pid_alive(pid):
            remove_quietly(path)
            continue
        if pid == own_pid and not own_written:
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                registration = json.load(handle)
            executable, registered = validated_registration(registration)
        except FileNotFoundError:
            continue  # its owner deleted it after the listing: already gone
        except (OSError, ValueError, KeyError, TypeError) as cause:
            # The owner is alive and may still hold its ports: never delete.
            raise RegistrationUnreadable(path, pid, cause) from cause
        observed = executable_of(pid)
        # Reap only when both basenames are known and differ: an empty recorded
        # one (a writer without procfs) or an empty observed one (a zombie,
        # another user's process, no procfs) keeps the file. A reader never
        # reaps its own registration.
        if pid != own_pid and observed and executable and observed != executable:
            remove_quietly(path)
            continue
        ports.update(registered)
    return ports


def write_registration(path, executable, ports):
    temporary = f"{path}{TEMPORARY_FILE_SUFFIX}"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump({"executable": executable, "ports": ports}, handle)
    os.replace(temporary, path)


def main():
    try:
        requested = [int(argument) for argument in sys.argv[1:]]
    except ValueError:
        requested = []
    if (
        not requested
        or len(set(requested)) != len(requested)
        or not all(MINIMUM_PORT <= port <= MAXIMUM_PORT for port in requested)
    ):
        sys.stderr.write(__doc__)
        return EXIT_USAGE

    pid = os.getpid()
    executable = executable_of(pid)
    registry = registry_path()
    os.makedirs(registry, exist_ok=True)
    registration_file = os.path.join(registry, f"{pid}{REGISTRY_FILE_SUFFIX}")
    lock = lock_directory(registry)

    acquire_lock(lock)
    try:
        # This client writes once, so its own file is never yet its own here.
        try:
            held = live_registered_ports(registry, pid, own_written=False)
        except RegistrationUnreadable as unreadable:
            sys.stderr.write(f"{unreadable}\n")
            return EXIT_REGISTRATION_UNREADABLE
        conflicts = sorted(held.intersection(requested))
        if conflicts:
            sys.stderr.write(f"ports held by another live registration: {conflicts}\n")
            return EXIT_PORT_HELD
        write_registration(registration_file, executable, requested)
    finally:
        os.rmdir(lock)

    print(
        json.dumps(
            {
                "pid": pid,
                "executable": executable,
                "registrationFile": registration_file,
                "lockDirectory": lock,
                "registeredPorts": sorted(held),
            }
        ),
        flush=True,
    )
    sys.stdin.read()
    remove_quietly(registration_file)
    return 0


if __name__ == "__main__":
    sys.exit(main())
