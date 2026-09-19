/**
 * pi-usage — token usage dashboard for pi.
 *
 * `/usage [day|week|month|total]` opens a table of calls / input / output /
 * cache-read / cache-write / total tokens / cost per provider+model,
 * bucketed by day, ISO week, month, or all time.
 *
 * Keys: d/w/m/t switch view · ←/→ previous/next period · ↑/↓ or j/k scroll ·
 *       r rescan · q/Esc close.
 *
 * Data source: ~/.pi/agent/sessions/*\/*.jsonl (assistant message usage
 * entries). Read-only; files are append-only so results are cached by
 * (path, mtime, size) and `r` only re-parses changed files.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	aggregate,
	bucketOf,
	defaultSessionsDir,
	fmtCost,
	fmtNum,
	GRANS,
	renderTextTable,
	scanSessions,
	shiftCursor,
	totals,
	type Agg,
	type Gran,
	type Rec,
} from "./stats.ts";

const padRight = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const padLeft = (s: string, w: number): string => " ".repeat(Math.max(0, w - visibleWidth(s))) + s;

class UsageComponent implements Component {
	private tui: TUI;
	private theme: any;
	private done: (v: null) => void;
	private recs: Rec[] = [];
	private scanning = true;
	private gran: Gran;
	private cursor: Date = new Date();
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tui: TUI, theme: any, done: (v: null) => void, gran: Gran) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.gran = gran;
		// scan (~seconds on first run) off the UI path; re-render when done
		setTimeout(() => {
			this.recs = scanSessions(defaultSessionsDir());
			this.scanning = false;
			this.invalidate();
			this.tui.requestRender();
		}, 0);
	}

	private setGran(g: Gran): void {
		if (g === this.gran) return;
		this.gran = g;
		this.cursor = new Date();
		this.scroll = 0;
		this.invalidate();
	}

	private move(dir: number): void {
		if (this.gran === "total") return;
		const next = shiftCursor(this.cursor, this.gran, dir);
		if (next.getTime() > Date.now()) return; // no future travel
		this.cursor = next;
		this.scroll = 0;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "d")) this.setGran("day");
		else if (matchesKey(data, "w")) this.setGran("week");
		else if (matchesKey(data, "m")) this.setGran("month");
		else if (matchesKey(data, "t")) this.setGran("total");
		else if (matchesKey(data, Key.left)) this.move(-1);
		else if (matchesKey(data, Key.right)) this.move(1);
		else if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			if (this.scroll > 0) {
				this.scroll--;
				this.invalidate();
			}
		} else if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scroll++;
			this.invalidate();
		} else if (matchesKey(data, "r")) {
			this.scanning = true;
			setTimeout(() => {
				this.recs = scanSessions(defaultSessionsDir());
				this.scanning = false;
				this.invalidate();
				this.tui.requestRender();
			}, 0);
			this.invalidate();
		}
	}

	private bucketLabel(): string {
		return this.gran === "total" ? "all time" : bucketOf(this.cursor.getTime(), this.gran);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const rows = aggregate(this.recs, this.gran, this.bucketLabel());
		const sum = totals(rows);
		const innerW = Math.max(20, width - 2);

		// column widths
		const pw = Math.min(18, Math.max(8, ...rows.map((r) => r.p.length)));
		const mw = Math.min(26, Math.max(5, ...rows.map((r) => r.m.length)));
		const numW = 8;
		const callsW = 6;
		const costW = 8;

		const header =
			padRight("Provider", pw) + " " + padRight("Model", mw) + " " +
			padLeft("Calls", callsW) + " " + padLeft("Input", numW) + " " +
			padLeft("Output", numW) + " " + padLeft("CacheR", numW) + " " +
			padLeft("CacheW", numW) + " " + padLeft("Total", numW) + " " +
			padLeft("Cost", costW);

		const fmtRow = (a: Agg): string =>
			padRight(truncateToWidth(a.p, pw, ""), pw) + " " +
			padRight(truncateToWidth(a.m, mw, ""), mw) + " " +
			padLeft(String(a.calls), callsW) + " " +
			padLeft(fmtNum(a.i), numW) + " " + padLeft(fmtNum(a.o), numW) + " " +
			padLeft(fmtNum(a.cr), numW) + " " + padLeft(fmtNum(a.cw), numW) + " " +
			padLeft(fmtNum(a.t), numW) + " " + padLeft(fmtCost(a.c), costW);

		// viewport: overlay maxHeight is 80% of terminal; keep chrome lines
		const maxLines = Math.max(6, Math.floor(this.tui.terminal.rows * 0.8) - 6);
		const maxScroll = Math.max(0, rows.length - maxLines);
		if (this.scroll > maxScroll) this.scroll = maxScroll;
		const visible = rows.slice(this.scroll, this.scroll + maxLines);

		const tabs = GRANS.map((g) =>
			g === this.gran ? th.fg("accent", th.bold(` ${g} `)) : th.fg("muted", ` ${g} `),
		).join(th.fg("dim", "·"));

		const lines: string[] = [
			th.fg("muted", "view ") + tabs + th.fg("muted", "  period ") +
				th.fg("accent", this.bucketLabel()),
			th.fg("dim", "─".repeat(innerW)),
			th.bold(header),
		];

		if (this.scanning) {
			lines.push(th.fg("muted", "Scanning sessions…"));
		} else if (rows.length === 0) {
			lines.push(th.fg("muted", "No usage recorded for this period."));
		} else {
			for (const r of visible) lines.push(fmtRow(r));
			lines.push(th.fg("dim", "─".repeat(innerW)));
			lines.push(th.bold(fmtRow({ ...sum, p: "TOTAL", m: `${rows.length} models` })));
			if (maxScroll > 0) {
				lines.push(th.fg("dim", `${this.scroll + 1}-${this.scroll + visible.length} of ${rows.length}`));
			}
		}
		lines.push(
			th.fg("dim", "d/w/m/t view · ←/→ period · ↑/↓ scroll · r rescan · q quit"),
		);

		// box it: full-width padded lines so the overlay composites opaquely
		const boxed = [
			th.fg("border", "╭" + "─".repeat(innerW) + "╮"),
			...lines.map((l) => th.fg("border", "│") + padRight(l, innerW) + th.fg("border", "│")),
			th.fg("border", "╰" + "─".repeat(innerW) + "╯"),
		];

		this.cachedLines = boxed.map((l) => truncateToWidth(l, width));
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function parseGran(args: string | undefined): Gran {
	const a = (args ?? "").trim().toLowerCase();
	return (GRANS as string[]).includes(a) ? (a as Gran) : "day";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Token usage per provider/model — /usage [day|week|month|total]",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			const gran = parseGran(args);
			if (ctx.mode !== "tui") {
				// UI methods are no-ops in print/json mode — write the table to stderr
				const recs = scanSessions(defaultSessionsDir());
				const bucket = gran === "total" ? null : bucketOf(Date.now(), gran);
				process.stderr.write(
					`pi-usage · ${gran} · ${bucket ?? "all time"}\n` +
						renderTextTable(aggregate(recs, gran, bucket)) + "\n",
				);
				return;
			}
			await ctx.ui.custom<null>(
				(tui, theme, _kb, done) => new UsageComponent(tui, theme, done, gran),
				{ overlay: true, overlayOptions: { width: "92%", maxHeight: "80%" } },
			);
		},
	});
}
