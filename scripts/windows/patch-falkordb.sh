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
# Cygwin's <ctype.h> macros index a table with a char; libcypher-parser builds with -Wall -Werror.
patch("build.sh", 'CFLAGS="-fPIC -O3 -g -DYY_BUFFER_SIZE=1048576"', 'CFLAGS="-fPIC -O3 -g -DYY_BUFFER_SIZE=1048576 -Wno-error=char-subscripts"')
# Cygwin has glibc's <endian.h> (htobe64/be64toh) and pthread_setname_np, but defines neither
# __linux__ nor __APPLE__.
patch("src/bolt/endian.h", "#if defined ( __linux__ ) || defined ( __GNU__ )", "#if defined ( __linux__ ) || defined ( __GNU__ ) || defined ( __CYGWIN__ )")
patch("src/util/thpool/thpool.c", "#elif defined(__APPLE__) && defined(__MACH__)\n\tpthread_setname_np(thread_name);",
      "#elif defined(__APPLE__) && defined(__MACH__)\n\tpthread_setname_np(thread_name);\n#elif defined(__CYGWIN__)\n\tpthread_setname_np(pthread_self(), thread_name);")
# VectorSimilarity fetches google/cpu_features, which knows Linux/macOS/Windows but not Cygwin.
# Cygwin has a Linux-style /proc/cpuinfo, so the Linux x86 backend works as is: use a local,
# patched copy instead of the fetched one.
import os, subprocess
cf = os.path.abspath("deps/cpu_features")
if not os.path.isdir(cf):
    subprocess.run(["git", "clone", "-q", "https://github.com/google/cpu_features.git", cf], check=True)
    subprocess.run(["git", "-C", cf, "checkout", "-q", "438a66e41807cd73e0c403966041b358f5eafc68"], check=True)
patch(f"{cf}/include/cpu_features_macros.h", "#if defined(__linux__) && !defined(CPU_FEATURES_OS_FREEBSD)",
      "#if (defined(__linux__) || defined(__CYGWIN__)) && !defined(CPU_FEATURES_OS_FREEBSD)")
patch("deps/RediSearch/deps/VectorSimilarity/cmake/cpu_features.cmake",
      "GIT_REPOSITORY  https://github.com/google/cpu_features.git\n\tGIT_TAG  438a66e41807cd73e0c403966041b358f5eafc68",
      f"SOURCE_DIR  {cf}")
# quickjs: Cygwin declares malloc_usable_size in <malloc.h>, which quickjs only includes on Linux.
patch("deps/quickjs/quickjs.c", "#elif defined(__linux__) || defined(__GLIBC__)\n#include <malloc.h>",
      "#elif defined(__linux__) || defined(__GLIBC__) || defined(__CYGWIN__)\n#include <malloc.h>")
# RediSearch's readies helper adds the same ELF-only flags to its own shared build.
patch("deps/RediSearch/deps/readies/cmake/cc", '    add_target_linker_flags(${TARGET} "-Wl,--enable-new-dtags -Wl,-rpath,\\$ORIGIN")',
      '    if (NOT CYGWIN)\n        add_target_linker_flags(${TARGET} "-Wl,--enable-new-dtags -Wl,-rpath,\\$ORIGIN")\n    endif()')
# The Linux debug-symbol split (objcopy --add-gnu-debuglink + strip) leaves a DLL Windows won't load.
patch("CMakeLists.txt", 'if(UNIX AND NOT APPLE AND (CMAKE_BUILD_TYPE', 'if(UNIX AND NOT APPLE AND NOT CYGWIN AND (CMAKE_BUILD_TYPE')
# RediSearch carries its own copy of the same thread pool.
patch("deps/RediSearch/deps/thpool/thpool.c", "#elif defined(__APPLE__) && defined(__MACH__)\n  pthread_setname_np(thread_name);",
      "#elif defined(__APPLE__) && defined(__MACH__)\n  pthread_setname_np(thread_name);\n#elif defined(__CYGWIN__)\n  pthread_setname_np(pthread_self(), thread_name);")
print("patched")
PY
