/**
 * presets-data.js — Meridian preset data definitions
 * ponytail: split from presets.js (data vs logic separation).
 *
 * Contains the 3 built-in preset definitions (degen, moderate, safe)
 * plus the custom preset placeholder and the snapshot machinery.
 */
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- snapshot that gets populated at first preset call ---
export let CUSTOM_SNAPSHOT = null;

export function takeCustomSnapshot() {
  // Import config lazily to avoid circular-dependency issues at module
  // evaluation time.  The caller (index.js) passes the live config.
  const mod = globalThis.__meridian_config;
  if (!mod) return null;
  CUSTOM_SNAPSHOT = makePresetParams(mod);
  return CUSTOM_SNAPSHOT;
}

/**
 * Extract a flat {key: value} dictionary from the live config object.
 * Only the keys that are swappable by presets are included.
 */
export function makePresetParams(config) {
  // Support both nested (live config object) and flat (user-config.json) structures.
  const m = config.management ?? {};
  const s = config.screening ?? {};
  const sc = config.schedule ?? {};
  const st = config.strategy ?? {};
  const f = (nested, key) => nested ?? config[key];
  return {
    // strategy
    strategy: f(st.strategy, "strategy"),
    minBinsBelow: f(st.minBinsBelow, "minBinsBelow"),
    maxBinsBelow: f(st.maxBinsBelow, "maxBinsBelow"),
    defaultBinsBelow: f(st.defaultBinsBelow, "defaultBinsBelow"),

    // screening
    timeframe: f(s.timeframe, "timeframe"),
    minOrganic: f(s.minOrganic, "minOrganic"),
    minQuoteOrganic: f(s.minQuoteOrganic, "minQuoteOrganic"),
    minHolders: f(s.minHolders, "minHolders"),
    minMcap: f(s.minMcap, "minMcap"),
    maxMcap: f(s.maxMcap, "maxMcap"),
    minTvl: f(s.minTvl, "minTvl"),
    maxTvl: f(s.maxTvl, "maxTvl"),
    minVolume: f(s.minVolume, "minVolume"),
    minFeeActiveTvlRatio: f(s.minFeeActiveTvlRatio, "minFeeActiveTvlRatio"),
    minTokenFeesSol: f(s.minTokenFeesSol, "minTokenFeesSol"),

    // management
    takeProfitPct: f(m.takeProfitPct, "takeProfitPct"),
    stopLossPct: f(m.stopLossPct, "stopLossPct"),
    outOfRangeWaitMinutes: f(m.outOfRangeWaitMinutes, "outOfRangeWaitMinutes"),
    trailingTakeProfit: f(m.trailingTakeProfit, "trailingTakeProfit"),
    trailingTriggerPct: f(m.trailingTriggerPct, "trailingTriggerPct"),
    trailingDropPct: f(m.trailingDropPct, "trailingDropPct"),
    positionSizePct: f(m.positionSizePct, "positionSizePct"),
    gasReserve: f(m.gasReserve, "gasReserve"),
    maxDeployAmount: f(m.maxDeployAmount, "maxDeployAmount"),
    minFeePerTvl24h: f(m.minFeePerTvl24h, "minFeePerTvl24h"),
    minAgeBeforeYieldCheck: f(m.minAgeBeforeYieldCheck, "minAgeBeforeYieldCheck"),
    minClaimAmount: f(m.minClaimAmount, "minClaimAmount"),
    oorCooldownTriggerCount: f(m.oorCooldownTriggerCount, "oorCooldownTriggerCount"),
    oorCooldownHours: f(m.oorCooldownHours, "oorCooldownHours"),
    deployAmountSol: f(m.deployAmountSol, "deployAmountSol"),
    outOfRangeBinsToClose: f(m.outOfRangeBinsToClose, "outOfRangeBinsToClose"),
    minSolToOpen: f(m.minSolToOpen, "minSolToOpen"),

    // schedule
    managementIntervalMin: f(sc.managementIntervalMin, "managementIntervalMin"),
    screeningIntervalMin: f(sc.screeningIntervalMin, "screeningIntervalMin"),

    // cooldown & drawdown
    repeatDeployCooldownEnabled: f(m.repeatDeployCooldownEnabled, "repeatDeployCooldownEnabled"),
    repeatDeployCooldownTriggerCount: f(m.repeatDeployCooldownTriggerCount, "repeatDeployCooldownTriggerCount"),
    repeatDeployCooldownHours: f(m.repeatDeployCooldownHours, "repeatDeployCooldownHours"),
    repeatDeployCooldownScope: f(m.repeatDeployCooldownScope, "repeatDeployCooldownScope"),
    repeatDeployCooldownMinFeeEarnedPct: f(m.repeatDeployCooldownMinFeeEarnedPct, "repeatDeployCooldownMinFeeEarnedPct"),
    drawdownRecoveryEnabled: f(m.drawdownRecoveryEnabled, "drawdownRecoveryEnabled"),
    drawdownRecoveryTriggerPct: f(m.drawdownRecoveryTriggerPct, "drawdownRecoveryTriggerPct"),
    drawdownRecoveryTakeProfitPct: f(m.drawdownRecoveryTakeProfitPct, "drawdownRecoveryTakeProfitPct"),
  };
}

// --- preset definitions (from setup.js) ---

export const PRESETS = {
  degen: {
    label: "Degen",
    description: "Fast cycles, max aping. Trades regularly. Higher risk, higher yield.",
    params: {
      strategy: "bid_ask",
      minBinsBelow: 35,
      maxBinsBelow: 100,
      defaultBinsBelow: 100,
      timeframe: "30m",
      minOrganic: 60,
      minQuoteOrganic: 60,
      minHolders: 1000,
      minMcap: 150_000,
      maxMcap: 5_000_000,
      minTvl: 5_000,
      maxTvl: 100_000,
      minVolume: 1_000,
      minFeeActiveTvlRatio: 0.15,
      minTokenFeesSol: 20,
      takeProfitPct: 10,
      stopLossPct: -25,
      outOfRangeWaitMinutes: 15,
      trailingTakeProfit: true,
      trailingTriggerPct: 2,
      trailingDropPct: 1,
      positionSizePct: 0.5,
      gasReserve: 0.15,
      maxDeployAmount: 50,
      minFeePerTvl24h: 20,
      minAgeBeforeYieldCheck: 30,
      minClaimAmount: 3,
      oorCooldownTriggerCount: 3,
      oorCooldownHours: 8,
      managementIntervalMin: 5,
      screeningIntervalMin: 15,
      repeatDeployCooldownEnabled: false,
      repeatDeployCooldownTriggerCount: 0,
      repeatDeployCooldownHours: 4,
      repeatDeployCooldownScope: "pool",
      repeatDeployCooldownMinFeeEarnedPct: 0,
      drawdownRecoveryEnabled: false,
      drawdownRecoveryTriggerPct: -25,
      drawdownRecoveryTakeProfitPct: 2,
    },
  },

  moderate: {
    label: "Moderate",
    description: "Balanced, recommended default. Moderate cycle frequency.",
    params: {
      strategy: "spot",
      minBinsBelow: 20,
      maxBinsBelow: 50,
      defaultBinsBelow: 30,
      timeframe: "1h",
      minOrganic: 65,
      minQuoteOrganic: 65,
      minHolders: 3000,
      minMcap: 300_000,
      maxMcap: 10_000_000,
      minTvl: 10_000,
      maxTvl: 150_000,
      minVolume: 2_000,
      minFeeActiveTvlRatio: 0.4,
      minTokenFeesSol: 15,
      takeProfitPct: 6,
      stopLossPct: -15,
      outOfRangeWaitMinutes: 30,
      trailingTakeProfit: true,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      positionSizePct: 0.35,
      gasReserve: 0.2,
      maxDeployAmount: 40,
      minFeePerTvl24h: 25,
      minAgeBeforeYieldCheck: 60,
      minClaimAmount: 5,
      oorCooldownTriggerCount: 3,
      oorCooldownHours: 8,
      managementIntervalMin: 10,
      screeningIntervalMin: 30,
      repeatDeployCooldownEnabled: true,
      repeatDeployCooldownTriggerCount: 2,
      repeatDeployCooldownHours: 8,
      repeatDeployCooldownScope: "pool",
      repeatDeployCooldownMinFeeEarnedPct: 1,
      drawdownRecoveryEnabled: true,
      drawdownRecoveryTriggerPct: -15,
      drawdownRecoveryTakeProfitPct: 2,
    },
  },

  safe: {
    label: "Safe",
    description: "Slow and steady. Long-term holds, higher conviction. Fewer trades, lower risk.",
    params: {
      strategy: "spot",
      minBinsBelow: 10,
      maxBinsBelow: 30,
      defaultBinsBelow: 20,
      timeframe: "4h",
      minOrganic: 80,
      minQuoteOrganic: 75,
      minHolders: 5000,
      minMcap: 500_000,
      maxMcap: 10_000_000,
      minTvl: 20_000,
      maxTvl: 200_000,
      minVolume: 10_000,
      minFeeActiveTvlRatio: 2.0,
      minTokenFeesSol: 50,
      takeProfitPct: 3,
      stopLossPct: -10,
      outOfRangeWaitMinutes: 60,
      trailingTakeProfit: true,
      trailingTriggerPct: 5,
      trailingDropPct: 2,
      positionSizePct: 0.25,
      gasReserve: 0.25,
      maxDeployAmount: 30,
      minFeePerTvl24h: 30,
      minAgeBeforeYieldCheck: 90,
      minClaimAmount: 5,
      oorCooldownTriggerCount: 3,
      oorCooldownHours: 12,
      managementIntervalMin: 15,
      screeningIntervalMin: 60,
      repeatDeployCooldownEnabled: true,
      repeatDeployCooldownTriggerCount: 3,
      repeatDeployCooldownHours: 12,
      repeatDeployCooldownScope: "pool",
      repeatDeployCooldownMinFeeEarnedPct: 3,
      drawdownRecoveryEnabled: true,
      drawdownRecoveryTriggerPct: -10,
      drawdownRecoveryTakeProfitPct: 2,
    },
  },

  custom: {
    label: "Custom",
    description: "Your own config — whatever was set when custom was last saved.",
    params: null,
  },
};
