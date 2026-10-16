Harness: claude-code · model: haiku · 144 runs (0 errored runs excluded; 0 timeouts counted as failures)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 36/36 | 137,600 | 114,704 | 8,717 | 1,773 | 5.1 | 16.4s | 0.131 |
| cbm | 36/36 | 126,912 | 121,922 | 9,680 | 1,255 | 4.7 | 13.4s | 0.125 |
| cold | 35/36 | 103,467 | 96,129 | 10,033 | 1,209 | 3.6 | 12.7s | 0.119 |
| warm | 35/36 | 104,347 | 98,656 | 10,045 | 1,221 | 3.8 | 13.2s | 0.120 |

Cost of a fix:

| setup | input tokens per fixed bug | $ per fixed bug | fixed bugs per hour (serial) | calls by type (mean per run) |
|---|---|---|---|---|
| baseline | 137,600 | 0.0036 | 219 | Bash 3.4, Edit 1.0, Read 0.7 |
| cbm | 126,912 | 0.0035 | 268 | Bash 2.8, Edit 1.0, Read 0.8, Grep 0.1 |
| cold | 106,424 | 0.0034 | 276 | Bash 1.7, Edit 1.0, Read 0.9 |
| warm | 107,328 | 0.0034 | 264 | Bash 1.8, Edit 1.0, Read 0.9, Write 0.0 |

Per task (median input tokens / tool calls, pass count):

| task | baseline | cbm | cold | warm |
|---|---|---|---|---|
| clamp-max | 89,360 / 3 (3/3) | 96,935 / 3 (3/3) | 73,367 / 2 (3/3) | 99,341 / 3 (3/3) |
| clamp-open | 113,711 / 4 (3/3) | 121,575 / 4 (3/3) | 75,203 / 2 (3/3) | 100,146 / 3 (3/3) |
| bool-on | 117,161 / 5 (3/3) | 121,907 / 4 (3/3) | 96,134 / 3 (3/3) | 97,692 / 3 (3/3) |
| split-opt | 190,952 / 8 (3/3) | 172,205 / 8 (3/3) | 161,617 / 7 (2/3) | 189,838 / 8 (2/3) |
| short-help | 139,893 / 5 (3/3) | 96,222 / 4 (3/3) | 75,248 / 4 (3/3) | 99,303 / 4 (3/3) |
| measure-table | 117,620 / 4 (3/3) | 127,540 / 5 (3/3) | 125,963 / 4 (3/3) | 101,458 / 4 (3/3) |
| choice-case | 112,298 / 4 (3/3) | 96,623 / 4 (3/3) | 76,181 / 2 (3/3) | 76,484 / 2 (3/3) |
| envvar-auto | 88,924 / 4 (3/3) | 95,136 / 4 (3/3) | 76,325 / 3 (3/3) | 76,580 / 3 (3/3) |
| envvar-nested | 118,931 / 4 (3/3) | 122,353 / 4 (3/3) | 99,926 / 3 (3/3) | 98,758 / 3 (3/3) |
| eager-order | 114,120 / 5 (3/3) | 120,089 / 5 (3/3) | 72,493 / 3 (3/3) | 97,398 / 5 (3/3) |
| style-bold | 108,481 / 4 (3/3) | 116,626 / 4 (3/3) | 95,101 / 3 (3/3) | 97,479 / 3 (3/3) |
| join-options | 117,850 / 4 (3/3) | 150,736 / 5 (3/3) | 97,047 / 3 (3/3) | 126,166 / 5 (3/3) |

- **cbm vs baseline:** total input tokens 8% lower on average; per-task geometric mean ratio 1.01 (-1% lower); tool calls 7% fewer; cost per run 4% lower; wins on 3/12 tasks.
- **cold vs baseline:** total input tokens 25% lower on average; per-task geometric mean ratio 0.78 (22% lower); tool calls 29% fewer; cost per run 9% lower; wins on 11/12 tasks.
- **warm vs baseline:** total input tokens 24% lower on average; per-task geometric mean ratio 0.87 (13% lower); tool calls 25% fewer; cost per run 8% lower; wins on 10/12 tasks.
