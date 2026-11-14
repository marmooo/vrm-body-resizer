/**
 * Morpholith export — default export options.
 */
export const DEFAULT_EXPORT_OPTIONS = {
    /** Scale relative to each texture's original width/height (1 = 100%). */
    textureScale: 1,
    /**
     * Texture compress mode:
     *  - "whenNeeded": 未編集は元バイトをパススルー（高速）。
     *      再エンコードは (1) アプリが生成・編集したテクスチャ
     *      (2) 解像度を 100% 未満にしたとき のみ。
     *  - "always": 全テクスチャを textureFormat + textureQuality で再エンコードを試行。
     *      結果が元バイト以上のサイズなら元を採用（軽量化の退行防止）。
     *      生成・編集テクスチャや flipY 必須のものは常に再エンコード結果を使う。
     *      （サイズ比較は whenNeeded で再エンコードする場合にも同様に適用）
     */
    textureCompressMode: "whenNeeded",
    /**
     * Output image format strategy:
     *  - "webp": all textures as image/webp (alpha supported)
     *  - "png-jpeg": opaque → JPEG, alpha/cutout → PNG
     */
    textureFormat: "webp",
    /** 0–1 quality for lossy JPEG / WebP (ignored for PNG). */
    textureQuality: 0.92,
    /** @deprecated kept for older UI; mapped to textureQuality / textureFormat */
    jpegQuality: 0.92,
    /** @deprecated mapped: true→png-jpeg always-ish, false→png-only behavior via format */
    useJpegForOpaque: true,
    /** KHR_draco_mesh_compression on mesh primitives (default off). */
    draco: false,
    /** Draco encode speed 0–10 (higher = faster, larger). Default 5. */
    dracoEncodeSpeed: 5,
    /** Encode morph targets as sparse accessors. */
    sparseMorph: true,
    /** Drop morph normals. */
    omitMorphNormals: true,

    // ── Debug / fast-path switches (default off; production unchanged) ──
    /**
     * Master switch for debug export. When true, enables:
     * skipTextures, skipMorphTargets, skipSpringBones, and forces draco off.
     * Shape-only VRM for quick iteration; not for shipping.
     */
    debugFast: false,
    /** Replace every image with a 1×1 white PNG (skips encode/passthrough). */
    skipTextures: false,
    /** Omit morph targets from meshes (base mesh only). */
    skipMorphTargets: false,
    /** Skip VRMC_springBone / secondaryAnimation blocks. */
    skipSpringBones: false,

    /**
     * Hybrid seed switches (for regression isolation).
     * skipImageSeed: do not pre-copy image BIN from originalGlbBuffer.
     * skipMaterialSeed: do not pre-copy materials / VRM0 materialProperties.
     * Both default false (seed on). Set true to force full rebuild path.
     * Can also set via URL ?skipImageSeed=1&skipMaterialSeed=1
     * or window.__exportSeed = { images:false, materials:false }
     */
    skipImageSeed: false,
    skipMaterialSeed: false,
    skipBodyBake: false,
    skipLipExport: false,
    /** App-level glb-lip-patch only; never APPEND Face_SKIN inside VRMExport. */
    skipInternalLipPatch: true,
    /** @deprecated UI removed 2026-09; kept false for API compat */
    skipEstimateExport: false,

    /**
     * Console noise for export:
     *  - "silent": failures only
     *  - "warn": path / size / seed / patch (default)
     *  - "verbose": every texture/material detail
     */
    logLevel: "warn",
};


/**
 * Resolve effective flags after applying debugFast master switch.
 * @param {Partial<typeof DEFAULT_EXPORT_OPTIONS>} opts
 */
export function resolveExportFlags(opts) {
    const o = Object.assign({}, DEFAULT_EXPORT_OPTIONS, opts || {});
    if (o.debugFast) {
        o.skipTextures = true;
        o.skipMorphTargets = true;
        o.skipSpringBones = true;
        o.draco = false;
    }
    return o;
}
