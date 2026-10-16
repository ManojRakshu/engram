# Benchmark results

Harness: claude-code · model: haiku · 108 runs (0 errored runs excluded; 0 timeouts counted as failures)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 36/36 | 119,242 | 114,023 | 7,943 | 1,325 | 4.5 | 12.4s | 0.121 |
| warm | 35/36 | 135,575 | 97,992 | 10,791 | 1,745 | 4.8 | 14.9s | 0.154 |
| cold | 35/36 | 106,572 | 97,648 | 9,934 | 1,265 | 3.9 | 12.1s | 0.129 |

Cost of a fix:

| setup | input tokens per fixed bug | $ per fixed bug | fixed bugs per hour (serial) | calls by type (mean per run) |
|---|---|---|---|---|
| baseline | 119,242 | 0.0034 | 290 | Bash 2.8, Edit 1.0, Read 0.7 |
| warm | 139,449 | 0.0044 | 234 | Bash 2.7, Read 1.1, Edit 1.0 |
| cold | 109,617 | 0.0037 | 289 | Bash 1.8, Read 1.1, Edit 1.0 |

Per task (median input tokens / tool calls, pass count):

| task | baseline | warm | cold |
|---|---|---|---|
| clamp-max | 89,211 / 3 (3/3) | 98,335 / 3 (3/3) | 100,002 / 3 (3/3) |
| clamp-open | 91,405 / 4 (3/3) | 73,665 / 2 (3/3) | 73,826 / 3 (3/3) |
| bool-on | 113,680 / 4 (3/3) | 96,870 / 3 (3/3) | 121,362 / 4 (3/3) |
| split-opt | 192,738 / 10 (3/3) | 634,384 / 21 (2/3) | 166,019 / 6 (2/3) |
| short-help | 111,871 / 4 (3/3) | 72,828 / 4 (3/3) | 74,379 / 5 (3/3) |
| measure-table | 116,990 / 4 (3/3) | 125,529 / 4 (3/3) | 101,747 / 4 (3/3) |
| choice-case | 112,724 / 4 (3/3) | 76,517 / 3 (3/3) | 74,589 / 2 (3/3) |
| envvar-auto | 89,909 / 3 (3/3) | 75,486 / 3 (3/3) | 74,937 / 3 (3/3) |
| envvar-nested | 115,501 / 4 (3/3) | 97,648 / 4 (3/3) | 96,747 / 3 (3/3) |
| eager-order | 115,260 / 5 (3/3) | 124,456 / 5 (3/3) | 97,052 / 4 (3/3) |
| style-bold | 86,439 / 3 (3/3) | 75,766 / 3 (3/3) | 94,334 / 3 (3/3) |
| join-options | 125,188 / 6 (3/3) | 128,880 / 6 (3/3) | 124,256 / 4 (3/3) |

- **warm vs baseline:** total input tokens -14% lower on average; per-task geometric mean ratio 0.98 (2% lower); tool calls -7% fewer; cost per run -27% lower; wins on 7/12 tasks.
- **cold vs baseline:** total input tokens 11% lower on average; per-task geometric mean ratio 0.88 (12% lower); tool calls 14% fewer; cost per run -7% lower; wins on 9/12 tasks.
