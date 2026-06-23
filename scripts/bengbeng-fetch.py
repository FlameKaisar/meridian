#!/usr/bin/env python3
"""
Fetch Meridian wallet Meteora DLMM portfolio from public API,
build bengbeng-explainer-v2-compatible JSON, save to file.

Source: https://dlmm.datapi.meteora.ag (public, no auth)
Bengbeng schema reference: ~/.hermes/cache/documents/doc_*bengbeng*.json

Usage:
  python3 /tmp/meridian_bengbeng.py [--days 30] [--min-deposit 20] [--out PATH]
"""
import argparse
import json
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
import urllib.request


BASE = "https://dlmm.datapi.meteora.ag"
WALLET = "GbW7xQkCAsz44QPh8h5x3iV2GxEoZktDEfQ8Ek8RP5sz"
SOL_MINT = "So11111111111111111111111111111111111111112"
MIN_DEPOSIT_USD_DEFAULT = 20.0


def http_get_json(url: str, timeout: int = 20):
    """GET URL, return parsed JSON. No auth, no rate limiting."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "MeridianDailyAnalysis/1.1 (Hermes Agent)",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read().decode("utf-8")
    return json.loads(body)


def get_portfolio(user: str, days_back: int = 30, page_size: int = 50):
    """Pool-level aggregated portfolio over last N days."""
    qs = urlencode({"user": user, "page": 1, "page_size": page_size, "days_back": days_back})
    return http_get_json(f"{BASE}/portfolio?{qs}")


def get_pool_positions(user: str, pool_address: str, status: str = "closed", page_size: int = 20):
    """Per-position detail for one pool. status=open|closed|all"""
    qs = urlencode({"user": user, "status": status, "page": 1, "page_size": page_size})
    return http_get_json(f"{BASE}/positions/{pool_address}/pnl?{qs}")


def fetch_all_positions(user: str, days_back: int, min_deposit_usd: float):
    """
    Fetch pool-level → for each pool, fetch per-position detail.
    Yield individual positions with computed shape/bins/pct-below-above.
    """
    portfolio = get_portfolio(user, days_back=days_back)
    pools = portfolio.get("pools", [])
    print(f"[i] {len(pools)} pools in last {days_back}d", file=sys.stderr)

    for pool in pools:
        # Skip pools below min_deposit
        total_deposit_usd = float(pool.get("totalDeposit", 0))
        if total_deposit_usd < min_deposit_usd:
            print(f"  - skip {pool['tokenX']}/{pool['tokenY']} (deposit ${total_deposit_usd:.2f} < ${min_deposit_usd})", file=sys.stderr)
            continue

        pool_addr = pool["poolAddress"]
        bin_step = int(pool.get("binStep", 0))
        try:
            detail = get_pool_positions(user, pool_addr, status="closed")
        except Exception as e:
            print(f"  ! error fetching {pool_addr}: {e}", file=sys.stderr)
            continue

        for pos in detail.get("positions", []):
            if not pos.get("isClosed"):
                continue
            # Filter position-level by deposit too
            pos_deposit_usd = float(pos.get("allTimeDeposits", {}).get("total", {}).get("usd", 0))
            if pos_deposit_usd < min_deposit_usd:
                continue

            yield pos, pool, bin_step
        time.sleep(0.15)  # be polite


def compute_shape_from_pct(pct_below: float, pct_above: float, asymmetry_threshold: float = 5.0):
    """
    Determine shape from bucket asymmetry.
    asymmetry = |pct_below| / |pct_above|

    single-down: below-dominant (asymmetry > threshold, pct_below much bigger magnitude)
    single-up:   above-dominant (asymmetry > threshold, pct_above much bigger magnitude)
    double:      balanced (asymmetry <= threshold)

    Note: pct_below is always ≤ 0, pct_above can be ± (per our convention).
    For schema compat, we use |magnitudes| as comparator.
    """
    below_mag = abs(pct_below)
    above_mag = abs(pct_above)
    if below_mag == 0 and above_mag == 0:
        return "double"
    if above_mag == 0:
        return "single-down"
    if below_mag == 0:
        return "single-up"
    ratio = below_mag / above_mag
    if ratio >= asymmetry_threshold:
        return "single-down"  # way more below than above
    if ratio <= 1.0 / asymmetry_threshold:
        return "single-up"    # way more above than below
    return "double"


def compute_shape(min_price: float, max_price: float, active_price: float):
    """
    Fallback shape detection using current active price position.
    Only used when pct-based shape can't be computed.
    """
    if active_price >= max_price:
        return "single-up"
    if active_price <= min_price:
        return "single-down"
    return "double"


def compute_pct_ranges(min_price: float, max_price: float):
    """
    Compute bucket-level pct ranges as per bengbeng-explainer-v2 schema.

    Schema semantics (verified from doc_f7d37c69 sample, 2026-06-21):
    - pct_below_entry: % distance from ENTRY to min_price (lower bound)
      (e.g. -0.5017 = lower bin is 50.17% BELOW entry)
    - pct_above_entry: % distance from ENTRY to max_price (upper bound)
      (e.g. -0.0099 = upper bin is 0.99% above entry, stored negative)

    Both values represent distance from entry in their respective direction.
    Convention:
      - pct_below_entry: negative when min_price < entry (typical for all positions)
      - pct_above_entry: stored as signed value relative to entry (positive if above entry)
        BUT for single-down samples we see BOTH negative, so the schema appears to
        normalize pct_above to a "bucket asymmetry" metric where negative = "below the
        upper bound's natural symmetric extension."

    For accurate bucket values, ENTRY PRICE must be known.
    Meteora API doesn't return it directly for closed positions, so we approximate
    using the midpoint of the bin range (geometric mean):
        entry_price ≈ sqrt(min_price * max_price)
    This is a good approximation for Meteora's evenly-spaced bin ranges.

    Then:
        pct_below_entry = min_price / entry_price - 1  (always ≤ 0)
        pct_above_entry = max_price / entry_price - 1  (always ≥ 0)
    """
    if min_price <= 0 or max_price <= 0:
        return 0.0, 0.0
    if min_price >= max_price:
        return 0.0, 0.0
    # Geometric mean as entry approximation
    entry_price = (min_price * max_price) ** 0.5
    pct_below_signed = (min_price / entry_price - 1.0)  # always negative
    pct_above_signed = (max_price / entry_price - 1.0)  # always positive
    return pct_below_signed, pct_above_signed


_DEXSCREENER_BASE = "https://api.dexscreener.com/latest/dex/tokens"
_TOKEN_MC_CACHE: dict[str, float | None] = {}


def get_token_market_cap_usd(mint: str) -> float | None:
    """
    Fetch current market cap (USD) for a Solana token via DexScreener.
    Returns the meteora pool's marketCap if found, else None.
    Cached in-process.
    """
    if mint in _TOKEN_MC_CACHE:
        return _TOKEN_MC_CACHE[mint]
    if not mint:
        _TOKEN_MC_CACHE[mint] = None
        return None
    try:
        req = urllib.request.Request(
            f"{_DEXSCREENER_BASE}/{mint}",
            headers={"User-Agent": "MeridianDailyAnalysis/1.1", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
        for pair in data.get("pairs", []) or []:
            if pair.get("dexId") == "meteora" and pair.get("chainId") == "solana":
                mc = float(pair.get("marketCap") or 0) or float(pair.get("fdv") or 0)
                _TOKEN_MC_CACHE[mint] = mc if mc > 0 else None
                return _TOKEN_MC_CACHE[mint]
        # Fallback to first pair
        if data.get("pairs"):
            mc = float(data["pairs"][0].get("marketCap") or 0) or float(data["pairs"][0].get("fdv") or 0)
            _TOKEN_MC_CACHE[mint] = mc if mc > 0 else None
            return _TOKEN_MC_CACHE[mint]
        _TOKEN_MC_CACHE[mint] = None
        return None
    except Exception as e:
        print(f"  ! DexScreener error for {mint[:8]}...: {e}", file=sys.stderr)
        _TOKEN_MC_CACHE[mint] = None
        return None


def get_token_meta(mint: str):
    """Lazy: no external metadata service; rely on Jupiter or DexScreener if needed."""
    # For now, just return None — caller uses pool's tokenX/tokenY name
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default=WALLET, help="Solana wallet address")
    ap.add_argument("--days", type=int, default=30, help="days_back window")
    ap.add_argument("--min-deposit", type=float, default=MIN_DEPOSIT_USD_DEFAULT, help="min deposit USD")
    ap.add_argument("--out", default="/tmp/meridian_bengbeng.json", help="output JSON path")
    args = ap.parse_args()

    fetched_at = int(time.time())
    exported_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    window_from_iso = datetime.fromtimestamp(fetched_at - args.days * 86400, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    window_to_iso = exported_iso

    positions_out = []
    skipped = 0
    for pos, pool, bin_step in fetch_all_positions(args.user, args.days, args.min_deposit):
        min_p = float(pos["minPrice"])
        max_p = float(pos["maxPrice"])
        active_p = float(pos["poolActivePrice"])
        is_out = pos.get("isOutOfRange", False)
        lower_bin = int(pos["lowerBinId"])
        upper_bin = int(pos["upperBinId"])
        bin_count = upper_bin - lower_bin + 1

        # Compute bucket asymmetry (pct_below, pct_above) — geometric mean entry approximation
        pct_below, pct_above = compute_pct_ranges(min_p, max_p)
        # Shape detection: use ratio of |below|/|above|
        # Threshold 1.5 means below must be ≥50% larger than above for single-down (and vice versa)
        below_mag = abs(pct_below)
        above_mag = abs(pct_above)
        if above_mag > 0:
            ratio = below_mag / above_mag
        elif below_mag > 0:
            ratio = float("inf")
        else:
            ratio = 1.0
        if ratio >= 1.5:
            shape = "single-down"
        elif ratio <= 1.0 / 1.5:
            shape = "single-up"
        else:
            shape = "double"
        # Override using active price position (more accurate for closed positions
        # where entry != geometric mean of range)
        if is_out:
            if active_p <= min_p:
                shape = "single-down"
            elif active_p >= max_p:
                shape = "single-up"
        elif active_p <= min_p * 1.02:  # within 2% of lower bound → close to bottom
            shape = "single-down"
        elif active_p >= max_p * 0.98:  # within 2% of upper bound → close to top
            shape = "single-up"

        created_at = int(pos["createdAt"])
        closed_at = int(pos.get("closedAt", created_at))
        held_seconds = closed_at - created_at

        deposit_total = pos.get("allTimeDeposits", {}).get("total", {})
        withdrawal_total = pos.get("allTimeWithdrawals", {}).get("total", {})
        fees_total = pos.get("allTimeFees", {}).get("total", {})

        base_ticker = pool.get("tokenX", "UNKNOWN")
        quote_ticker = pool.get("tokenY", "SOL")
        if quote_ticker != "SOL":
            # Skip non-SOL pairs (rare; Jupiter/SOL, USDC/SOL only)
            skipped += 1
            continue

        # Real-time market cap via DexScreener (current value, not historical)
        market_cap_usd = get_token_market_cap_usd(pool.get("tokenXMint", ""))

        out = {
            "position_address": pos["positionAddress"],
            "pool_address": pool["poolAddress"],
            "pair": f"{base_ticker}/{quote_ticker}",
            "base_ticker": base_ticker,
            "quote_ticker": quote_ticker,
            "base_mint": pool.get("tokenXMint", ""),
            "quote_mint": pool.get("tokenYMint", SOL_MINT),
            "bin_step_bp": bin_step,
            "is_closed": bool(pos.get("isClosed", True)),
            "created_at": datetime.fromtimestamp(created_at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "closed_at": datetime.fromtimestamp(closed_at, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "held_seconds": held_seconds,
            "shape": shape,
            "bin_count": bin_count,
            "pct_below_entry": round(pct_below, 6),
            "pct_above_entry": round(pct_above, 6),
            # Real-time MC via DexScreener (historical MC at createdAt would require paid API)
            # Field name matches bengbeng-explainer-v2 schema
            "entry_market_cap_usd": round(market_cap_usd, 2) if market_cap_usd else None,
            "market_cap_source": "dexscreener_current" if market_cap_usd else None,
            "market_cap_note": "current MC, not historical at position_created",
            "pool_total_deposit_usd": round(float(pool.get("totalDeposit", 0)), 2),
            "pool_total_positions": pool.get("totalPositions", 1),
            "deposit_total_usd": float(deposit_total.get("usd", 0)),
            "withdrawal_total_usd": float(withdrawal_total.get("usd", 0)),
            "fees_total_usd": float(fees_total.get("usd", 0)),
            "pnl_usd": float(pos.get("pnlUsd", 0)),
            "pnl_sol": float(pos.get("pnlSol", 0)),
            "pnl_pct_quote": float(pos.get("pnlPctChange", 0)),
            "wallet": args.user[:5] + "…" + args.user[-4:],
            # Extra metadata for analysis (not in schema, useful for debugging)
            "is_out_of_range": is_out,
            "fee_per_tvl_24h": float(pos.get("feePerTvl24h", 0)),
            "pool_active_price": active_p,
            "lower_bin_id": lower_bin,
            "upper_bin_id": upper_bin,
        }
        positions_out.append(out)
        time.sleep(0.05)

    # Build suggested_prompt from template (same as bengbeng-explainer-v2 schema)
    suggested_prompt = SUGGESTED_PROMPT_TEMPLATE

    output = {
        "schema": "bengbeng-explainer-v2",
        "wallets": [args.user],
        "exported_at": exported_iso,
        "window": {
            "from": window_from_iso,
            "to": window_to_iso,
        },
        "min_deposit_usd": args.min_deposit,
        "count": len(positions_out),
        "suggested_prompt": suggested_prompt,
        "positions": positions_out,
    }

    with open(args.out, "w") as f:
        json.dump(output, f, indent=2)

    print(f"[+] Wrote {len(positions_out)} positions to {args.out} (skipped {skipped})", file=sys.stderr)


SUGGESTED_PROMPT_TEMPLATE = """You are analyzing a Meteora DLMM position dataset (one or more wallets, see the "wallets" array) to surface actionable patterns. Be terse. Treat the dataset as a single portfolio unless a pattern appears almost entirely in one wallet — in that case, name the wallet in the cluster line.

Output exactly three sections, no preamble. Use CONCRETE numeric ranges with units. NEVER use vague descriptors like "tight", "medium", "wide", "short", "long", "mid-cap", "large-cap".

Range bucket format depends on shape:
- single-up   → "range +X% to +Y% above"   (one direction only)
- single-down → "range −X% to −Y% below"   (one direction only)
- double      → "−X% to −Y% below / +A% to +B% above"   (BOTH sides, always)

Follow this exact format (numbers below are illustrative — derive yours from the data):

⚡ BEST PATTERNS (top 3, ranked by win rate then mean PnL)
1. single-up · MC $300k–$800k · range +500% to +1500% above · hold 12h–72h
   12 positions · 75% wr · mean +84% · median +12%
   top: $WIF May 12 (+27.9%), $BONK May 14 (+16.3%)
2. double · MC $5M–$15M · −5% to −15% below / +5% to +10% above · hold 4h–12h
   8 positions · 75% wr · mean +5.2% · median +3.8%
   top: $HYPE May 11 (+7.2%), $JTO May 09 (+4.1%)
3. single-down · MC $100k–$300k · range −60% to −90% below · hold 6h–24h
   5 positions · 80% wr · mean +18.4% · median +14%
   top: $PIGEON May 08 (+22%), $DUST May 09 (+15%)

❌ AVOID (worst 3, ranked by mean PnL ascending)
1. single-down · MC >$50M · range −30% to −90% below · hold 12h–48h
   6 positions · 17% wr · mean −22.5% · median −18%
   worst: $MEW May 10 (−55.5%), $POPCAT May 11 (−33.1%)
2. double · MC $1M–$10M · −30% to −50% below / +50% to +80% above · hold 4h–12h
   25 positions · 52% wr · mean −5.3% · median +0.8%
   worst: $BABYTROLL May 07 (−55.6%), $LMAO May 11 (−33.1%)
3. single-up · MC <$100k · range +1000% to +3000% above · hold <2h
   4 positions · 25% wr · mean −12.0% · median −8%
   worst: $RUG May 13 (−40%), $SCAM May 12 (−25%)

🎯 NEXT
double · MC $400k–$800k · −25% below / +35% above entry · hold 24h–48h
based on: $WIF (+27.9%), $PIGEON (+22%)

Hard rules:
- Cite positions as "$BASE_TICKER MMM DD (±X%)" using base_ticker + created_at + pnl_pct_quote. Do NOT print position_address — those are for JSON verification only.
- All bucket bounds MUST be numeric with units (USD with k/M/B, % with sign, h or d for duration). NEVER write qualitative descriptors.
- For "double" patterns, the range bucket MUST show both below-entry and above-entry bounds. Never use "width X%" or a single number for doubles — it hides whether the range is symmetric or asymmetric.
- Filter to is_closed=true. Each cluster needs ≥3 positions.
- If fewer than 3 qualifying clusters exist on either side, list as many as you have and note "INSUFFICIENT" for the missing slots.
- Total output ≤300 words. No prose, no caveats, no methodology, no compliments."""


if __name__ == "__main__":
    main()