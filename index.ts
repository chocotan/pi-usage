/**
 * pi-usage — token usage dashboard for pi.
 *
 * `/usage [day|week|month|total|cal]` opens a table of calls / input /
 * output / cache-read / cache-write / total tokens / cost per provider+model,
 * bucketed by day, ISO week, month, all time — or a calendar heatmap.
 *
 * Keys: d/w/m/t/c switch view · ←/→ previous/next period · ↑/↓ or j/k scroll ·
 *       r rescan · q/Esc close.
 *
 * Data source: ~/.pi/agent/sessions/*\/*.jsonl (assistant message usage
 * entries). Read-only; files are append-only so results are cached by
 * (path, mtime, size). Scanning is async (batched file reads) so the TUI
 * never freezes; `r` only re-parses changed files.
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
	dayTotals,
	defaultSessionsDir,
	fmtCost,
	fmtNum,
	renderCalendar,
	renderTextTable,
	scanSessions,
	scanSessionsAsync,
	shiftCursor,
	totals,
	type Agg,
	type Gran,
	type Rec,
} from "./stats.ts";

type View = Gran | "cal";
const VIEWS: View[] = ["day", "week", "month", "total", "cal"];

const padRight = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const padLeft = (s: string, w: number): string => " ".repeat(Math.max(0, w - visibleWidth(s))) + s;

class UsageComponent implements Component {
	private tui: TUI;
	private theme: any;
	private done: (v: null) => void;
	private recs: Rec[] = [];
	private dayMap = new Map<string, number>();
	private scanning = true;
	private scanDone = 0;
	private scanTotal = 0;
	private view: View;
	private cursor: Date = new Date();
	private calEnd: Date = new Date();
	private scroll = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(tui: TUI, theme: any, done: (v: null) => void, view: View) {
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.view = view;
		this.rescan();
	}

	private rescan(): void {
		this.scanning = true;
		this.invalidate();
		scanSessionsAsync(defaultSessionsDir(), (done, total) => {
			this.scanDone = done;
			this.scanTotal = total;
			this.invalidate();
			this.tui.requestRender();
		}).then((recs) => {
			this.recs = recs;
			this.dayMap = dayTotals(recs);
			this.scanning = false;
			this.invalidate();
			this.tui.requestRender();
		});
	}

	private setView(v: View): void {
		if (v === this.view) return;
		this.view = v;
		this.cursor = new Date();
		this.calEnd = new Date();
		this.scroll = 0;
		this.invalidate();
	}

	private move(dir: number): void {
		if (this.view === "total") return;
		if (this.view === "cal") {
			const next = new Date(this.calEnd);
			next.setDate(next.getDate() + 28 * dir); // jump 4 weeks
			if (next.getTime() > Date.now()) return; // no future travel
			this.calEnd = next;
		} else {
			const next = shiftCursor(this.cursor, this.view, dir);
			if (next.getTime() > Date.now()) return;
			this.cursor = next;
		}
		this.scroll = 0;
		this.invalidate();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "q") || matchesKey(data, Key.escape)) {
			this.done(null);
			return;
		}
		if (matchesKey(data, "d")) this.setView("day");
		else if (matchesKey(data, "w")) this.setView("week");
		else if (matchesKey(data, "m")) this.setView("month");
		else if (matchesKey(data, "t")) this.setView("total");
		else if (matchesKey(data, "c")) this.setView("cal");
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
			this.rescan();
		}
	}

	private periodLabel(): string {
		if (this.view === "total") return "all time";
		if (this.view === "cal") {
			const cols = this.calCols();
			const c = renderCalendar(this.dayMap, this.calEnd, cols);
			return `${c.start} … ${c.end}`;
		}
		return bucketOf(this.cursor.getTime(), this.view);
	}

	private calCols(): number {
		const innerW = Math.max(20, (this.cachedWidth ?? 120) - 2);
		return Math.min(53, Math.max(4, Math.floor((innerW - 4) / 2)));
	}

	/** colorize the plain calendar grid: dim for empty, accent gradient for heat */
	private colorizeCalendar(plain: string[]): string[] {
		const th = this.theme;
		return plain.map((l) =>
			l
				.replace(/·/g, th.fg("dim", "·"))
				.replace(/░/g, th.fg("muted", "░"))
				.replace(/▒/g, th.fg("text", "▒"))
				.replace(/▓/g, th.fg("accent", "▓"))
				.replace(/█/g, th.fg("accent", th.bold("█"))),
		);
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const innerW = Math.max(20, width - 2);

		const tabs = VIEWS.map((v) =>
			v === this.view ? th.fg("accent", th.bold(` ${v} `)) : th.fg("muted", ` ${v} `),
		).join(th.fg("dim", "·"));

		const lines: string[] = [];
		if (this.view === "cal") {
			const c = renderCalendar(this.dayMap, this.calEnd, Math.floor((innerW - 4) / 2));
			lines.push(
				th.fg("muted", "view ") + tabs + th.fg("muted", "  period ") +
					th.fg("accent", `${c.start} … ${c.end}`),
				th.fg("dim", "─".repeat(innerW)),
			);
			if (this.scanning) {
				lines.push(th.fg("muted", this.scanLabel()));
			} else {
				lines.push(...this.colorizeCalendar(c.lines));
			}
		} else {
			lines.push(...this.renderTable(innerW, tabs));
		}
		lines.push(
			th.fg("dim", "d/w/m/t/c view · ←/→ period · ↑/↓ scroll · r rescan · q quit"),
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

	private scanLabel(): string {
		return this.scanTotal > 0
			? `Scanning sessions… ${this.scanDone}/${this.scanTotal}`
			: "Scanning sessions…";
	}

	private renderTable(innerW: number, tabs: string): string[] {
		const th = this.theme;
		const bucket = this.view === "total" ? null : bucketOf(this.cursor.getTime(), this.view as Gran);
		const rows = aggregate(this.recs, this.view as Gran, bucket);
		const sum = totals(rows);

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

		const lines: string[] = [
			th.fg("muted", "view ") + tabs + th.fg("muted", "  period ") +
				th.fg("accent", this.periodLabel()),
			th.fg("dim", "─".repeat(innerW)),
			th.bold(header),
		];

		if (this.scanning) {
			lines.push(th.fg("muted", this.scanLabel()));
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
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function parseView(args: string | undefined): View {
	const a = (args ?? "").trim().toLowerCase();
	return (VIEWS as string[]).includes(a) ? (a as View) : "day";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Token usage per provider/model — /usage [day|week|month|total|cal]",
		handler: async (args: string | undefined, ctx: ExtensionCommandContext) => {
			const view = parseView(args);
			if (ctx.mode !== "tui") {
				// UI methods are no-ops in print/json mode — write to stderr
				const recs = scanSessions(defaultSessionsDir());
				if (view === "cal") {
					const c = renderCalendar(dayTotals(recs), new Date(), 26);
					process.stderr.write(`pi-usage · cal · ${c.start} … ${c.end}\n` + c.lines.join("\n") + "\n");
					return;
				}
				const bucket = view === "total" ? null : bucketOf(Date.now(), view);
				process.stderr.write(
					`pi-usage · ${view} · ${bucket ?? "all time"}\n` +
						renderTextTable(aggregate(recs, view, bucket)) + "\n",
				);
				return;
			}
			await ctx.ui.custom<null>(
				(tui, theme, _kb, done) => new UsageComponent(tui, theme, done, view),
				{ overlay: true, overlayOptions: { width: "92%", maxHeight: "80%" } },
			);
		},
	});
}
