import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";
import { formatClosedPositionsList } from "./tools/format.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

function formatPosList(positions, solPriceUsd) {
  return formatClosedPositionsList(
    positions.map(p => ({
      pos: {
        pair: p.pool_name || "—",
        position: p.position,
        pnl_pct: p.pnl_pct,
        in_range: p.minutes_out_of_range === 0,
        age_minutes: p.minutes_held,
        minutes_out_of_range: (p.minutes_held || 0) - (p.minutes_in_range || 0),
        bin_step: p.bin_step,
        volatility: p.volatility,
        fee_tvl_ratio: p.fee_tvl_ratio,
        entry_mcap: p.entry_mcap,
      },
      result: {
        success: true,
        pnl_usd: p.pnl_usd,
        pnl_pct: p.pnl_pct,
        fees_earned_usd: p.fees_earned_usd,
      },
      tracked: {
        amount_sol: p.amount_sol,
        initial_value_usd: p.initial_value_usd,
        minutes_in_range: p.minutes_in_range,
        minutes_held: p.minutes_held,
      },
      market: { sol_price_usd: solPriceUsd },
    })),
    { management: { solMode: config.management?.solMode ?? false } }
  );
}

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 4. Live SOL price (single fetch for the whole briefing)
  let solPriceUsd = 0;
  try {
    const { getSolPrice } = await import("./tools/wallet.js");
    solPriceUsd = await getSolPrice();
  } catch { /* non-blocking */ }

  // 5. Format Message
  const safeRule = (l) => String(l ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Split perf into best / bad
  const sorted = perfLast24h
    .map(p => ({ ...p, pnl_usd: p.pnl_usd || 0 }))
    .sort((a, b) => b.pnl_usd - a.pnl_usd);
  const best5 = sorted.filter(p => p.pnl_usd > 0).slice(0, 5);
  const bad5 = sorted.filter(p => p.pnl_usd <= 0).slice(0, 5);

  // Max 10 latest lessons (not time-filtered)
  const latest10Lessons = (lessonsData.lessons || [])
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  // Build compact position lines matching image format
  function compactPosEntry(p) {
    const pair = p.pool_name || "—";
    const pnlVal = p.pnl_pct || 0;
    const pnlSign = pnlVal >= 0 ? "+" : "";
    const pnlStr = `PnL ${pnlSign}${pnlVal.toFixed(2)}%`;
    const deposit = p.initial_value_usd != null ? `Deposit $${p.initial_value_usd.toFixed(2)}` : "";
    const withdraw = (p.initial_value_usd != null && p.pnl_usd != null)
      ? `Withdraw $${(p.initial_value_usd + p.pnl_usd).toFixed(2)}` : "";
    const reasonRaw = p.close_reason || p.action || "";
    const reason = reasonRaw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let line = `+ ${pair} | ${pnlStr}`;
    if (deposit) line += ` | ${deposit}`;
    if (withdraw) line += ` | ${withdraw}`;
    if (reason) line += `\n  ${reason}`;
    return line;
  }

  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📊 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📊 Win Rate (24h): N/A",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.map(p => p.pool_name || "—").join(", ") || "None"}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "",
    `<b>Historical Positions (24h):</b>`,
    ...(best5.length > 0 ? [
      "🏆 <b>Best (Top 5)</b>",
      best5.map(compactPosEntry).join("\n"),
    ] : []),
    ...(bad5.length > 0 ? [
      "📉 <b>Bad (Bottom 5)</b>",
      bad5.map(compactPosEntry).join("\n"),
    ] : []),
    ...(best5.length === 0 && bad5.length === 0 ? ["• No positions closed in the last 24h."] : []),
    "",
    `<b>Lessons Learned (Last 10):</b>`,
    latest10Lessons.length > 0
      ? latest10Lessons.map(l => `• ${safeRule(l.rule)}`).join("\n")
      : "• No lessons recorded.",
    "",
    "────────────────"
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
