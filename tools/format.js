// tools/format.js — Emoji-rich formatter for closed DLMM positions
// Used by meridian bot after closePosition() succeeds.
// Replaces the legacy single-line "🔒 Closed X-SOL / PnL: $-0.00" output.

const SOL_MODE_DEFAULT = false;   // matches config.management.solMode default
const IN_RANGE_OK_PCT  = 95;      // ≥ 95% in-range = 🎯
const IN_RANGE_WARN_PCT = 80;     // ≥ 80% = ⚠️

const fmtSol  = (x, d=4) => x == null ? "—" : `◎${(+x).toFixed(d)}`;
const fmtUsd  = (x, d=2) => x == null ? "—" : `$${(+x).toFixed(d)}`;
const fmtPct  = (x, d=2, signed=false) => {
  if (x == null || Number.isNaN(x)) return "—";
  const sign = signed && x > 0 ? "+" : "";
  return `${sign}${Math.abs(x).toFixed(d)}%`;
};
const fmtDuration = (mins) => {
  if (mins == null) return "—";
  if (mins < 240) return `${Math.round(mins)}m`;   // <4h → keep minute format
  const h = mins / 60;
  return h < 24 ? `${h.toFixed(1)}h` : `${Math.floor(h/24)}d ${Math.floor(h%24)}h`;
};

/**
 * Build the closed-position message block.
 *
 * @param {Object} args
 * @param {Object} args.pos        - The position from getMyPositions() (live, pre-close snapshot)
 * @param {Object} args.result     - The return value from closePosition() (post-close PnL)
 * @param {Object} [args.tracked]  - Tracked state record (bin_step, volatility, fee_tvl_ratio, etc.)
 * @param {Object} [args.market]   - { entry_mcap, entry_tvl, exit_mcap, exit_tvl, sol_price_usd }
 * @param {Object} [args.config]   - { management: { solMode: bool } }
 * @returns {string} Multi-line Telegram-friendly block.
 */
export function formatClosedPosition({ pos, result = {}, tracked = {}, market = {}, config = {} }) {
  const solMode = config.management?.solMode ?? SOL_MODE_DEFAULT;
  const solUsd  = market.sol_price_usd ?? 0;

  // ---- Source-of-truth: result (post-close RPC) → pos (live) → tracked (state.json) ----
  // PnL — always recalc % from our tracked modal to avoid Meteora's misleading pnl_pct
  const pnlUsd   = result.pnl_usd ?? pos.pnl_usd ?? 0;
  const modalSol = tracked.amount_sol
                ?? pos.amount_sol
                ?? pos.initial_value_sol
                ?? 0;
  // Convert modal to USD using entry market if no USD snapshot
  // Prefer reverse-calc from Meteora PnL (on-chain truth) — avoids accumulated
  // initial_value_usd from re-seeds which Meteora doesn't account for.
  let modalUsd;
  if (result.pnl_usd != null && result.pnl_pct != null && result.pnl_pct !== 0) {
    modalUsd = Math.abs(result.pnl_usd / (result.pnl_pct / 100));
  } else {
    modalUsd = tracked.initial_value_usd ?? pos.initial_value_usd ?? (modalSol * solUsd);
  }
  const pnlPct   = modalUsd > 0 ? (pnlUsd / modalUsd) * 100 : 0;
  // PnL in SOL (if solMode)
  const pnlSol = solUsd > 0 ? pnlUsd / solUsd : 0;
  // Fees (collected + unclaimed, both USD)
  const feesUsd = result.fees_earned_usd
               ?? pos.collected_fees_usd ?? pos.all_time_fees_usd
               ?? pos.unclaimed_fees_usd ?? 0;
  const feesSol = solUsd > 0 ? feesUsd / solUsd : 0;
  // In-range %
  const ageMin = pos.age_minutes ?? pos.minutes_held ?? tracked.minutes_held ?? null;
  let inRangePct;
  if (pos.in_range === true) {
    inRangePct = 100;
  } else if (pos.in_range === false && pos.minutes_out_of_range != null && ageMin) {
    inRangePct = Math.max(0, Math.round((1 - pos.minutes_out_of_range / ageMin) * 100));
  } else if (tracked.minutes_in_range != null && ageMin) {
    inRangePct = Math.max(0, Math.round((tracked.minutes_in_range / ageMin) * 100));
  } else {
    inRangePct = null;
  }
  // Duration
  const durationMin = ageMin;
  // Exit reason — accept multiple sources so different call sites work
  const exitReason = result.close_reason
                  ?? pos.close_reason
                  ?? pos.exit_reason
                  ?? tracked.close_reason
                  ?? tracked.exit_reason
                  ?? tracked.notes?.[0]
                  ?? "manual close";
  // Meta
  const vol = pos.volatility_at_deploy ?? tracked.volatility ?? pos.volatility ?? null;
  const binStep = pos.bin_step ?? tracked.bin_step ?? null;
  const feeTvl = pos.fee_tvl_ratio ?? tracked.fee_tvl_ratio ?? null;
  const entryMcap = pos.entry_mcap ?? tracked.entry_mcap ?? null;
  const exitMcap  = pos.exit_mcap  ?? tracked.exit_mcap  ?? market.exit_mcap ?? null;
  // Kembali (modal + pnl, returned capital)
  const kembaliUsd = modalUsd + pnlUsd;
  const kembaliSol = modalSol + pnlSol;
  const deltaUsd   = pnlUsd;
  const deltaPct   = modalUsd > 0 ? (deltaUsd / modalUsd) * 100 : 0;

  // ---- Symbol helpers (respect solMode) ----
  const sym  = (usd, sol) => solMode ? fmtSol(sol) : fmtUsd(usd);
  const symP = (usd, sol) => solMode ? `${fmtSol(sol)} (${fmtPct(pnlPct, 2, true)})`
                                     : `${fmtUsd(usd)} (${fmtPct(pnlPct, 2, true)})`;

  // ---- Status icon ----
  const isWin = pnlUsd > 0;
  const isFlat = pnlUsd === 0;
  const icon = isFlat ? "⚪" : isWin ? "🟢" : "🔴";

  // ---- In-range badge ----
  let inRangeStr;
  if (inRangePct == null) inRangeStr = "—";
  else if (inRangePct >= IN_RANGE_OK_PCT)  inRangeStr = `${inRangePct}% In-Range 🎯`;
  else if (inRangePct >= IN_RANGE_WARN_PCT) inRangeStr = `${inRangePct}% In-Range ⚠️`;
  else                                      inRangeStr = `${inRangePct}% In-Range ❌`;

  // ---- PnL line ----
  const pnlIcon = isFlat ? "➖" : isWin ? "✅" : "❌";
  const pnlLine = `💰 PnL     : ${symP(pnlUsd, pnlSol)} ${pnlIcon}`;

  // ---- Modal + Kembali (use whichever mode is active) ----
  const modalStr = solMode ? fmtSol(modalSol) : fmtUsd(modalUsd);
  const kembaliStr = solMode ? fmtSol(kembaliSol) : fmtUsd(kembaliUsd);
  const deltaStr  = fmtPct(deltaPct, 2, true);

  // ---- Meta line ----
  const metaParts = [];
  if (vol != null)        metaParts.push(`vol=${(+vol).toFixed(4)}`);
  if (binStep != null)    metaParts.push(`step=${binStep}`);
  if (feeTvl != null)     metaParts.push(`fee/TVL=${(+feeTvl).toFixed(4)}%`);
  if (entryMcap != null)  metaParts.push(`mcap=$${(entryMcap/1000).toFixed(1)}K`);
  if (solUsd > 0)         metaParts.push(`SOL @ $${solUsd.toFixed(2)}`);
  const metaLine = `📊 Meta    : ${metaParts.join(" | ") || "—"}`;

  // ---- Exit reason (truncate to 200 chars to keep telegram happy) ----
  const exitClean = exitReason.length > 200 ? exitReason.slice(0, 197) + "..." : exitReason;

  // ---- Tx hashes (compact) ----
  const allTxs = [
    ...(result.claim_txs || []),
    ...(result.close_txs || []),
    ...(result.txs || []),
  ].filter(Boolean);
  const txLine = allTxs.length
    ? `🔗 Tx     : ${allTxs.join(", ")}`
    : `🔗 Tx     : —`;

  return [
    `${icon} CLOSED | ${pos.pair || "?"}`,
    `📥 Modal   : ${modalStr}`,
    pnlLine,
    `💸 Fees   : ${sym(feesUsd, feesSol)}`,
    `🤖 Exit   : ${exitClean}`,
    `⏱️ Duration: ${fmtDuration(durationMin)} | ${inRangeStr}`,
    `🔄 Kembali: ${kembaliStr} (${deltaStr} dari modal)`,
    metaLine,
    txLine,
  ].join("\n");
}

/**
 * Format a list of closed positions as a daily summary.
 * Used by meridian-daily-analysis to render `## Closed Positions` section.
 *
 * @param {Object[]} closed  - Array of { pos, result, tracked, market }
 * @param {Object} [config]
 * @returns {string} Multi-position block
 */
export function formatClosedPositionsList(closed = [], config = {}) {
  if (!closed.length) return "_No closed positions in this window._";
  const wins   = closed.filter(c => (c.result?.pnl_usd ?? 0) > 0).length;
  const losses = closed.filter(c => (c.result?.pnl_usd ?? 0) < 0).length;
  const totalPnl = closed.reduce((s, c) => s + (c.result?.pnl_usd ?? 0), 0);
  const totalFees = closed.reduce((s, c) => s + (c.result?.fees_earned_usd ?? 0), 0);

  const header = [
    `**${closed.length} closed** — ${wins}W / ${losses}L | PnL ${fmtUsd(totalPnl)} | Fees ${fmtUsd(totalFees)}`,
    "",
  ].join("\n");

  const body = closed
    .sort((a, b) => (b.result?.pnl_usd ?? 0) - (a.result?.pnl_usd ?? 0))
    .map(c => formatClosedPosition({ ...c, config }))
    .join("\n\n");

  return header + body;
}
