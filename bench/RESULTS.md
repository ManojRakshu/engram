# Benchmark results

Harness: claude-code · model: haiku · 48 runs (6 errored runs excluded; 1 timeouts counted as failures)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 14/14 | 106,649 | 98,223 | 9,645 | 1,578 | 4.4 | 13.6s | 0.052 |
| cold | 16/18 | 111,564 | 105,820 | 11,761 | 1,591 | 3.8 | 22.2s | 0.070 |
| warm | 16/16 | 97,861 | 91,672 | 11,305 | 1,420 | 3.6 | 13.5s | 0.061 |

Cost of a fix:

| setup | input tokens per fixed bug | $ per fixed bug | fixed bugs per hour (serial) | calls by type (mean per run) |
|---|---|---|---|---|
| baseline | 106,649 | 0.0037 | 265 | Bash 2.8, Edit 1.0, Read 0.5, Grep 0.1 |
| cold | 118,537 | 0.0044 | 153 | Bash 1.6, Read 1.1, Edit 1.0, Monitor 0.1 |
| warm | 97,861 | 0.0038 | 266 | Bash 1.6, Read 1.0, Edit 1.0 |

Per task (median input tokens / tool calls, pass count):

| task | baseline | cold | warm |
|---|---|---|---|
| sspl-level | 94,112 / 4 (3/3) | 76,359 / 2 (3/3) | 76,455 / 2 (3/3) |
| components-bfs | 98,678 / 4 (3/3) | 106,221 / 4 (3/3) | 104,211 / 4 (3/3) |
| triangles-selfloop | 101,960 / 5 (3/3) | 109,014 / 5 (3/3) | 138,003 / 4 (3/3) |
| topo-generations | 93,942 / 4 (3/3) | 105,820 / 3 (3/3) | 79,133 / 3 (3/3) |
| bellman-count | 211,657 / 8 (1/1) | 139,148 / 5 (2/3) | 122,399 / 5 (2/2) |
| dijkstra-relax | 93,038 / 3 (1/1) | 78,393 / 2.5 (2/2) | 78,334 / 2.5 (2/2) |

- **cold vs baseline:** total input tokens -5% lower on average; per-task geometric mean ratio 0.91 (9% lower); tool calls 14% fewer; cost per run -12% lower; wins on 3/6 tasks.
- **warm vs baseline:** total input tokens 8% lower on average; per-task geometric mean ratio 0.88 (12% lower); tool calls 18% fewer; cost per run -4% lower; wins on 4/6 tasks.
