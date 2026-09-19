# pi-usage

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that shows token usage **per provider and model**, grouped by **day / ISO week / month / all time**, plus a **calendar heatmap**.

Metrics: call count, input tokens, output tokens, cache-read, cache-write, total tokens, and cost.

No hooks, no database, no extra dependencies. It reads the session files pi already writes to `~/.pi/agent/sessions/**/*.jsonl`.

```
╭──────────────────────────────────────────────────────────────────────────────╮
│view  day · week · month · total · cal   period 2026-W38                      │
│──────────────────────────────────────────────────────────────────────────────│
│Provider  Model          Calls    Input   Output   CacheR   CacheW    Total   │
│newapi    glm-5.3-flash    925     2.0M   360.9K   224.2M        0   226.5M   │
│newapi-ge grok-4.6        1129     7.5M     1.3M   199.2M        0   208.0M   │
│newapi-ge glm-5.3-flash    600   504.5K   133.5K   183.0M        0   183.6M   │
│──────────────────────────────────────────────────────────────────────────────│
│TOTAL     6 models        3033    10.6M     1.9M   654.4M        0   669.1M   │
│d/w/m/t/c view · ←/→ period · ↑/↓ scroll · r rescan · q quit                  │
╰──────────────────────────────────────────────────────────────────────────────╯
```

## Install

```bash
git clone https://github.com/chocotan/pi-usage ~/.pi/agent/extensions/pi-usage
```

pi auto-discovers `~/.pi/agent/extensions/*/index.ts`. Restart pi (or `/reload`) after cloning.

Alternatively, add the directory to `extensions` in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-usage"]
}
```

## Usage

In the pi TUI:

```
/usage            # today, day view
/usage week       # current ISO week
/usage month      # current month
/usage total      # all time
/usage cal        # calendar heatmap
```

| Key | Action |
|---|---|
| `d` / `w` / `m` / `t` / `c` | switch day / week / month / total / calendar |
| `←` / `→` | previous / next period (calendar jumps 4 weeks; no future travel) |
| `↑` / `↓` or `j` / `k` | scroll the table |
| `r` | rescan session files |
| `q` / `Esc` | close |

Non-TUI modes (`pi -p "/usage total"`, JSON/RPC) print the same table to stderr.

## Calendar heatmap

Press `c` (or `/usage cal`) for a GitHub-style heatmap of total tokens per day. Shade is relative to the peak day in the visible window.

```
│    Feb   Mar       Apr     May     Jun       Jul     Aug     Sep             │
│Mon ·························································▒▒··░░▒▒▒▒··     │
│Wed ·······················································██▒▒░░▒▒░░░░       │
│Fri ·························································▒▒░░▒▒░░░░░░     │
│less ·░▒▓█ more · peak 991.1M (2026-08-30) · window 11.1B                     │
```

`←` / `→` jump four weeks at a time. Days after today stay blank.

## How it works

Each assistant message in pi's session JSONL includes `provider`, `model`, `timestamp`, and `usage`:

```json
{
  "provider": "newapi-ge",
  "model": "kimi-k3",
  "timestamp": 1789814132214,
  "usage": {
    "input": 18131,
    "output": 367,
    "cacheRead": 4352,
    "cacheWrite": 0,
    "reasoning": 233,
    "totalTokens": 22850,
    "cost": { "total": 0 }
  }
}
```

pi-usage scans those lines (deduplicated by entry id), aggregates per `provider/model` × time bucket, and renders a table or heatmap.

Session files are append-only, so results are cached by `(path, mtime, size)`. Later opens and `r` only re-parse changed files. Scanning runs in async batches with a live progress line, so the TUI does not freeze on a large history.

`Cost` shows `-` when the provider did not report pricing in the session data.

## Self-test

Requires Node.js >= 22.18 (native TypeScript stripping).

```bash
node demo.ts
```

Checks ISO-week math, month-end cursor shift, aggregation, calendar layout, formatting, and a live scan of `~/.pi/agent/sessions`.

## License

MIT
