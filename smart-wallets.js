import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const WALLETS_PATH = repoPath("smart-wallets.json");

function loadWallets() {
  if (!fs.existsSync(WALLETS_PATH)) return { wallets: [] };
  try {
    return JSON.parse(fs.readFileSync(WALLETS_PATH, "utf8"));
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(data) {
  fs.writeFileSync(WALLETS_PATH, JSON.stringify(data, null, 2));
}

const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function addSmartWallet({ name, address, category = "alpha", type = "lp" }) {
  if (!SOLANA_PUBKEY_RE.test(address)) {
    return { success: false, error: "Invalid Solana address format" };
  }
  const data = loadWallets();
  const existing = data.wallets.find((w) => w.address === address);
  if (existing) {
    return { success: false, error: `Already tracked as "${existing.name}"` };
  }
  data.wallets.push({ name, address, category, type, addedAt: new Date().toISOString() });
  saveWallets(data);
  log("smart_wallets", `Added wallet: ${name} (${category}, type=${type})`);
  return { success: true, wallet: { name, address, category, type } };
}

export function removeSmartWallet({ address }) {
  const data = loadWallets();
  const wallet = data.wallets.find((w) => w.address === address);
  if (!wallet) return { success: false, error: "Wallet not found" };
  data.wallets = data.wallets.filter((w) => w.address !== address);
  saveWallets(data);
  log("smart_wallets", `Removed wallet: ${wallet.name}`);
  return { success: true, removed: wallet.name };
}

export function listSmartWallets() {
  const { wallets } = loadWallets();
  return { total: wallets.length, wallets };
}

// Cache wallet positions for 5 minutes to avoid hammering RPC
const _cache = new Map(); // address -> { positions, fetchedAt }
const CACHE_TTL = 5 * 60 * 1000;

export async function checkSmartWalletsOnPool({ pool_address }) {
  const { wallets: allWallets } = loadWallets();
  // Only check LP-type wallets — holder wallets don't have positions
  const wallets = allWallets.filter((w) => !w.type || w.type === "lp");
  if (wallets.length === 0) {
    return {
      pool: pool_address,
      tracked_wallets: 0,
      in_pool: [],
      confidence_boost: false,
      signal: "No smart wallets tracked yet — neutral signal",
    };
  }

  const { getWalletPositions } = await import("./tools/dlmm.js");

  const results = await Promise.all(
    wallets.map(async (wallet) => {
      try {
        const cached = _cache.get(wallet.address);
        if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return { wallet, positions: cached.positions };
        }
        const { positions } = await getWalletPositions({ wallet_address: wallet.address });
        _cache.set(wallet.address, { positions: positions || [], fetchedAt: Date.now() });
        return { wallet, positions: positions || [] };
      } catch {
        return { wallet, positions: [] };
      }
    })
  );

  const inPool = results
    .filter((r) => r.positions.some((p) => p.pool === pool_address))
    .map((r) => ({ name: r.wallet.name, category: r.wallet.category, address: r.wallet.address }));

  return {
    pool: pool_address,
    tracked_wallets: wallets.length,
    in_pool: inPool,
    confidence_boost: inPool.length > 0,
    signal: inPool.length > 0
      ? `${inPool.length}/${wallets.length} smart wallet(s) are in this pool: ${inPool.map((w) => w.name).join(", ")} — STRONG signal`
      : `0/${wallets.length} smart wallets in this pool — neutral, rely on fundamentals`,
  };
}

// ─── Meteora /portfolio closed-positions evaluator ──────────────
// (added 2026-06-22 — data source for smart-wallet auto-grow)
//
// Fetches per-wallet closed DLMM positions across ALL pools from Meteora's
// public /portfolio endpoint. Returns aggregated metrics that satisfy the
// user-defined hybrid (A+B) criteria:
//   - totalClosedPositions: totalPositions (sum across all pages)
//   - lastActiveAt:         max(pools[].lastClosedAt) timestamp
//   - winRate:              count(pools[].pnlPctChange > 0) / pools.length
//   - pnlUsd:               sum(pools[].pnlUsd)
//   - poolCount:            pools.length
//
// Endpoint docs: https://docs.meteora.ag/api-reference/dlmm/portfolio/
//                get-user-portfolio-with-all-pools-containing-closed-positions
const METEORA_PORTFOLIO = "https://dlmm.datapi.meteora.ag/portfolio";
const EVAL_CACHE_TTL = 30 * 60 * 1000; // 30 min — same as study_top_lpers
const _evalCache = new Map(); // address -> { stats, fetchedAt }

function safeParseNum(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export async function evaluateLPerFromMeteora(walletAddress, { daysBack = 120, pageSize = 50 } = {}) {
  // Return cached result if fresh
  const cached = _evalCache.get(walletAddress);
  if (cached && Date.now() - cached.fetchedAt < EVAL_CACHE_TTL) {
    return cached.stats;
  }

  let totalClosedPositions = 0;
  let lastActiveAt = 0;
  let winningPools = 0;
  let totalPnlUsd = 0;
  let poolCount = 0;
  let page = 1;
  let hasNext = true;
  const poolsSeen = new Set(); // dedupe by poolAddress

  while (hasNext) {
    const url = `${METEORA_PORTFOLIO}?user=${walletAddress}&page=${page}&page_size=${pageSize}&days_back=${daysBack}`;
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      log("smart_wallets", `evaluateLPer: fetch error page ${page} for ${walletAddress.slice(0, 8)}: ${e.message}`);
      return { error: `fetch_error: ${e.message}` };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("smart_wallets", `evaluateLPer: HTTP ${res.status} page ${page} for ${walletAddress.slice(0, 8)}: ${body.slice(0, 120)}`);
      return { error: `http_${res.status}` };
    }
    const data = await res.json();
    const pools = Array.isArray(data.pools) ? data.pools : [];
    for (const pool of pools) {
      if (poolsSeen.has(pool.poolAddress)) continue;
      poolsSeen.add(pool.poolAddress);
      poolCount++;
      totalPnlUsd += safeParseNum(pool.pnlUsd);
      if (safeParseNum(pool.pnlPctChange) > 0) winningPools++;
      const closedAt = Number(pool.lastClosedAt || 0);
      if (closedAt > lastActiveAt) lastActiveAt = closedAt;
    }
    // totalPositions is the wallet's all-time closed position count (per page response)
    // Only trust it on page 1 to avoid double-counting
    if (page === 1) {
      totalClosedPositions = Number(data.totalPositions || 0);
    }
    hasNext = Boolean(data.hasNext) && page < 20; // safety cap
    page++;
  }

  const winRate = poolCount > 0 ? winningPools / poolCount : 0;
  const stats = {
    totalClosedPositions,
    lastActiveAt,
    lastActiveHoursAgo: lastActiveAt ? (Date.now() / 1000 - lastActiveAt) / 3600 : null,
    winRate,
    winningPools,
    poolCount,
    totalPnlUsd: Math.round(totalPnlUsd * 100) / 100,
    pnlUsd: totalPnlUsd, // alias for clarity
    source: "meteora_datapi_portfolio",
    fetchedAt: Date.now(),
  };
  _evalCache.set(walletAddress, { stats, fetchedAt: Date.now() });
  return stats;
}
