# Bind registry protocol

Several processes on one host claim ports at the same time: concurrent `wire-cluster-tool` and
`flow-*` runs, jest workers, and wire-sysio's test-port leases. They coordinate through the bind
registry: a directory holding one JSON file per process, plus a lock taken while a process reads
the directory and writes its own file. A port named in a live process's file is not handed out to
anyone else.

`BindConfigProvider` (`packages/cluster-tool/src/config/BindConfigProvider.ts`) is the Node
implementation. The protocol is language-neutral, so other clients can take part without Node.
This page is the specification a non-Node client implements.
`packages/cluster-tool/tests/config/BindRegistryPythonClient.test.ts` runs a Python client
([`register_ports.py`](../../packages/cluster-tool/tests/fixtures/bind-registry/register_ports.py))
against `BindConfigProvider` in every test run, so the two implementations cannot drift. The same
suite can run against another client: see [section 8](#8-running-the-interop-suite-against-your-client).

| File | What it is |
|---|---|
| [`bind-registration.schema.json`](bind-registration.schema.json) | JSON Schema (draft 2020-12) of a registration file, generated from the zod schema |
| [`bind-registration.example.json`](bind-registration.example.json) | A registration file as a Python client writes it |

## 1. Temp directory

Every path below starts from the temp directory, resolved the way Node's `os.tmpdir()` resolves
it on Linux and macOS:

1. the first of the environment variables `TMPDIR`, `TMP` and `TEMP` that is set and not empty;
2. otherwise `/tmp`;
3. then one trailing `/` is removed, unless the whole value is `/`.

Python's `tempfile.gettempdir()` is not equivalent. It checks `TEMP` before `TMP`, and it falls
back to other directories. Implement the steps above directly.

## 2. Registry directory

- `$WIRE_BIND_REGISTRY_PATH` when the variable is set and not empty. Tests use it to give each
  suite a private registry.
- Otherwise `<tmpdir>/wire-platform-bind-config`.

Create the directory if it is missing (`mkdir -p`).

## 3. Lock

One lock serializes every read-and-write of the registry. It is a `proper-lockfile` lock, which
is a directory created with `mkdir`:

```
<tmpdir>/wire-cluster-ports-<key>.lock.lock
```

- `<key>` is the first 16 lowercase hex characters of the SHA-256 of the registry directory's
  absolute, normalized path, UTF-8 encoded. Node uses `path.resolve(registry)`; Python's
  `os.path.abspath(registry)` gives the same string for any ordinary path.
- The lock directory is in the temp directory, not inside the registry. The default registry
  gives every process on the host the same lock. A registry set by `WIRE_BIND_REGISTRY_PATH`
  gets its own lock.

**Acquire.** Loop:

1. `mkdir <lock>`. If it succeeds, you hold the lock.
2. If it fails with `EEXIST`, `stat` the lock directory. If it vanished in between, go to 1.
3. If its mtime is more than **30 seconds** in the past, the holder is dead: `rmdir` it (ignore
   `ENOENT`) and go to 1.
4. Otherwise wait and retry. Bound the total wait. Node retries 8 times with exponential backoff
   from 100 ms (about 25.5 s in all) and then fails with "Lock file is already being held". A
   client waiting about 25 s with 100 ms sleeps behaves the same way. When the wait runs out,
   fail loudly; never proceed without the lock.

**Hold.** Keep the lock only while you read the registry, choose ports and write your file. That
takes milliseconds. A Node holder refreshes the lock's mtime every 15 seconds, so a live holder
never looks stale. A client that may hold the lock for more than 15 seconds must do the same
(`utime` the lock directory), or another process will take the lock away from it after 30 seconds.

**Release.** `rmdir <lock>`.

## 4. Registration file

Each process writes at most one file, named after its own pid:

```
<registry>/<pid>.bind-config.json
```

The content is a JSON object with at least these members (readers ignore any others):

| Member | Type | Meaning |
|---|---|---|
| `executable` | string | Basename of the owner's executable as a reader observes it: the first NUL-separated field of `/proc/<pid>/cmdline`, reduced to its basename. Empty when `/proc` is not available; readers then skip the recycled-pid comparison. |
| `ports` | array of integers, each 1–65535, no repeats | Every port the owner holds and has not released. Write integers; a reader also accepts an integral float such as `20500.0` (JavaScript parses it as `20500`), and refuses booleans and fractions. |

[`bind-registration.example.json`](bind-registration.example.json) is a file written by the
Python test client.

Take `executable` from `/proc/self/cmdline`, not from `sys.executable` or `realpath`. Readers
compare it with what they read from `/proc/<pid>/cmdline`, which is `argv[0]` as the process was
started (`python3`, not `/usr/bin/python3.13`).

**Write it atomically, under the lock:** write the whole document to
`<registry>/<pid>.bind-config.json.tmp`, then `rename` it over
`<registry>/<pid>.bind-config.json`. Readers never parse a `.bind-config.json.tmp` file (they
only delete one whose writer is dead, section 5), so they never see a partial file.

**First write replaces, later writes merge.** A file already at `<registry>/<pid>.bind-config.json`
before your process's first write is not yours: it was left by a dead process that had the same
pid. Overwrite it with your ports; never merge it. After your first write, to add ports read your
own file, merge, and rewrite it the same way under the lock.

**Delete it** when the ports are no longer in use: after every process that binds them has exited.
No lock is needed for the delete. Node deletes its file in its `exit` handler.

## 5. Reading the registry

Under the lock, for every entry of the registry directory whose name ends in `.bind-config.json`:

1. The name minus the suffix must be a pid: decimal digits only, no sign, no leading zero, value
   1–2147483647 (`pid_t` is a signed 32-bit integer). Anything else (`0`, `007`, `123abc`, a
   20-digit number) is not a registration: **delete the file**. Pid 0 matters most:
   `kill(0, 0)` signals your own process group and always succeeds, so a `0` file would never die.
   If the pid is not alive (`kill(pid, 0)` fails with `ESRCH`), **delete the file**. `EPERM`
   means the pid is alive.
2. If the pid is your own and you have not written your file yet, skip the file (do not delete
   it); your first write replaces it (section 4).
3. Read and parse the file. If it vanished since the listing (`ENOENT`), its owner deleted it:
   skip it. If it cannot be read, is not JSON, or does not validate (`executable` a string,
   `ports` an array of distinct integers in 1–65535), **do not delete it**: the pid is alive and
   may still hold its ports. Fail the whole read loudly, naming the file, the pid and the read or
   validation error, and hand the caller an error rather than a set of ports.
4. Read `/proc/<pid>/cmdline` and take the basename of its first NUL-separated field. Delete the
   file only when that basename **and** the recorded `executable` are both non-empty and differ:
   the pid was reused by another program. When either is empty or unknown, skip the comparison
   and keep the file. An empty observed basename covers another user's process, a zombie (its
   `cmdline` reads back empty) and a host without procfs; an empty recorded one is a writer that
   could not read its own `/proc`. A reader never reaps its own registration: its own pid cannot
   have been recycled while it runs, so it skips this comparison for its own file.
5. Otherwise add its `ports` to the exclusion set. **This includes your own file** once you have
   written it: Node relies on it, because the in-process port locks that keep one resolve's ports
   from the next expire, and the registration is what keeps them out after that.

Also delete every `<pid>.bind-config.json.tmp` whose pid fails the checks in step 1, or whose
pid is dead: it is a temp file a writer left when it died between writing and renaming.

### When a live registration cannot be read

Step 3 means one live process's unreadable or invalid file stops every lease and resolve on the
host that shares the registry, until it goes away. The error names the file and its pid:

1. Find the owner: `ps -p <pid> -o pid,user,etime,args`.
2. Wait for it to finish, or stop it. Its file goes when it exits; the next reader deletes the
   file of a dead pid.
3. The usual cause is an older harness, one that writes the previous array format, running a flow
   from another checkout. Update that checkout, or let its run finish.
4. A file of another user's process in the shared `/tmp` that you may not read fails the same
   way. Ask its owner, or wait for that process to exit.
5. To keep working meanwhile, point `WIRE_BIND_REGISTRY_PATH` at a private directory. That
   gives up cross-process safety with every process using the shared registry: neither side sees
   the other's ports, so concurrent clusters can collide. Use it only when the blocking process
   is not starting clusters on this host.

## 6. Ports a client must never take

`BindConfigProvider.claimResolved` (a relaunch with `wire-cluster-tool run`) checks and registers
only the ports of daemons bound on this host. A daemon address counts as another host's only when
it is an IP literal that is not a wildcard, not loopback and not one of this host's interface
addresses; every host name counts as local. Give remote outpost endpoints in a `--bind-config` as
IP literals, or their ports are checked and registered here.

- every port in a live registration (section 5);
- **8000–10000 inclusive** (`BindConfigProvider.ReservedAgavePortBand`). Agave validators bind
  sockets in this range whatever their flags say. Node seeds every exclusion set with it, so it is
  never handed out by any path.

Node's automatic service allocation excludes the host's observed automatic client-port ranges,
including the implicit Solana RPC WebSocket companion and validator dynamic windows. It fails
closed if those ranges cannot be read or the safe pool is exhausted, rather than accepting a
kernel-assigned fallback. Explicit caller pins and persisted bindings are still honored subject
to availability and registry checks; they do not promise automatic client-port isolation.
A client that picks its own ports should likewise avoid the host's automatic client-port ranges
(`/proc/sys/net/ipv4/ip_local_port_range` on Linux), because any socket bound to port 0 on the
host can receive one of those ports while the client is not yet listening on it. That is client
policy, not a change to the registration protocol.

Before writing a port into its file, a client should check that the port binds: TCP on the IPv4
and IPv6 wildcards, and UDP as well for a port a UDP socket will use. That is what Node does.
Ports a client chose in one session must also be distinct from each other.

## 7. Summary for a client

1. Resolve the temp directory, the registry directory and the lock path (sections 1–3).
2. Acquire the lock with a bounded wait.
3. Read the registry, deleting stale files, and build the exclusion set (sections 5–6).
4. Choose ports outside the exclusion set and check that they bind.
5. Write `<registry>/<pid>.bind-config.json` atomically with your `executable` and `ports`.
6. Release the lock.
7. Delete your file once nothing binds those ports any more.

## 8. Running the interop suite against your client

Set `WIRE_BIND_REGISTRY_PYTHON_CLIENT` to an executable and the interop suite runs it in place of
the fixture:

```bash
WIRE_BIND_REGISTRY_PYTHON_CLIENT=/path/to/your-client \
  NODE_OPTIONS=--experimental-vm-modules npx jest packages/cluster-tool/tests/config/BindRegistryPythonClient.test.ts
```

Unset or empty, the suite runs `python3 register_ports.py`. The executable must follow the
fixture's contract:

- **The spawned process is the owner.** The process the suite spawns must itself take the lock
  and write the registration: the file is named after its pid, and the suite checks that pid.
  Never fork a child to do the work; a wrapper script must `exec` the real client.
- **`executable`** is the basename of that process's argv[0] as `/proc/<pid>/cmdline` reports it.
  A shebang script is fine: `#!/usr/bin/env python3` leaves `python3` as argv[0].
- **The registration's `ports`** are exactly the requested ports, in the order given on the
  command line.

- **Arguments:** one or more ports, as decimal integers. Nothing else.
- **Environment:** the registry directory and temp directory as sections 1–2 (the suite sets
  `WIRE_BIND_REGISTRY_PATH`, and in one test sets it empty with `TMPDIR` pointing at a scratch
  directory).
- **Behavior:** acquire the lock (section 3), read the registry deleting stale entries (section 5),
  refuse if any requested port is held by another live registration, write the registration with
  exactly the requested ports (section 4), release the lock.
- **Stdout:** if the lock is held at the first attempt, the line `waiting-for-lock`, once. Then,
  after the registration is written and the lock released, one JSON line:

  ```json
  {"pid": 1234, "executable": "python3", "registrationFile": "<registry>/1234.bind-config.json",
   "lockDirectory": "<tmpdir>/wire-cluster-ports-<key>.lock.lock", "registeredPorts": [10890]}
  ```

  `pid` is the registering process (the file's owner), `executable` the value written to the file,
  and `registeredPorts` the ports held by other live registrations. Print nothing else on stdout;
  diagnostics go to stderr.
- **Then:** hold the registration until stdin reaches EOF, delete the registration file, and exit.
- **Exit codes:** 0 released after stdin EOF; 2 usage error; 3 a requested port is held by another
  live registration (no file written); 4 the lock could not be taken within the bounded wait;
  5 a live process's registration cannot be read or is not valid (section 5 step 3: that file is
  kept, the error goes to stderr naming it, and nothing is written).

## Regenerating the JSON Schema

The zod schema in `packages/cluster-tool-shared/src/config/BindRegistration.ts` is the source.
After changing it:

```bash
pnpm build
./scripts/generate-json-schemas.mjs          # rewrites every committed schema under docs/
./scripts/generate-json-schemas.mjs --check  # exit 1 when a committed schema is stale
```

`pnpm test` fails while the committed schema differs from the source.
