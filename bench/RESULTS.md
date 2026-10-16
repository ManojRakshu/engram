# Benchmark results

Harness: claude-code · model: haiku · 62 runs (1 errored runs excluded)

| setup | pass | mean input tok | median input tok | mean uncached in | mean output | mean tool calls | mean time | total $ |
|---|---|---|---|---|---|---|---|---|
| baseline | 19/20 | 156,851 | 109,928 | 8,900 | 1,830 | 5.6 | 18.3s | 0.083 |
| warm | 19/19 | 118,389 | 99,189 | 10,953 | 1,750 | 4.1 | 16.0s | 0.079 |
| cold | 22/23 | 102,766 | 99,641 | 10,047 | 1,208 | 3.7 | 12.0s | 0.081 |

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
| envvar-auto | 89,022 / 3 (1/1) | 76,672 / 3 (1/1) | 89,624 / 3.5 (2/2) |
| envvar-nested | 116,527 / 4 (2/2) | 99,365 / 3 (1/1) | 99,045 / 3 (2/2) |
| eager-order | 116,349 / 6 (1/1) | 74,118 / 3 (1/1) | 86,504 / 4 (2/2) |
| style-bold | 108,971 / 4 (1/1) | 71,756 / 2 (1/1) | 76,161 / 2 (2/2) |
| join-options | 146,118 / 5 (1/1) | 157,566 / 6 (1/1) | 185,860 / 6 (1/1) |

- **warm vs baseline:** total input tokens 25% lower on average; per-task geometric mean ratio 0.83 (17% lower); tool calls 27% fewer; cost per run 1% lower; wins on 9/12 tasks.
- **cold vs baseline:** total input tokens 34% lower on average; per-task geometric mean ratio 0.84 (16% lower); tool calls 35% fewer; cost per run 15% lower; wins on 8/12 tasks.
