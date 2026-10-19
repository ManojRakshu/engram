#!/usr/bin/env bash
# Small patches so FalkorDB's own build.sh builds under Cygwin. Run from the FalkorDB checkout.
set -euo pipefail
python3 - <<'PY'
def patch(path, old, new):
    s = open(path).read()
    if old not in s:
        raise SystemExit(f"{path}: pattern not found: {old!r}")
    open(path, "w").write(s.replace(old, new, 1))

# Cygwin is treated like Linux (same autotools/cmake paths, OpenSSL from the system).
patch("build.sh", "        Linux*)\n            OS=\"linux\"", "        Linux*|CYGWIN*)\n            OS=\"linux\"")
# The Rust part is built beforehand for x86_64-pc-cygwin (needs nightly + build-std).
patch("build.sh", "build_falkordbrs() {\n", "build_falkordbrs() {\n    [[ -f \"$FalkorDBRS\" ]] && return 0\n")
# ELF-only linker flags; Windows DLLs resolve their own symbols anyway.
patch("CMakeLists.txt", '    else()\n        target_link_options(${TARGET} PRIVATE "-Wl,--enable-new-dtags"',
      '    elseif(NOT CYGWIN)\n        target_link_options(${TARGET} PRIVATE "-Wl,--enable-new-dtags"')
patch("CMakeLists.txt", "if(NOT APPLE)\n    set(CMAKE_SHARED_LINKER_FLAGS \"${CMAKE_SHARED_LINKER_FLAGS} -Wl,-Bsymbolic",
      "if(NOT APPLE AND NOT CYGWIN)\n    set(CMAKE_SHARED_LINKER_FLAGS \"${CMAKE_SHARED_LINKER_FLAGS} -Wl,-Bsymbolic")
# Cygwin's <ctype.h> macros index a table with a char; libcypher-parser builds with -Werror.
patch("build.sh", 'CFLAGS="-fPIC -O3 -g -DYY_BUFFER_SIZE=1048576"', 'CFLAGS="-fPIC -O3 -g -DYY_BUFFER_SIZE=1048576 -Wno-char-subscripts"')
print("patched")
PY
