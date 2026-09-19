/**
 * Self-check for pi-usage pure logic. Run: `node demo.ts` (node >= 22.18).
 * Fails loudly if bucket math, aggregation, or scanning breaks.
 */

import assert from "node:assert";
import {
	aggregate,
	bucketOf,
	dayKey,
	dayTotals,
	defaultSessionsDir,
	fmtCost,
	fmtNum,
	monthKey,
	renderCalendar,
	scanSessions,
	scanSessionsAsync,
	shiftCursor,
	totals,
	weekKey,
	type Rec,
} from "./stats.ts";

// --- bucket math ---
assert.strictEqual(dayKey(new Date(2026, 0, 5)), "2026-01-05");
assert.strictEqual(monthKey(new Date(2026, 11, 31)), "2026-12");
// ISO week: 2026-01-01 is a Thursday -> 2026-W01
assert.strictEqual(weekKey(new Date(2026, 0, 1)), "2026-W01");
assert.strictEqual(weekKey(new Date(2025, 11, 29)), "2026-W01"); // Mon of that week
assert.strictEqual(weekKey(new Date(2026, 0, 4)), "2026-W01"); // Sun still W01
assert.strictEqual(weekKey(new Date(2026, 0, 5)), "2026-W02"); // next Mon
// 2024-01-01 was a Monday
assert.strictEqual(weekKey(new Date(2024, 0, 1)), "2024-W01");

// --- cursor shift ---
assert.strictEqual(dayKey(shiftCursor(new Date(2026, 0, 15), "day", 1)), "2026-01-16");
assert.strictEqual(dayKey(shiftCursor(new Date(2026, 0, 15), "week", -1)), "2026-01-08");
assert.strictEqual(monthKey(shiftCursor(new Date(2026, 0, 31), "month", 1)), "2026-02");

console.log("bucket math OK");

// --- aggregation on synthetic records ---
const mk = (p: string, m: string, ts: number, t: number): Rec => ({
	p, m, ts, i: t / 2, o: t / 4, cr: 0, cw: 0, rs: 0, t, c: 0,
});
const jan5 = new Date(2026, 0, 5).getTime();
const jan6 = new Date(2026, 0, 6).getTime();
const recs: Rec[] = [
	mk("a", "x", jan5, 100),
	mk("a", "x", jan5, 200),
	mk("a", "y", jan5, 50),
	mk("b", "z", jan6, 1000),
];

const dayRows = aggregate(recs, "day", "2026-01-05");
assert.strictEqual(dayRows.length, 2);
assert.strictEqual(dayRows[0].p + "/" + dayRows[0].m, "a/x");
assert.strictEqual(dayRows[0].calls, 2);
assert.strictEqual(dayRows[0].t, 300);

const weekRows = aggregate(recs, "week", "2026-W02");
assert.strictEqual(weekRows.length, 3); // both days in same week
assert.strictEqual(totals(weekRows).t, 1350);

const totalRows = aggregate(recs, "total", null);
assert.strictEqual(totals(totalRows).t, 1350);
assert.strictEqual(totals(totalRows).calls, 4);

// month split
assert.strictEqual(aggregate(recs, "month", "2026-02").length, 0);
assert.strictEqual(aggregate(recs, "month", "2026-01").length, 3);

console.log("aggregation OK");

// --- calendar heatmap ---
{
	const map = new Map<string, number>();
	const end = new Date(2026, 0, 15); // Thu, week of Jan 12 (Mon)
	map.set("2026-01-12", 1_000_000);
	map.set("2026-01-14", 500_000);
	const c = renderCalendar(map, end, 4);
	assert.strictEqual(c.lines.length, 1 + 7 + 1, "labels + 7 rows + legend");
	assert.strictEqual(c.start, "2025-12-22", "4 weeks back from week of Jan 12");
	const monRow = c.lines[1]!; // Mon row, last cell = Jan 12
	assert.ok(monRow.endsWith("██"), "Jan 12 = 1M tokens -> max shade");
	assert.ok(c.lines[3]!.endsWith("▓▓"), "Jan 14 = 500K -> 3/4 shade");
	assert.ok(c.lines[8]!.includes("peak 1.0M (2026-01-12)"), "legend peak");
	assert.ok(c.lines[8]!.includes("window 1.5M"), "legend window total");
	// future days blank: use real today — rows after today's weekday end blank
	const now = new Date();
	const todayDow = (now.getDay() + 6) % 7;
	if (todayDow < 6) {
		const cur = renderCalendar(map, now, 4);
		assert.ok(cur.lines[1 + todayDow + 1]!.endsWith("  "), "future cells blank");
	}
	// month label present
	assert.ok(c.lines[0]!.includes("Jan"), "month label");
	// empty map
	const empty = renderCalendar(new Map(), end, 4);
	assert.ok(empty.lines[8]!.includes("no usage"), "empty legend");
}

console.log("calendar OK");

// --- formatting ---
assert.strictEqual(fmtNum(999), "999");
assert.strictEqual(fmtNum(1500), "1.5K");
assert.strictEqual(fmtNum(2_340_000), "2.3M");
assert.strictEqual(fmtNum(1_200_000_000), "1.2B");
assert.strictEqual(fmtCost(0), "-");
assert.strictEqual(fmtCost(1.234), "$1.23");

console.log("formatting OK");

// --- real scan (only when sessions exist) ---
const dir = process.argv[2] ?? defaultSessionsDir();
const t0 = Date.now();
const real = scanSessions(dir);
const ms1 = Date.now() - t0;
if (real.length === 0) {
	console.log(`no sessions under ${dir} — scan checks skipped`);
} else {
	for (const r of real) {
		assert.ok(r.p && r.m && r.ts > 0, "record fields populated");
		assert.ok(r.t >= 0 && r.i >= 0 && r.o >= 0, "non-negative tokens");
	}
	const t1 = Date.now();
	const again = scanSessions(dir); // cache hit path
	// a live session may append between scans; only monotonicity is guaranteed
	assert.ok(again.length >= real.length, "cached rescan never loses records");
	console.log(
		`scan OK: ${real.length} assistant messages, cold ${ms1}ms, cached ${Date.now() - t1}ms`,
	);
	// async scan: same records (responsiveness is covered by the TUI smoke test)
	const asyncRecs = await scanSessionsAsync(dir);
	assert.ok(asyncRecs.length >= real.length, "async scan returns records");
	console.log(`async scan OK: ${asyncRecs.length} records`);
	const all = aggregate(real, "total", null);
	console.log(`top: ${all.slice(0, 5).map((a) => `${a.p}/${a.m}=${fmtNum(a.t)}`).join(", ")}`);
}

console.log("ALL CHECKS PASSED");
