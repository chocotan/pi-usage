/**
 * Pure logic for pi-usage: scan pi session files, aggregate token usage
 * per provider/model, bucket by day / ISO week / month / total.
 * No pi imports — runnable standalone with `node demo.ts`.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface Rec {
	p: string; // provider
	m: string; // model
	ts: number; // ms epoch
	i: number; // input tokens
	o: number; // output tokens
	cr: number; // cache read tokens
	cw: number; // cache write tokens
	rs: number; // reasoning tokens
	t: number; // total tokens
	c: number; // cost total (0 when provider has no pricing)
}

export interface Agg {
	p: string;
	m: string;
	calls: number;
	i: number;
	o: number;
	cr: number;
	cw: number;
	rs: number;
	t: number;
	c: number;
}

export type Gran = "day" | "week" | "month" | "total";
export const GRANS: Gran[] = ["day", "week", "month", "total"];

export function defaultSessionsDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return path.join(home, ".pi", "agent", "sessions");
}

// ---------- time buckets (local time; week = ISO-8601, Monday start) ----------

const pad = (n: number): string => (n < 10 ? "0" + n : String(n));

export function dayKey(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function weekKey(d: Date): string {
	const date = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	const dow = (date.getDay() + 6) % 7; // Mon=0 .. Sun=6
	date.setDate(date.getDate() - dow + 3); // Thursday of this week
	const first = new Date(date.getFullYear(), 0, 4);
	first.setDate(first.getDate() - ((first.getDay() + 6) % 7) + 3);
	const week = 1 + Math.round((date.getTime() - first.getTime()) / (7 * 864e5));
	return `${date.getFullYear()}-W${pad(week)}`;
}

export function monthKey(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function bucketOf(ts: number, g: Gran): string {
	const d = new Date(ts);
	if (g === "day") return dayKey(d);
	if (g === "week") return weekKey(d);
	if (g === "month") return monthKey(d);
	return "total";
}

/** Shift a cursor date by ±1 unit of the granularity. */
export function shiftCursor(d: Date, g: Gran, dir: number): Date {
	const n = new Date(d.getTime());
	if (g === "day") n.setDate(n.getDate() + dir);
	else if (g === "week") n.setDate(n.getDate() + 7 * dir);
	else if (g === "month") {
		// clamp day: Jan 31 + 1 month must land in Feb, not Mar 3
		const day = n.getDate();
		n.setDate(1);
		n.setMonth(n.getMonth() + dir);
		const dim = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
		n.setDate(Math.min(day, dim));
	}
	return n;
}

// ---------- scanning (mtime+size cache; session files are append-only) ----------

interface CacheEntry {
	mtimeMs: number;
	size: number;
	recs: Rec[];
}
const fileCache = new Map<string, CacheEntry>();
const seenIds = new Set<string>();

function parseFile(fp: string): Rec[] {
	const recs: Rec[] = [];
	let data: string;
	try {
		data = fs.readFileSync(fp, "utf8");
	} catch {
		return recs;
	}
	for (const line of data.split("\n")) {
		if (!line.includes('"role":"assistant"') || !line.includes('"usage"')) continue;
		let d: any;
		try {
			d = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = d?.message;
		if (d?.type !== "message" || msg?.role !== "assistant") continue;
		if (d.id) {
			if (seenIds.has(d.id)) continue;
			seenIds.add(d.id);
		}
		const u = msg.usage;
		if (!u || !msg.provider || !msg.model || !msg.timestamp) continue;
		const t = u.totalTokens | 0;
		if (t <= 0 && !(u.input > 0) && !(u.output > 0)) continue;
		recs.push({
			p: String(msg.provider),
			m: String(msg.model),
			ts: Number(msg.timestamp),
			i: u.input | 0,
			o: u.output | 0,
			cr: u.cacheRead | 0,
			cw: u.cacheWrite | 0,
			rs: u.reasoning | 0,
			t,
			c: typeof u.cost?.total === "number" ? u.cost.total : 0,
		});
	}
	return recs;
}

export function scanSessions(dir: string): Rec[] {
	const out: Rec[] = [];
	let projects: fs.Dirent[];
	try {
		projects = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const proj of projects) {
		if (!proj.isDirectory()) continue;
		const pdir = path.join(dir, proj.name);
		let files: string[];
		try {
			files = fs.readdirSync(pdir);
		} catch {
			continue;
		}
		for (const f of files) {
			if (!f.endsWith(".jsonl")) continue;
			const fp = path.join(pdir, f);
			let st: fs.Stats;
			try {
				st = fs.statSync(fp);
			} catch {
				continue;
			}
			const hit = fileCache.get(fp);
			if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
				out.push(...hit.recs);
				continue;
			}
			// ponytail: session files are append-only and parseFile dedupes by
			// entry id via seenIds, so re-parsing a changed file yields only new
			// records — keep the previous ones. Revisit if pi ever rewrites files.
			const fresh = parseFile(fp);
			const recs = hit ? [...hit.recs, ...fresh] : fresh;
			fileCache.set(fp, { mtimeMs: st.mtimeMs, size: st.size, recs });
			out.push(...recs);
		}
	}
	return out;
}

// ---------- aggregation ----------

export function aggregate(recs: Rec[], g: Gran, bucket: string | null): Agg[] {
	const map = new Map<string, Agg>();
	for (const r of recs) {
		if (g !== "total" && bucketOf(r.ts, g) !== bucket) continue;
		const key = `${r.p}/${r.m}`;
		let a = map.get(key);
		if (!a) {
			a = { p: r.p, m: r.m, calls: 0, i: 0, o: 0, cr: 0, cw: 0, rs: 0, t: 0, c: 0 };
			map.set(key, a);
		}
		a.calls++;
		a.i += r.i;
		a.o += r.o;
		a.cr += r.cr;
		a.cw += r.cw;
		a.rs += r.rs;
		a.t += r.t;
		a.c += r.c;
	}
	return [...map.values()].sort((x, y) => y.t - x.t);
}

export function totals(rows: Agg[]): Agg {
	const t: Agg = { p: "", m: "", calls: 0, i: 0, o: 0, cr: 0, cw: 0, rs: 0, t: 0, c: 0 };
	for (const r of rows) {
		t.calls += r.calls;
		t.i += r.i;
		t.o += r.o;
		t.cr += r.cr;
		t.cw += r.cw;
		t.rs += r.rs;
		t.t += r.t;
		t.c += r.c;
	}
	return t;
}

// ---------- formatting ----------

export function fmtNum(n: number): string {
	if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
	if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
	if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
	return String(n);
}

export function fmtCost(c: number): string {
	return c > 0 ? "$" + c.toFixed(2) : "-";
}

/** Plain-text table of aggregated rows (for non-TUI output and tests). */
export function renderTextTable(rows: Agg[]): string {
	const sum = totals(rows);
	const head = "Provider            Model                     Calls    Input   Output   CacheR   CacheW    Total     Cost";
	const line = (p: string, m: string, a: Agg): string =>
		`${p.padEnd(20)}${m.padEnd(26)}${String(a.calls).padStart(6)} ${fmtNum(a.i).padStart(8)} ${fmtNum(a.o).padStart(8)} ${fmtNum(a.cr).padStart(8)} ${fmtNum(a.cw).padStart(8)} ${fmtNum(a.t).padStart(8)} ${fmtCost(a.c).padStart(8)}`;
	const body = rows.map((r) => line(r.p, r.m, r));
	return [head, ...body, "-".repeat(head.length), line("TOTAL", `${rows.length} models`, sum)].join("\n");
}
