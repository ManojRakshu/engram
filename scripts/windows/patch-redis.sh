#!/usr/bin/env bash
# Patches so Redis runs well under Cygwin. Run from the Redis source directory.
set -euo pipefail
python3 - <<'PY'
def patch(path, old, new):
    s = open(path).read()
    if old not in s:
        raise SystemExit(f"{path}: pattern not found: {old!r}")
    open(path, "w").write(s.replace(old, new, 1))

# Redis's main loop is woken through pipes: by FalkorDB when a query finishes (module.c) and by its own
# background threads (bio.c). Cygwin's select() can't wait on a pipe; a helper thread polls it with growing
# sleeps, and each sleep rounds up to the Windows timer tick (~15 ms), so a query could finish long before
# Redis noticed. Sockets are event-driven there, so on Cygwin these "pipes" are socket pairs.
patch("src/anet.c", "    if (pipe_flags == 0 && pipe(fds))\n        return -1;",
      "#ifdef __CYGWIN__\n    if (pipe_flags == 0 && socketpair(AF_UNIX, SOCK_STREAM, 0, fds))\n        return -1;\n#else\n"
      "    if (pipe_flags == 0 && pipe(fds))\n        return -1;\n#endif")
PY
