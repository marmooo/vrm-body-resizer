/**
 * VRM Exporter — public facade.
 * Implementation lives in ./export/* (split for maintainability).
 * Prefer importing from here so existing call sites stay stable.
 */
export {
    VRMExport,
    DEFAULT_EXPORT_OPTIONS,
    splitBuffer,
    bindBuffers,
    getData,
    putData,
    conversion,
    tryPatchExport,
    isPatchCandidateMeta,
    patchLipOntoGlb,
    lipTextureToPngBytes,
    patchTexturesOntoGlb,
    patchMaterialColorsOntoGlb,
    stripLipPaintFromGlb,
    repairEyeImagesFromPristine,
    isolateEyeImagesFromFaceShare,
    normalizeEyeBlendModeToCutout, fixEyeTransparentCutoff,
    compressIsolatedEyeImages,
    assertExportContracts,
    diagnoseGlbEyeState,
    classifyEditKinds,
    resolveExportPath,
    decideExportRoute,
    exportOptsNeedReencode,
    stripLipTexturesForExport,
    restoreLipTexturesAfterExport,
} from "./export/index.js";
