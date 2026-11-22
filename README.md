[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/anchorite2006/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/anchorite2006/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# site-generator-speed

A fast, dependency-free static site generator: it builds a whole site from
Markdown sources with front matter, a small template dialect, tags, and
paginated indexes, producing byte-identical output to the house reference
(makefun-site 1.0.0) at a fraction of its CPU time. Speed comes from a
single-pass Markdown renderer with run-based escaping, an ASCII fast-path
slugifier, and templates compiled to native JavaScript functions.

Run it locally with Node 22+:

```sh
node main.ts
```

`main.ts` reads cases from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`) and
writes answers to `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`).
