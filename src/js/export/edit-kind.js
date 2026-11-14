/**
 * Edit kind classification for export routing.
 *
 * 設計原則（morpholith-export-status §45）:
 *   編集種 → 経路は 1 本だけ。preferred を計算してから上書きしない。
 *
 *   textureOnly  (lip 等)     → 必ず lastLoaded / lastGood への GLB バイナリパッチ
 *                                bake / VRMExport / makeScenes を呼ばない
 *   materialOnly (tint 等)    → GLB material パッチ（未実装時は identity に近い安全側）
 *   geometry     (体型・変形) → hybrid-seed / full VRMExport
 *   none                      → identity（元バッファそのまま）
 *
 * 例外: needsReencode（テクスチャ解像度 <100% / 常に圧縮 / Draco）のときは
 * identity・バイナリパッチを使わず hybrid-seed で再エンコードする。
 * さもないと「軽量」プリセットでも元ファイルサイズのままになる。
 */

/** reasons that require geometry rebuild */
export const GEOMETRY_REASONS = new Set([
    "bodyScale",
    "extraDeformers",
    "compXform",
    "nose",
    "contour",
    "nailsGeom",
    "estimateGeom",
    // solid/filter で推定目成分を groups 分割保護したとき（再読込で白目維持）
    "skinCompProtect",
    // つめ consolidation (Body_Nails 切り出し)
    "nailConsol",
]);

/** reasons that are texture-only patches */
export const TEXTURE_ONLY_REASONS = new Set([
    "lipPaint",
]);

/** reasons that are material factor / solid color only (no new image required) */
export const MATERIAL_ONLY_REASONS = new Set([
    "skinFilter",
    "skinSolid",
    "solidFill",
    // つめ filter (相対乗算 color/shade) / nailEdit フラグ
    "nailFilter",
    "nailEdit",
]);

/**
 * @param {string[]} reasons
 * @returns {{ textureOnly: boolean, materialOnly: boolean, geometry: boolean, kinds: string[] }}
 */
export function classifyEditKinds(reasons) {
    const rs = Array.isArray(reasons) ? reasons : [];
    let textureOnly = false;
    let materialOnly = false;
    let geometry = false;
    const unknown = [];
    for (const r of rs) {
        if (GEOMETRY_REASONS.has(r)) geometry = true;
        else if (TEXTURE_ONLY_REASONS.has(r)) textureOnly = true;
        else if (MATERIAL_ONLY_REASONS.has(r)) materialOnly = true;
        else {
            // Unknown reason → treat as geometry to be safe (hybrid/full path)
            geometry = true;
            if (unknown.indexOf(r) < 0) unknown.push(r);
        }
    }
    const kinds = [];
    if (geometry) kinds.push("geometry");
    if (textureOnly) kinds.push("textureOnly");
    if (materialOnly) kinds.push("materialOnly");
    return { textureOnly, materialOnly, geometry, kinds, unknownReasons: unknown };
}

/**
 * True when UI export options require re-encoding (scale / always-compress / draco).
 * Identity and binary patch paths return original image bytes and would ignore these.
 * @param {{ textureScale?: number, textureCompressMode?: string, draco?: boolean }} [opts]
 */
export function exportOptsNeedReencode(opts) {
    if (!opts) return false;
    if (opts.draco) return true;
    if (opts.textureScale != null && Number(opts.textureScale) < 0.999) return true;
    if (opts.textureCompressMode === "always") return true;
    return false;
}

/**
 * Decide preferred export strategy from dirty summary (legacy name).
 * Prefer decideExportRoute() for new code.
 * @param {{ reasons?: string[], geometry?: boolean, material?: boolean }} summary
 * @param {{ hasLastGood?: boolean, hasLipTex?: boolean, needsReencode?: boolean }} [ctx]
 * @returns {'identity'|'glb-texture-patch'|'glb-material-patch'|'hybrid-seed'|'full'}
 */
export function resolveExportPath(summary, ctx = {}) {
    return decideExportRoute(summary, ctx).path;
}

/**
 * Single source of truth for export routing.
 *
 * @param {{ reasons?: string[], geometry?: boolean, material?: boolean }} summary
 * @param {{
 *   hasLastGood?: boolean,
 *   hasLastLoaded?: boolean,
 *   bodyParamsUserEdited?: boolean,
 *   hasLipTex?: boolean,
 *   needsReencode?: boolean,
 * }} [ctx]
 * @returns {{
 *   path: 'identity'|'glb-texture-patch'|'glb-material-patch'|'hybrid-seed'|'full',
 *   base: 'lastGood'|'lastLoaded'|'none'|'rebuild',
 *   runBake: boolean,
 *   runVRMExport: boolean,
 *   textureOnly: boolean,
 *   materialOnly: boolean,
 *   geometry: boolean,
 *   kinds: string[],
 *   reason: string,
 * }}
 */
export function decideExportRoute(summary, ctx = {}) {
    const reasons = (summary && summary.reasons) || [];
    const ck = classifyEditKinds(reasons);
    const { textureOnly, materialOnly, geometry } = ck;
    const unknownReasons = ck.unknownReasons || [];
    if (unknownReasons.length) {
        try {
            console.warn("[export][route] unknown dirty reasons (treated as geometry):",
                unknownReasons.join(", "));
        } catch (e) {}
    }

    // Geometry from reasons or summary flag. bodyScale residual (import-time
    // non-1 scales) is ignored unless the user actually moved body sliders.
    const bodyEdited = !!ctx.bodyParamsUserEdited;
    const nonBodyGeomReason = reasons.some(r => GEOMETRY_REASONS.has(r) && r !== "bodyScale");
    const bodyScaleReason = reasons.includes("bodyScale");
    let geomFinal = nonBodyGeomReason || (bodyScaleReason && bodyEdited)
        || (!!(summary && summary.geometry) && bodyEdited && !textureOnly && !materialOnly);

    // Size-reduction options (軽量 preset etc.) cannot be applied on identity /
    // binary-patch paths that reuse original image BIN. Force hybrid rebuild.
    const needsReencode = !!ctx.needsReencode;

    // --- identity ---
    if (!reasons.length && !summary?.geometry && !summary?.material) {
        if (needsReencode) {
            return {
                path: "hybrid-seed",
                base: "rebuild",
                runBake: false,
                runVRMExport: true,
                textureOnly: false,
                materialOnly: false,
                geometry: false,
                kinds: [],
                reason: "no dirty reasons but needsReencode (texture scale/compress/draco) → hybrid-seed",
            };
        }
        return {
            path: "identity",
            base: ctx.hasLastLoaded ? "lastLoaded" : "none",
            runBake: false,
            runVRMExport: false,
            textureOnly: false,
            materialOnly: false,
            geometry: false,
            kinds: [],
            reason: "no dirty reasons",
        };
    }

    // --- textureOnly (lip) ± materialOnly (skinFilter residual) ---
    // NEVER bake / VRMExport when geometry was not user-edited — unless the
    // user asked for size reduction (must re-encode all textures).
    if (textureOnly && !geomFinal) {
        if (needsReencode) {
            return {
                path: "hybrid-seed",
                base: "rebuild",
                runBake: false,
                runVRMExport: true,
                textureOnly: true,
                materialOnly,
                geometry: false,
                kinds: ck.kinds.filter(k => k !== "geometry"),
                reason: "textureOnly + needsReencode → hybrid-seed then lip post-patch",
            };
        }
        const base = ctx.hasLastGood ? "lastGood"
            : (ctx.hasLastLoaded ? "lastLoaded" : "none");
        return {
            path: "glb-texture-patch",
            base,
            runBake: false,
            runVRMExport: false,
            textureOnly: true,
            materialOnly,
            geometry: false,
            kinds: ck.kinds.filter(k => k !== "geometry"),
            reason: base === "none"
                ? "textureOnly but no base buffer — caller must rebuild base first"
                : "textureOnly → GLB patch on " + base,
        };
    }

    // --- textureOnly + geometry (user edited body, then painted lip) ---
    // Bake base first (or use lastGood if still valid), then texture patch.
    // needsReencode: lastGood may still hold full-res textures → rebuild.
    if (textureOnly && geomFinal) {
        if (ctx.hasLastGood && !needsReencode) {
            return {
                path: "glb-texture-patch",
                base: "lastGood",
                runBake: false,
                runVRMExport: false,
                textureOnly: true,
                materialOnly,
                geometry: true,
                kinds: ck.kinds,
                reason: "textureOnly + geometry but lastGood available → patch lastGood",
            };
        }
        return {
            path: "hybrid-seed",
            base: "rebuild",
            runBake: true,
            runVRMExport: true,
            textureOnly: true,
            materialOnly,
            geometry: true,
            kinds: ck.kinds,
            reason: needsReencode
                ? "textureOnly + geometry + needsReencode → rebuild then lip post-patch"
                : "textureOnly + geometry, no lastGood → rebuild then in-export lip",
        };
    }

    // --- materialOnly without geometry ---
    if (materialOnly && !geomFinal && !textureOnly) {
        if (needsReencode) {
            return {
                path: "hybrid-seed",
                base: "rebuild",
                runBake: false,
                runVRMExport: true,
                textureOnly: false,
                materialOnly: true,
                geometry: false,
                kinds: ck.kinds,
                reason: "materialOnly + needsReencode → hybrid-seed",
            };
        }
        const base = ctx.hasLastGood ? "lastGood"
            : (ctx.hasLastLoaded ? "lastLoaded" : "none");
        return {
            path: "glb-material-patch",
            base,
            runBake: false,
            runVRMExport: false,
            textureOnly: false,
            materialOnly: true,
            geometry: false,
            kinds: ck.kinds,
            reason: "materialOnly → GLB material patch on " + base,
        };
    }

    // --- geometry ---
    if (geomFinal) {
        return {
            path: "hybrid-seed",
            base: "rebuild",
            runBake: true,
            runVRMExport: true,
            textureOnly,
            materialOnly,
            geometry: true,
            kinds: ck.kinds,
            unknownReasons,
            reason: unknownReasons.length
                ? ("geometry dirty → hybrid-seed; unknownReasons=" + unknownReasons.join("+"))
                : "geometry dirty → hybrid-seed",
        };
    }

    return {
        path: "full",
        unknownReasons,
        base: "rebuild",
        runBake: false,
        runVRMExport: true,
        textureOnly,
        materialOnly,
        geometry: false,
        kinds: ck.kinds,
        reason: "fallback full export",
    };
}
