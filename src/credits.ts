import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "./shared/index.js";

export interface CreditRow { day: string; model: string; credits: number; requests: number }

function* sessionFiles(dir: string): Generator<string> {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sessionFiles(path);
    else if (entry.name.endsWith(".jsonl")) yield path;
  }
}

/** Sums `kiro_metering` credits from omp session logs (including subagent transcripts), grouped by local day and model. */
export function collectKiroCredits(sessionsDir: string, providerId: string, sinceMs: number): CreditRow[] {
  const rows = new Map<string, CreditRow>();
  for (const file of sessionFiles(sessionsDir)) {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    if (!text.includes("kiro_metering")) continue;
    for (const line of text.split("\n")) {
      if (!line.includes("kiro_metering")) continue;
      let entry: unknown;
      try { entry = JSON.parse(line); } catch { continue; }
      const message = isRecord(entry) && isRecord(entry.message) ? entry.message : undefined;
      if (!message || message.provider !== providerId || !Array.isArray(message.diagnostics)) continue;
      const at = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String((entry as { timestamp?: unknown }).timestamp));
      if (!Number.isFinite(at) || at < sinceMs) continue;
      let credits = 0;
      for (const d of message.diagnostics) {
        if (isRecord(d) && d.type === "kiro_metering" && isRecord(d.details) && typeof d.details.usage === "number") credits += d.details.usage;
      }
      if (credits <= 0) continue;
      const day = dayKey(new Date(at));
      const model = typeof message.model === "string" ? message.model : "unknown";
      const key = `${day}\0${model}`;
      const row = rows.get(key) ?? { day, model, credits: 0, requests: 0 };
      row.credits += credits;
      row.requests += 1;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.day.localeCompare(a.day) || b.credits - a.credits);
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Start (local midnight) of the billing period containing `now`, for a cycle that renews on `billingDay` (1-28). */
export function billingPeriodStart(now: Date, billingDay: number): Date {
  const monthOffset = now.getDate() >= billingDay ? 0 : -1;
  return new Date(now.getFullYear(), now.getMonth() + monthOffset, billingDay);
}

export function formatKiroCredits(rows: CreditRow[], opts: { days: number; billingStart: Date; usdPerCredit: number; now: Date }): string {
  const { days, billingStart, usdPerCredit, now } = opts;
  const usd = (credits: number) => `$${(credits * usdPerCredit).toFixed(4)}`;
  const recentFrom = dayKey(new Date(now.getTime() - days * 86_400_000));
  const recent = rows.filter((r) => r.day >= recentFrom);
  const period = rows.filter((r) => r.day >= dayKey(billingStart));
  const sum = (list: CreditRow[]) => ({ credits: list.reduce((n, r) => n + r.credits, 0), requests: list.reduce((n, r) => n + r.requests, 0) });
  const lines = [`Kiro credits, last ${days} day(s) (at $${usdPerCredit}/credit)`];
  if (recent.length === 0) lines.push("  none metered");
  else {
    lines.push("day         model                  reqs   credits     usd");
    for (const r of recent) lines.push(`${r.day}  ${r.model.padEnd(21)} ${String(r.requests).padStart(5)}  ${r.credits.toFixed(4).padStart(8)}  ${usd(r.credits).padStart(8)}`);
  }
  const total = sum(period);
  lines.push(`billing period since ${dayKey(billingStart)}: ${total.credits.toFixed(4)} credits, ${usd(total.credits)}, ${total.requests} requests`);
  return lines.join("\n");
}
