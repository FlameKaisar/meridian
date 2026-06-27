/**
 * json-store.js — shared JSON load/save factory
 * ponytail: extracted from 9 duplicate implementations.
 * Add write-backpressure, atomic writes, or schema migration when one caller needs it.
 */
import fs from "fs";

export function jsonStore(filePath, defaults = {}) {
  return {
    load() {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch {
        return typeof defaults === "function" ? defaults() : defaults;
      }
    },
    save(data) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    },
  };
}
