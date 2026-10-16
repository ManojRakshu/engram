# Benchmark results

Harness: claude-code · model: haiku · 131 runs (13 errored runs excluded; 0 timeouts counted as failures)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 34/35 | 121,336 | 116,045 | 8,382 | 1,369 | 4.7 | 14.2s | 0.122 |
| cbm | 32/32 | 174,756 | 122,956 | 11,639 | 2,147 | 6.0 | 20.8s | 0.161 |
| warm | 34/34 | 128,103 | 99,864 | 10,788 | 1,684 | 4.6 | 16.8s | 0.142 |
| cold | 30/30 | 112,505 | 97,162 | 10,487 | 1,533 | 4.1 | 15.0s | 0.116 |

Cost of a fix:

| setup | input tokens per fixed bug | $ per fixed bug | fixed bugs per hour (serial) | calls by type (mean per run) |
|---|---|---|---|---|
| baseline | 124,904 | 0.0036 | 246 | Bash 2.9, Edit 1.0, Read 0.8 |
| cbm | 174,756 | 0.0050 | 173 | Bash 3.8, Read 1.1, Edit 1.0, Grep 0.0 |
| warm | 128,103 | 0.0042 | 214 | Bash 2.6, Read 1.0, Edit 1.0 |
| cold | 112,505 | 0.0039 | 240 | Bash 2.0, Read 1.0, Edit 1.0 |

Per task (median input tokens / tool calls, pass count):

| task | baseline | cbm | warm | cold |
|---|---|---|---|---|
| clamp-max | 89,278 / 4 (3/3) | 97,086 / 3.5 (2/2) | 98,762 / 3 (3/3) | 99,107 / 3 (3/3) |
| clamp-open | 115,281 / 5 (3/3) | 145,467 / 6 (3/3) | 75,220 / 2 (3/3) | 75,165 / 2 (3/3) |
| bool-on | 115,220 / 4 (3/3) | 121,856 / 4 (3/3) | 97,705 / 3 (3/3) | 96,111 / 3 (3/3) |
| split-opt | 138,310 / 7 (2/3) | 493,105 / 14 (3/3) | 235,526 / 11 (3/3) | 259,754 / 10 (3/3) |
| short-help | 116,045 / 4 (3/3) | 118,005 / 4 (3/3) | 305,377 / 10 (3/3) | 99,246 / 4 (3/3) |
| measure-table | 118,433 / 4 (3/3) | 124,875 / 5 (3/3) | 104,748 / 4 (3/3) | 123,840 / 4 (3/3) |
| choice-case | 135,095 / 5 (3/3) | 120,019 / 4 (3/3) | 77,034 / 3 (3/3) | 75,802 / 2 (3/3) |
| envvar-auto | 89,852 / 3 (3/3) | 94,157 / 3 (1/1) | 87,713 / 3.5 (2/2) | 76,092 / 3 (1/1) |
| envvar-nested | 95,249 / 3 (3/3) | 122,572 / 4 (3/3) | 111,154 / 4 (2/2) | — |
| style-bold | 109,110 / 4 (3/3) | 118,168 / 4 (3/3) | 77,549 / 2 (3/3) | 72,389 / 3 (3/3) |
| join-options | 143,696 / 5 (3/3) | 154,491 / 6 (3/3) | 156,857 / 6 (3/3) | 98,438 / 4 (3/3) |
| eager-order | 116,584 / 6 (2/2) | 121,099 / 5 (2/2) | 100,016 / 4 (3/3) | 98,508 / 3.5 (2/2) |

- **cbm vs baseline:** total input tokens -44% lower on average; per-task geometric mean ratio 1.19 (-19% lower); tool calls -27% fewer; cost per run -44% lower; wins on 1/12 tasks.
- **warm vs baseline:** total input tokens -6% lower on average; per-task geometric mean ratio 1.00 (-0% lower); tool calls 3% fewer; cost per run -20% lower; wins on 7/12 tasks.
- **cold vs baseline:** total input tokens 7% lower on average; per-task geometric mean ratio 0.86 (14% lower); tool calls 14% fewer; cost per run -11% lower; wins on 8/11 tasks.
