# pi-usage

Token usage dashboard for [pi](https://github.com/earendil-works/pi-coding-agent) — calls, input/output/cache tokens and cost per **provider + model**, bucketed by **day / ISO week / month / all time**.

No hooks, no database, no dependencies: it reads the session files pi already writes to `~/.pi/agent/sessions/**/*.jsonl`.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│view  day · week · month · total   period 2026-W38                            │
│──────────────────────────────────────────────────────────────────────────────│
│Provider  Model          Calls    Input   Output   CacheR   CacheW    Total   │
│newapi    glm-5.3-flash    925     2.0M   360.9K   224.2M        0   226.5M   │
│newapi-ge grok-4.6        1129     7.5M     1.3M   199.2M        0   208.0M   │
│newapi-ge glm-5.3-flash    600   504.5K   133.5K   183.0M        0   183.6M   │
│──────────────────────────────────────────────────────────────────────────────│
│TOTAL     6 models        3033    10.6M     1.9M   654.4M        0   669.1M   │
│d/w/m/t view · ←/→ period · ↑/↓ scroll · r rescan · q quit                    │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Install

```bash
git clone https://github.com/chocotan/pi-usage ~/.pi/agent/extensions/pi-usage
```

(pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. Alternatively add the directory to `extensions` in `~/.pi/agent/settings.json`.)

## Usage

```
/usage            # today, day view
/usage week       # current ISO week
/usage month      # current month
/usage total      # all time
```

| Key | Action |
|---|---|
| `d` / `w` / `m` / `t` | switch day / week / month / total view |
| `←` / `→` | previous / next period (no future travel) |
| `↑` / `↓` or `j` / `k` | scroll |
| `r` | rescan session files |
| `q` / `Esc` | close |

In non-TUI modes (`pi -p "/usage total"`, JSON/RPC) the table is written to stderr instead.

## How it works

Each assistant message in pi's session JSONL carries `provider`, `model`, `timestamp` and `usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`, `totalTokens`, `cost`). pi-usage scans those lines (deduplicated by entry id), aggregates per `provider/model` × time bucket, and renders a table.

Session files are append-only, so results are cached by `(path, mtime, size)` — the first scan of a large history takes a few seconds, later opens/rescans are instant.

`Cost` shows `-` when providers don't report pricing in the session data.

## Self-test

```bash
node demo.ts          # node >= 22.18; bucket math, aggregation, live scan checks
```

## License

MIT
