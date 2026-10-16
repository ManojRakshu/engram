# Benchmark results

Harness: claude-code · model: haiku · 71 runs (1 errored runs excluded)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 22/23 | 152,436 | 112,749 | 8,772 | 1,739 | 5.5 | 17.6s | 0.093 |
| warm | 24/24 | 112,491 | 98,021 | 10,628 | 1,573 | 3.9 | 14.9s | 0.094 |
| cold | 23/24 | 102,877 | 99,667 | 10,113 | 1,209 | 3.7 | 12.1s | 0.085 |

Per task (median input tokens / tool calls, pass count):

| task | baseline | warm | cold |
|---|---|---|---|
| clamp-max | 88,722 / 3 (2/2) | 99,832 / 3 (2/2) | 99,667 / 3 (2/2) |
| clamp-open | 91,227 / 4 (2/2) | 74,965 / 2 (2/2) | 88,044 / 2.5 (2/2) |
| bool-on | 91,029 / 4 (2/2) | 97,330 / 3 (2/2) | 97,526 / 3.5 (2/2) |
| split-opt | 618,702 / 19.5 (1/2) | 336,176 / 11.5 (2/2) | 151,203 / 7 (1/2) |
| short-help | 124,999 / 5 (2/2) | 102,030 / 4.5 (2/2) | 111,411 / 4 (2/2) |
| measure-table | 117,693 / 4 (2/2) | 99,862 / 4 (2/2) | 114,512 / 4 (2/2) |
| choice-case | 89,379 / 3.5 (2/2) | 74,767 / 2.5 (2/2) | 75,189 / 2.5 (2/2) |
| envvar-auto | 89,022 / 3 (1/1) | 76,246 / 2.5 (2/2) | 89,624 / 3.5 (2/2) |
| envvar-nested | 116,527 / 4 (2/2) | 98,999 / 3 (2/2) | 99,045 / 3 (2/2) |
| eager-order | 115,411 / 5.5 (2/2) | 73,542 / 3 (2/2) | 86,504 / 4 (2/2) |
| style-bold | 110,860 / 4 (2/2) | 72,523 / 2 (2/2) | 76,161 / 2 (2/2) |
| join-options | 143,957 / 5 (2/2) | 143,627 / 6 (2/2) | 145,637 / 5 (2/2) |

- **warm vs baseline:** total input tokens 26% lower on average; per-task geometric mean ratio 0.82 (18% lower); tool calls 29% fewer; cost per run 3% lower; wins on 10/12 tasks.
- **cold vs baseline:** total input tokens 33% lower on average; per-task geometric mean ratio 0.82 (18% lower); tool calls 33% fewer; cost per run 12% lower; wins on 8/12 tasks.
