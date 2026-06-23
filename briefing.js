import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";
import { formatClosedPositionsList } from "./tools/format.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

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

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 4b. Live SOL price (single fetch for the whole briefing)
  let solPriceUsd = 0;
  try {
    const { getSolPrice } = await import("./tools/wallet.js");
    solPriceUsd = await getSolPrice();
  } catch { /* non-blocking */ }

  // 5. Format Message
  // NOTE: lesson rules are LLM-generated natural language and may
  // contain HTML-meaningful chars ("<", ">", "&") — they MUST be
  // escaped because the message is sent with parse_mode="HTML".
  const safeRule = (l) => String(l ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Closed Positions (24h):</b>`,
    perfLast24h.length > 0
      ? formatClosedPositionsList(
          perfLast24h.map(p => ({
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
        )
      : "• No positions closed in the last 24h.",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${safeRule(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
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
