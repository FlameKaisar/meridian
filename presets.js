/**
 * presets.js — Meridian strategy preset loader
 *
 * Loads preset data from presets-data.js and provides apply / save / list APIs.
 * ponytail: split from presets-data.js (data vs logic separation).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PRESETS, CUSTOM_SNAPSHOT, makePresetParams } from "./presets-data.js";
import { MIN_SAFE_BINS_BELOW } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

// ─── query helpers ──────────────────────────────────

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
  return name === "degen" || name === "moderate" || name === "safe";
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
    "deployAmountSol", "maxPositions", "minSolToOpen",
    "publicApiKey", "hiveMindApiKey", "gmgnApiKey",
    "repeatDeployCooldownScope", "repeatDeployCooldownTriggerCount",
    "repeatDeployCooldownHours", "repeatDeployCooldownMinFeeEarnedPct",
    "repeatDeployCooldownEnabled", "drawdownRecovery",
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
  const parts = key.split(".");
  return parts[parts.length - 1];
}

function getNestedValue(obj, path) {
  return path.split(".").reduce((o, k) => (o && o[k] !== undefined) ? o[k] : undefined, obj);
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
  let params;
  if (p.params !== null) {
    params = { ...p.params };
  } else if (CUSTOM_SNAPSHOT) {
    params = { ...CUSTOM_SNAPSHOT };
  } else if (liveConfig) {
    CUSTOM_SNAPSHOT = makePresetParams(liveConfig);
    params = { ...CUSTOM_SNAPSHOT };
  } else {
    return null;
  }

  // Normalize bin values to match what update_config would actually store
  const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
  for (const key of Object.keys(params)) {
    if (STRATEGY_BIN_KEYS.has(key)) {
      const n = Number(params[key]);
      params[key] = Number.isFinite(n) ? Math.max(MIN_SAFE_BINS_BELOW, Math.round(n)) : params[key];
    }
  }

  return params;
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
  if (!preset && name !== "custom") {
    const customParams = getCustomPresetParams(name);
    if (customParams) {
      preset = { params: customParams, label: name };
    }
  }

  if (!preset) {
    return `Unknown preset "${name}". Available: degen, moderate, safe, or saved custom presets.`;
  }

  const params = { ...preset.params };
  const changes = {};
  const skipped = [];

  for (const [key, val] of Object.entries(params)) {
    if (val === undefined) continue;
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
    return `Preset "${name}" apply failed.${unknown ? ` Unknown keys: ${unknown}` : ""}`;
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
    `Switched to **${label}** preset.`,
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

// ─── custom preset CRUD ──────────────────────────────

/**
 * Save current config as a named custom preset snapshot.
 * Persists to customPresets field in user-config.json.
 */
export function saveCustomPreset(name, userConfig) {
  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
  if (!safeName) return { success: false, error: "Invalid name (use a-z, 0-9, -, _)" };
  const snapshot = makePresetParams(userConfig);
  try {
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
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
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
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
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
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
    const raw = fs.readFileSync(USER_CONFIG_PATH, "utf8");
    const ucfg = JSON.parse(raw);
    return ucfg.customPresets?.[name]?.params ?? null;
  } catch (e) {
    return null;
  }
}
