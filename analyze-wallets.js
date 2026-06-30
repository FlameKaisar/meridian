/**
 * analyze-wallets.js — Smart wallet deep-analysis tool
 *
 * Finds up to 20 newest unanalyzed wallets from smart-wallets.json,
 * fetches on-chain + DLMM data for each, then runs LLM analysis
 * with the on-chain research analyst system prompt.
 *
 * Usage:
 *   node cli.js analyze-wallets         # CLI
 *   /analyze                            # Telegram
 */

import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });

import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";
import { jsonStore } from "./json-store.js";

const walletsStore = jsonStore(repoPath("smart-wallets.json"), { wallets: [] });
const loadWallets = () => walletsStore.load();
const saveWallets = (data) => walletsStore.save(data);

const METEORA_PORTFOLIO = "https://dlmm.datapi.meteora.ag/portfolio";
const HELIUS_KEY = (process.env.HELIUS_API_KEY || "").replace(/^\*+$/, "");

// ─── LLM setup (same env vars as agent.js) ─────────────────────────
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const LLM_API_KEY = (process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || "").replace(/^\*+$/, "");
const LLM_MODEL   = process.env.LLM_MODEL || "openrouter/healer-alpha";

const SYSTEM_PROMPT = `You are an on-chain research analyst specializing in Meteora DLMM liquidity providers on Solana.

Analyze up to 5 wallets using the provided DLMM position data (PnL, fees, open/closed positions, pools, bin ranges, token balances).

For each wallet analyze: performance (PnL, fee vs capital gains), strategy (range width, frequency, fee-heavy vs directional), risk (drawdown, concentration), diversification (pool count, token types), and behavior (activity pattern, rebalancing).

Output format:
- Table: Wallet | Strategy Type | Performance Summary | Historical (24h) | Risk Profile | Diversification | Notable Behaviors
  Strategy Type: spot(bins<20) | bid_ask(20-79) | curve(>=80). use data's binStrat.
  Historical(24h): pool|PnL|dep$|wd$|exit:closed-profit/closed-loss/still-open. From data's 24h Pool History section.
- Below table: 1 paragraph patterns + 3-5 bullet highlights. Include avg hold time.
- Section "## Config Recommendations": Config Key | Suggested Value | Rationale

Constraints:
- Wallet Address: first 8 chars+"..."
- Cells under 60 chars. Notable Behaviors: 1 short phrase.
- Config Rationale under 80 chars.
- Total under 3200 chars.
- Be concise. No chain-of-thought. Output directly. DATA INCOMPLETE if missing.
- No financial advice.

Valid config keys: screening.minTvl, screening.maxTvl, screening.minVolume, screening.minMcap, screening.maxMcap, screening.minBinStep, screening.maxBinStep, screening.minTokenFeesSol, screening.maxBotHoldersPct, screening.maxTop10Pct, screening.minFeeActiveTvlRatio, strategy.strategy(spot/bid_ask/curve), strategy.minBinsBelow, strategy.maxBinsBelow, management.stopLossPct, management.takeProfitPct, management.minFeePerTvl24h, management.deployAmountSol, management.solMode, management.outOfRangeBinsToClose, risk.maxPositions, risk.maxDeployAmount.`;

// ─── LLM call (handles both JSON and SSE responses) ───────────────
async function callLLM(messages) {
  const key = LLM_API_KEY;
  if (!key) {
    return "❌ LLM_API_KEY not configured. Set LLM_API_KEY or OPENROUTER_API_KEY in .env";
  }
  const body = {
    model: LLM_MODEL,
    messages,
    temperature: 0.3,
    max_tokens: 4096,
    stream: false,
  };
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`LLM API ${res.status}: ${err.slice(0, 300)}`);
  }
  const ct = res.headers.get("content-type") || "";
  const raw = await res.text();

  // Handle SSE (text/event-stream) — local LM Studio sometimes emits this
  if (ct.includes("event-stream") || raw.startsWith("data:")) {
    let content = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const chunk = JSON.parse(line.slice(6));
        const delta = chunk.choices?.[0]?.delta?.content || "";
        content += delta;
      } catch { /* skip malformed lines */ }
    }
    if (content) return content;
    // fallback: try full-JSON parse of each data line
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const parsed = JSON.parse(line.slice(6));
        const text = parsed.choices?.[0]?.message?.content || parsed.choices?.[0]?.text;
        if (text) return text;
      } catch { /* skip */ }
    }
    // Last resort: return the raw SSE to see what we got
    return raw.slice(0, 2000);
  }

  // Normal JSON response
  try {
    const data = JSON.parse(raw);
    return data.choices?.[0]?.message?.content || "(empty LLM response)";
  } catch {
    throw new Error(`LLM returned non-JSON: ${raw.slice(0, 300)}`);
  }
}

// ─── Fetch raw portfolio data (per-pool breakdown) ────────────────
async function fetchPortfolioDetail(walletAddress, { daysBack = 365, pageSize = 50 } = {}) {
  const pools = [];
  let page = 1;
  let hasNext = true;
  while (hasNext) {
    const url = `${METEORA_PORTFOLIO}?user=${walletAddress}&page=${page}&page_size=${pageSize}&days_back=${daysBack}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) break;
      const data = await res.json();
      const batch = Array.isArray(data.pools) ? data.pools : [];
      for (const p of batch) {
        pools.push({
          poolAddress: p.poolAddress || "?",
          pairName: `${p.tokenX || "?"}/${p.tokenY || "?"}`,
          pnlPctChange: parseFloat(p.pnlPctChange ?? 0),
          pnlUsd: parseFloat(p.pnlUsd ?? 0),
          feeUsd: parseFloat(p.totalFee ?? 0),
          totalDeposit: parseFloat(p.totalDeposit ?? 0),
          totalWithdrawal: parseFloat(p.totalWithdrawal ?? 0),
          lastClosedAt: p.lastClosedAt
            ? new Date(Number(p.lastClosedAt) * 1000).toISOString()
            : null,
        });
      }
      hasNext = Boolean(data.hasNext) && page < 20;
      page++;
    } catch {
      break;
    }
  }
  return pools;
}

// ─── Fetch open positions for a wallet ────────────────────────────
async function fetchOpenPositions(walletAddress) {
  try {
    const { getWalletPositions } = await import("./tools/dlmm.js");
    const result = await getWalletPositions({ wallet_address: walletAddress });
    if (!result?.positions?.length) return [];
    return result.positions.map((p) => ({
      position: p.position || "?",
      pool: p.pool || "?",
      pair: p.pair || "?",
      in_range: p.in_range ?? null,
      pnl_pct: p.pnl_pct ?? null,
      pnl_usd: p.pnl_usd ?? null,
      total_value_usd: p.total_value_usd ?? null,
      fee_per_tvl_24h: p.fee_per_tvl_24h ?? null,
      age_minutes: p.age_minutes ?? null,
      lower_bin: p.lower_bin ?? null,
      upper_bin: p.upper_bin ?? null,
      active_bin: p.active_bin ?? null,
    }));
  } catch {
    return [];
  }
}

// ─── Fetch wallet balances from Helius ───────────────────────────
async function fetchWalletBalances(walletAddress) {
  if (!HELIUS_KEY) return [];
  try {
    const url = `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data.balances) ? data.balances : [];
    return list
      .filter(b => (b.usdValue || 0) > 1)
      .slice(0, 10)
      .map(b => ({ symbol: b.symbol || "?", balance: b.balance, usdValue: b.usdValue }));
  } catch {
    return [];
  }
}

// ─── Build compressed data packet per wallet for LLM ──────────────
function compressWalletData(wallet, portfolio, positionData, openPositions, balances) {
  const lines = [];
  lines.push(`Wallet: ${wallet.address.slice(0, 8)}... (${wallet.name})`);
  lines.push(`Added: ${wallet.addedAt}`);
  lines.push(`Category: ${wallet.category} | Type: ${wallet.type}`);

  // Portfolio summary (compact)
  if (portfolio && !portfolio.error) {
    lines.push(`Portfolio: ${portfolio.totalClosedPositions ?? "?"} pos | ${portfolio.winRate != null ? (portfolio.winRate * 100).toFixed(1) + "%" : "?"} WR | $${portfolio.totalPnlUsd?.toFixed(0) ?? "?"} PnL | ${portfolio.poolCount ?? "?"} pools | last ${portfolio.lastActiveHoursAgo != null ? portfolio.lastActiveHoursAgo.toFixed(1) + "h" : "?"} ago`);
  } else {
    lines.push(`Portfolio: DATA INCOMPLETE — ${portfolio?.error || "no data returned"}`);
  }

  // Per-pool detail breakdown (compact — max 5 pools, 1 line each)
  if (positionData?.length > 0) {
    lines.push(`Top Pools (${Math.min(positionData.length, 5)}/${positionData.length}):`);
    for (const p of positionData.slice(0, 5)) {
      const pnlS = p.pnlUsd >= 0 ? "+" : "-";
      const feeRatio = Math.abs(p.pnlUsd) > 0.01 ? (p.feeUsd / Math.abs(p.pnlUsd)).toFixed(1) : "?";
      // Strategy hint: fee_dominated (fees > PnL => tight-range LP), price_dominated (PnL > fees => directional/swing)
      const strat = Math.abs(p.pnlUsd) > 0.01 && p.feeUsd > 0
        ? (p.feeUsd > Math.abs(p.pnlUsd) * 1.5 ? "fee-heavy" : Math.abs(p.pnlUsd) > p.feeUsd * 2 ? "directional" : "mixed")
        : "?";
      lines.push(`  ${p.pairName} | ${pnlS}$${Math.abs(p.pnlUsd).toFixed(0)} (${p.pnlPctChange >= 0 ? "+" : ""}${p.pnlPctChange.toFixed(1)}%) | fees:$${p.feeUsd.toFixed(0)} | strat:${strat} | fee/PnL:${feeRatio}`);
    }
  }

  // Open positions (compact)
  if (openPositions?.length > 0) {
    lines.push(`Open (${openPositions.length}):`);
    for (const p of openPositions.slice(0, 5)) {
      const range = p.in_range ? "IN" : "OOR";
      const spread = p.lower_bin != null && p.upper_bin != null ? (p.upper_bin - p.lower_bin) : "?";
      const ageH = p.age_minutes != null ? (p.age_minutes / 60).toFixed(1) : "?";
      const pnl = p.pnl_pct != null ? p.pnl_pct.toFixed(1) + "%" : "?";
      const binStrat = spread !== "?" && Number(spread) < 20 ? "tight" : Number(spread) < 80 ? "mid" : "wide";
      lines.push(`  ${p.pair} | ${range} | ${pnl} | value:$${(p.total_value_usd ?? 0).toFixed(0)} | bins:${spread}(${binStrat}) | ${ageH}h`);
    }
  } else {
    lines.push(`Open Positions: none`);
  }

  // 24h Pool History (closed positions in last 24h + open positions opened in last 24h)
  const nowMs = Date.now();
  const ms24h = 24 * 60 * 60 * 1000;
  const closed24h = (positionData || [])
    .filter(p => p.lastClosedAt && (nowMs - new Date(p.lastClosedAt).getTime()) < ms24h)
    .slice(0, 5);
  const open24h = (openPositions || [])
    .filter(p => p.age_minutes != null && p.age_minutes <= 1440)
    .slice(0, 5);

  if (closed24h.length > 0 || open24h.length > 0) {
    lines.push(`24h Pool History:`);
    for (const p of closed24h) {
      const pnlS = p.pnlUsd >= 0 ? "+" : "-";
      const exitReason = p.totalWithdrawal > p.totalDeposit * 0.99
        ? (p.pnlUsd > 0 ? "closed-profit" : "closed-loss")
        : "partial-withdraw";
      lines.push(`  ${p.pairName} | PnL:${pnlS}$${Math.abs(p.pnlUsd).toFixed(0)} | dep:$${p.totalDeposit.toFixed(0)} | wd:$${p.totalWithdrawal.toFixed(0)} | exit:${exitReason}`);
    }
    for (const p of open24h) {
      const ageH = p.age_minutes != null ? (p.age_minutes / 60).toFixed(1) : "?";
      const pnl = p.pnl_pct != null ? p.pnl_pct.toFixed(1) + "%" : "?";
      lines.push(`  ${p.pair} | PnL:${pnl} | value:$${(p.total_value_usd ?? 0).toFixed(0)} | exit:still-open (${ageH}h)`);
    }
  } else {
    lines.push(`24h Pool History: none in last 24h`);
  }

  // Token balances
  if (balances?.length > 0) {
    lines.push(`Token Balances (Helius, >$1):`);
    for (const b of balances) {
      lines.push(`  - ${b.symbol}: ${b.balance.toFixed(4)} ($${b.usdValue.toFixed(2)})`);
    }
  }

  return lines.join("\n");
}

// ─── Find 20 newest unanalyzed wallets ────────────────────────────
function findUnanalyzedWallets(count = 20) {
  const data = loadWallets();
  const wallets = data.wallets || [];

  // Filter out wallets with analyzedAt, then sort by addedAt desc, take N
  const unanalyzed = wallets
    .filter((w) => !w.analyzedAt)
    .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt))
    .slice(0, count);

  return unanalyzed;
}

// ─── Mark wallets as analyzed ─────────────────────────────────────
function markAnalyzed(addresses) {
  const data = loadWallets();
  const now = new Date().toISOString();
  for (const w of data.wallets) {
    if (addresses.includes(w.address)) {
      w.analyzedAt = now;
    }
  }
  saveWallets(data);
  log("analyze_wallets", `Marked ${addresses.length} wallets as analyzed`);
}

// ─── Main analyzer ────────────────────────────────────────────────
export async function analyzeWallets({ limit = 5 } = {}) {
  const wallets = findUnanalyzedWallets(limit);
  if (wallets.length === 0) {
    return "✅ All smart wallets have been analyzed. No new wallets to analyze.";
  }

  log("analyze_wallets", `Found ${wallets.length} unanalyzed wallets`);

  // ── Step 1: Fetch data for all wallets ─────────────────────────
  const walletData = [];
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    log("analyze_wallets", `Fetching data for ${w.address.slice(0, 8)}... (${i + 1}/${wallets.length})`);

    // Fetch portfolio, positions, pool detail, and balances in parallel per wallet
    const [portfolio, poolDetail, openPositions, balances] = await Promise.allSettled([
      (async () => {
        const { evaluateLPerFromMeteora } = await import("./smart-wallets.js");
        // fresh data — bypass 30m cache
        return evaluateLPerFromMeteora(w.address, { daysBack: 365 });
      })(),
      fetchPortfolioDetail(w.address),
      fetchOpenPositions(w.address),
      fetchWalletBalances(w.address),
    ]);

    const walletDatum = {
      wallet: w,
      portfolio: portfolio.status === "fulfilled" ? portfolio.value : { error: portfolio.reason?.message || "fetch_failed" },
      poolDetail: poolDetail.status === "fulfilled" ? poolDetail.value : [],
      openPositions: openPositions.status === "fulfilled" ? openPositions.value : [],
      balances: balances.status === "fulfilled" ? balances.value : [],
    };
    walletData.push(walletDatum);

    // Small delay between wallets to avoid 429s
    if (i < wallets.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── Step 2: Build LLM prompts in batches of 5 ──────────────────
  const BATCH_SIZE = 5;
  const batches = [];
  for (let i = 0; i < walletData.length; i += BATCH_SIZE) {
    batches.push(walletData.slice(i, i + BATCH_SIZE));
  }

  log("analyze_wallets", `Running LLM analysis in ${batches.length} batch(es)...`);

  const llmResults = [];
  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const firstBatch = b === 0;
    const lastBatch = b === batches.length - 1;
    const userContent = batch.map((d, idx) => {
      const globalIdx = b * BATCH_SIZE + idx + 1;
      return `=== WALLET ${globalIdx} ===\n${compressWalletData(d.wallet, d.portfolio, d.poolDetail, d.openPositions, d.balances)}`;
    }).join("\n\n");

    const instruction = lastBatch
      ? `Analyze the following ${batch.length} wallet(s). Output: ${firstBatch ? "" : "continued table rows + "}full overall patterns summary across ALL wallets I've shown you so far + key highlights + config recommendations table. Include the markdown table header row if this is the first batch.`
      : `Analyze the following ${batch.length} wallet(s). Output ONLY the markdown table rows for these wallets (no header row, no summary, no config recommendations).`;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `${instruction}\n\n${userContent}` },
    ];

    try {
      const analysis = await callLLM(messages);
      llmResults.push(analysis);
      log("analyze_wallets", `Batch ${b + 1}/${batches.length} analyzed successfully`);
    } catch (e) {
      log("analyze_wallets_error", `Batch ${b + 1} LLM error: ${e.message}`);
      llmResults.push(`❌ **Batch ${b + 1} LLM error**: ${e.message}\nRaw data:\n\`\`\`\n${userContent.slice(0, 2000)}\n\`\`\``);
    }

    // Delay between batches
    if (b < batches.length - 1) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // ── Step 3: Mark wallets as analyzed ───────────────────────────
  const analyzedAddresses = wallets.map((w) => w.address);
  markAnalyzed(analyzedAddresses);

  // ── Step 4: Assemble final output ──────────────────────────────
  const header = [
    `# 📊 Smart Wallet Analysis`,
    ``,
    `**Batch:** ${wallets.length} wallet(s) analyzed | **Date:** ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const footer = [
    ``,
    `---`,
    `*🤖 Analysis by ${LLM_MODEL} | ${wallets.length} wallet(s) processed and marked as analyzed*`,
  ].join("\n");

  return header + llmResults.join("\n\n---\n\n") + footer;
}

// ─── CLI entry point ──────────────────────────────────────────────
export async function runAnalyzeWalletsCLI(options = {}) {
  const result = await analyzeWallets(options);
  process.stdout.write(result + "\n");
}
