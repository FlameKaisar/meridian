import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { repoPath } from "./repo-root.js";
import { config } from "./config.js";

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
      ? formatTopBottomPositions(perfLast24h, solPriceUsd)
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

/**
 * Format closed positions as Top 5 / Bottom 5 with 4 lines each.
 * Matches the format shown in the user's reference image.
 */
function formatTopBottomPositions(perf, solPriceUsd) {
  // Sort by pnl_pct descending
  const sorted = [...perf].sort((a, b) => (b.pnl_pct ?? 0) - (a.pnl_pct ?? 0));
  const top5 = sorted.slice(0, 5);
  // Bottom 5: from the rest (exclude top5)
  const rest = sorted.slice(5);
  const bottom5 = rest.slice(-5).reverse();

  const fmtUsd = (v) => {
    if (v == null) return "—";
    return `$${v.toFixed(2)}`;
  };
  const fmtPct = (v) => {
    if (v == null) return "—";
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  };

  function renderPosition(p, index, isTop) {
    const pair = p.pool_name || p.base_mint?.slice(0, 6) || "—";
    const pnl = p.pnl_pct ?? 0;
    const deposit = p.initial_value_usd ?? 0;
    // Withdraw = deposit + pnl_usd (more accurate than final_value_usd)
    const withdraw = deposit + (p.pnl_usd ?? 0);
    // Clean up close_reason: remove duplicate prefixes AND escape HTML chars
    let reason = p.close_reason || "—";
    reason = reason.replace(/^Trailing TP:\s*Trailing TP:\s*/i, "Trailing TP: ");
    // Escape HTML meta chars in reason text (Telegram parse_mode=HTML)
    reason = reason.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const emoji = pnl >= 0 ? "🟢" : "🔴";

    const entry = [
      `${index + 1}. <b>${pair}</b> ${emoji}`,
      `   • PnL: ${fmtPct(pnl)}`,
      `   • Deposit: ${fmtUsd(deposit)}`,
      `   • Withdraw: ${fmtUsd(withdraw)}`,
    ];
    if (reason !== "—") {
      entry.push(`   • ${reason}`);
    }
    return entry.join("\n");
  }

  const lines = ["<b>Best Positions:</b>"];
  top5.forEach((p, i) => lines.push(renderPosition(p, i, true)));

  if (bottom5.length > 0) {
    lines.push("");
    lines.push("<b>Worst Positions:</b>");
    bottom5.forEach((p, i) => lines.push(renderPosition(p, i, false)));
  }

  return lines.join("\n");
}
