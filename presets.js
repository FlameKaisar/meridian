/**
 * presets.js — Meridian strategy presets
 *
 * 3 built-in presets from setup.js + snapshot-based custom preset.
 * Each preset is a flat object of parameter changes that get piped
 * through executor.js update_config.
 *
 * The `custom` preset has params: null, meaning "use whatever is
 * currently in user-config.json".  At bot start / first preset call,
 * the current config is snapshot-cached as CUSTOM_SNAPSHOT.
 *
 * Keys that are NOT included in a preset (e.g. user-specific wallet
 * settings) are left untouched during a preset switch — see the
 * exclude list in applyPreset().
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

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
function makePresetParams(config) {
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

    // cooldown & drawdown — user requested these be swappable
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
      // strategy
      strategy: "bid_ask",
      minBinsBelow: 35,
      maxBinsBelow: 100,
      defaultBinsBelow: 100,

      // screening
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

      // management
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

      // schedule
      managementIntervalMin: 5,
      screeningIntervalMin: 15,

      // cooldown & drawdown
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
      strategy: "bid_ask",
      minBinsBelow: 35,
      maxBinsBelow: 69,
      defaultBinsBelow: 69,

      timeframe: "4h",
      minOrganic: 70,
      minQuoteOrganic: 70,
      minHolders: 2000,
      minMcap: 150_000,
      maxMcap: 10_000_000,
      minTvl: 10_000,
      maxTvl: 150_000,
      minVolume: 2_000,
      minFeeActiveTvlRatio: 0.4,
      minTokenFeesSol: 30,

      takeProfitPct: 5,
      stopLossPct: -15,
      outOfRangeWaitMinutes: 30,
      trailingTakeProfit: true,
      trailingTriggerPct: 3,
      trailingDropPct: 1.5,
      positionSizePct: 0.35,
      gasReserve: 0.2,
      maxDeployAmount: 50,
      minFeePerTvl24h: 25,
      minAgeBeforeYieldCheck: 60,
      minClaimAmount: 5,
      oorCooldownTriggerCount: 3,
      oorCooldownHours: 12,

      managementIntervalMin: 10,
      screeningIntervalMin: 30,

      repeatDeployCooldownEnabled: true,
      repeatDeployCooldownTriggerCount: 3,
      repeatDeployCooldownHours: 12,
      repeatDeployCooldownScope: "pool",
      repeatDeployCooldownMinFeeEarnedPct: 3,
      drawdownRecoveryEnabled: true,
      drawdownRecoveryTriggerPct: -15,
      drawdownRecoveryTakeProfitPct: 2,
    },
  },

  safe: {
    label: "Safe",
    description: "24h timeframe, stable pools only, avoids pumps. Lower yield, lower risk.",
    params: {
      strategy: "spot",
      minBinsBelow: 35,
      maxBinsBelow: 50,
      defaultBinsBelow: 50,

      timeframe: "24h",
      minOrganic: 75,
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
    params: null,  // populated from snapshot at switch time
  },
};

/**
 * Return the preset name string (degen / moderate / safe / custom)
 * stored in userConfig.preset. Default: "custom".
 */
export function getCurrentPreset(userConfig) {
  return userConfig?.preset || "custom";
}

/**
 * Return the display-friendly label for a preset name.
 */
export function getPresetLabel(name) {
  const p = PRESETS[name];
  return p ? p.label : "Unknown";
}

/**
 * Return true when `name` is a recognised built-in (not custom).
 */
export function isBuiltinPreset(name) {
  return name === 'degen' || name === 'moderate' || name === 'safe';
}

/**
 * Compute the diff between current config and a target preset.
 * Returns { changes: [{key, path, before, after}], unchangedCount }.
 */
export function computePresetDiff(name, currentConfig) {
  const preset = PRESETS[name];
  if (!preset) return { changes: [], unchangedCount: 0, error: `Unknown preset: ${name}` };
  const changes = [];
  let unchangedCount = 0;
  const USER_SPECIFIC_KEYS = new Set([
    'deployAmountSol', 'maxPositions', 'minSolToOpen',
    'publicApiKey', 'hiveMindApiKey', 'gmgnApiKey',
    'repeatDeployCooldownScope', 'repeatDeployCooldownTriggerCount',
    'repeatDeployCooldownHours', 'repeatDeployCooldownMinFeeEarnedPct',
    'repeatDeployCooldownEnabled', 'drawdownRecovery',
  ]);
  for (const [key, after] of Object.entries(preset.params)) {
    if (USER_SPECIFIC_KEYS.has(key)) continue;
    const before = getNestedValue(currentConfig, key);
    if (String(before) !== String(after)) {
      changes.push({ key, path: keyToPath(key), before, after });
    } else {
      unchangedCount++;
    }
  }
  return { changes, unchangedCount };
}

function keyToPath(key) {
  const parts = key.split('.');
  return parts[parts.length - 1];
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
}

/**
 * Build a list of param keys that should be applied for a given preset.
 * For built-in presets the params are static; for "custom" the params
 * come from the latest snapshot (or null if never taken).
 *
 * @param  {string} name  One of "degen", "moderate", "safe", "custom"
 * @param  {object} liveConfig  The current live config object (used
 *                              for snapshot fallback).
 * @return {object|null} Flat {key: value} dict, or null if unset.
 */
export function getPresetParams(name, liveConfig) {
  const p = PRESETS[name];
  if (!p) return null;
  if (p.params !== null) return { ...p.params };

  // custom — use snapshot or snapshot live
  if (CUSTOM_SNAPSHOT) return { ...CUSTOM_SNAPSHOT };
  if (liveConfig) {
    CUSTOM_SNAPSHOT = makePresetParams(liveConfig);
    return { ...CUSTOM_SNAPSHOT };
  }
  return null;
}

// ─── apply / save preset ─────────────────────────────

/** Keys preserved across preset switches (not overwritten). */
const USER_SPECIFIC_KEYS = new Set([
  "deployAmountSol",
  "maxPositions",
  "minSolToOpen",
  "publicApiKey",
  "agentMeridianApiUrl",
  "lpAgentRelayEnabled",
  "hiveMindUrl",
  "hiveMindApiKey",
  "agentId",
  "hiveMindPullMode",
  "pnlSource",
  "pnlRpcUrl",
  "pnlPollIntervalSec",
  "pnlDepositCacheTtlSec",
  "gmgnFeeSource",
  "gmgnApiKey",
]);

/**
 * Switch to a built-in preset (degen/moderate/safe).
 *
 * @param  {string} name  One of "degen", "moderate", "safe"
 * @param  {object} ctx   { config, executeTool }
 * @return {string}       Human-readable result
 */
export async function applyPreset(name, ctx) {
  const { executeTool } = ctx;
  let preset = PRESETS[name];

  // Custom preset from saved presets
  if (!preset && name !== 'custom') {
    const customParams = getCustomPresetParams(name);
    if (customParams) {
      preset = { params: customParams, label: name };
    }
  }

  if (!preset) {
    return `❌ Unknown preset "${name}". Available: degen, moderate, safe, or saved custom presets.`;
  }

  const params = { ...preset.params };
  const changes = {};
  const skipped = [];

  for (const [key, val] of Object.entries(params)) {
    if (USER_SPECIFIC_KEYS.has(key)) {
      skipped.push(key);
      continue;
    }
    changes[key] = val;
  }

  const result = await executeTool("update_config", {
    changes,
    reason: `preset: ${name}`,
  });

  if (!result?.success) {
    const unknown = (result?.unknown || []).join(", ");
    return `❌ Preset "${name}" apply failed.${unknown ? ` Unknown keys: ${unknown}` : ""}`;
  }

  // Persist preset label so formatConfigSnapshot & auto-custom work
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
    const ucfg = JSON.parse(raw);
    ucfg.preset = name;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(ucfg, null, 2));
  } catch (e) {
    console.error("presets: failed to write preset field:", e.message);
  }

  const label = preset.label || name;
  const lines = [
    `✅ Switched to **${label}** preset.`,
    `${Object.keys(changes).length} parameter(s) applied.`,
  ];
  if (skipped.length > 0) {
    lines.push(`Preserved: ${skipped.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Snapshot the current userConfig as a flat params dict (for custom preset
 * display / manual tweak detection).
 */
export function getCustomPreset(userConfig) {
  if (!userConfig) return null;
  return makePresetParams(userConfig);
}

/**
 * Save current config as a named custom preset snapshot.
 * Persists to customPresets field in user-config.json.
 */
export function saveCustomPreset(name, userConfig) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  if (!safeName) return { success: false, error: 'Invalid name (use a-z, 0-9, -, _)' };
  const snapshot = makePresetParams(userConfig);
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    const ucfg = JSON.parse(raw);
    if (!ucfg.customPresets) ucfg.customPresets = {};
    const isUpdate = !!ucfg.customPresets[safeName];
    ucfg.customPresets[safeName] = { params: snapshot, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(ucfg, null, 2));
    return { success: true, name: safeName, params: Object.keys(snapshot).length, updated: isUpdate };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * List all saved custom presets.
 */
export function listCustomPresets() {
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    const ucfg = JSON.parse(raw);
    const presets = ucfg.customPresets || {};
    return Object.entries(presets).map(([name, data]) => ({
      name,
      paramCount: Object.keys(data.params || {}).length,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    }));
  } catch (e) {
    return [];
  }
}

/**
 * Delete a saved custom preset.
 */
export function deleteCustomPreset(name) {
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    const ucfg = JSON.parse(raw);
    if (!ucfg.customPresets || !ucfg.customPresets[name]) {
      return { success: false, error: `Preset "${name}" not found` };
    }
    delete ucfg.customPresets[name];
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(ucfg, null, 2));
    return { success: true, name };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

/**
 * Get a custom preset's params by name.
 */
export function getCustomPresetParams(name) {
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, 'utf8');
    const ucfg = JSON.parse(raw);
    const cp = ucfg.customPresets?.[name];
    return cp?.params || null;
  } catch (e) {
    return null;
  }
}