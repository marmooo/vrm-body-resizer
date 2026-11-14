/**
 * Morpholith export — leveled logging to cut debug noise.
 *
 * logLevel (export options):
 *   - "silent"  … failures only
 *   - "warn"    … path decisions, size breakdown, seed/patch summary (default)
 *   - "verbose" … per-texture / per-material detail (DEDUPE, SEEDED, [mat], …)
 *
 * Usage:
 *   import { exportLog } from "./log.js";
 *   exportLog(state, "verbose", "[export] addTexture DEDUPE", …);
 *   exportLog(opts, "warn", "[export][patch] identity", …);
 */

const RANK = { silent: 0, warn: 1, verbose: 2 };

function resolveLevel(stateOrOpts) {
    if (!stateOrOpts) return "warn";
    const opts = stateOrOpts.exportOptions || stateOrOpts;
    const lv = opts && opts.logLevel;
    if (lv === "silent" || lv === "verbose" || lv === "warn") return lv;
    return "warn";
}

/**
 * @param {object} stateOrOpts  export state (with .exportOptions) or options object
 * @param {"silent"|"warn"|"verbose"} level  minimum level required to print
 * @param {...any} args  passed to console.warn
 */
export function exportLog(stateOrOpts, level, ...args) {
    const current = resolveLevel(stateOrOpts);
    const need = RANK[level] != null ? RANK[level] : RANK.warn;
    const have = RANK[current] != null ? RANK[current] : RANK.warn;
    if (have < need) return;
    // Always use console.warn so existing DevTools filters keep working
    try {
        console.warn(...args);
    } catch (e) {}
}

/** True when verbose detail logs are enabled. */
export function isExportVerbose(stateOrOpts) {
    return resolveLevel(stateOrOpts) === "verbose";
}
