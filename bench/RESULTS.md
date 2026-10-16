# Benchmark results

Harness: claude-code · model: haiku · 23 runs (0 errored runs excluded; 0 timeouts counted as failures)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 6/6 | 110,412 | 107,721 | 10,180 | 1,386 | 4.7 | 23.0s | 0.021 |
| cbm | 6/6 | 102,816 | 107,157 | 11,195 | 813 | 4.3 | 19.7s | 0.020 |
| warm | 6/6 | 92,220 | 64,573 | 11,725 | 1,311 | 3.7 | 20.5s | 0.022 |
| cold | 5/5 | 84,362 | 82,462 | 11,147 | 912 | 2.8 | 14.8s | 0.016 |

Cost of a fix:

| setup | input tokens per fixed bug | $ per fixed bug | fixed bugs per hour (serial) | calls by type (mean per run) |
|---|---|---|---|---|
| baseline | 110,412 | 0.0034 | 157 | Bash 2.7, Read 1.0, Edit 1.0 |
| cbm | 102,816 | 0.0034 | 183 | Bash 2.8, Edit 1.0, Read 0.5 |
| warm | 92,220 | 0.0036 | 175 | Bash 2.0, Edit 1.0, Read 0.7 |
| cold | 84,362 | 0.0032 | 243 | Read 1.2, Edit 1.0, Bash 0.6 |

Per task (median input tokens / tool calls, pass count):

| task | baseline | cbm | warm | cold |
|---|---|---|---|---|
| sspl-level | 92,776 / 4 (1/1) | 124,708 / 5 (1/1) | 77,255 / 3 (1/1) | 76,765 / 2 (1/1) |
| dijkstra-relax | 68,833 / 3 (1/1) | 72,505 / 3 (1/1) | 50,914 / 3 (1/1) | 51,146 / 2 (1/1) |
| components-bfs | 97,387 / 4 (1/1) | 103,245 / 4 (1/1) | 105,449 / 4 (1/1) | 104,947 / 4 (1/1) |
| triangles-selfloop | 124,002 / 5 (1/1) | 78,176 / 5 (1/1) | 216,370 / 7 (1/1) | 82,462 / 3 (1/1) |
| topo-generations | 118,055 / 5 (1/1) | 127,192 / 5 (1/1) | 51,441 / 2 (1/1) | 106,489 / 3 (1/1) |
| bellman-count | 161,416 / 7 (1/1) | 111,069 / 4 (1/1) | 51,891 / 3 (1/1) | — |

- **cbm vs baseline:** total input tokens 7% lower on average; per-task geometric mean ratio 0.94 (6% lower); tool calls 7% fewer; cost per run 1% lower; wins on 2/6 tasks.
- **warm vs baseline:** total input tokens 16% lower on average; per-task geometric mean ratio 0.74 (26% lower); tool calls 21% fewer; cost per run -5% lower; wins on 4/6 tasks.
- **cold vs baseline:** total input tokens 24% lower on average; per-task geometric mean ratio 0.83 (17% lower); tool calls 40% fewer; cost per run 8% lower; wins on 4/5 tasks.
