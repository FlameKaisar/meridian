/**
 * env-loader.js — Load .env before any other module evaluates.
 * ponytail: replacement for old envcrypt.js.
 *
 * ESM evaluates static imports before module-level code, so
 * `dotenv.config()` in index.js runs AFTER agent.js is already
 * parsed.  This tiny module fixes the ordering:
 * import "./env-loader.js" BEFORE importing agent.js.
 */
import dotenv from "dotenv";
dotenv.config({ override: true, quiet: true });
