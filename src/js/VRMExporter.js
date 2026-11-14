/**
 * VRM Exporter — public facade.
 * Implementation lives in ./export/* (split for maintainability).
 * Prefer importing from here so existing call sites stay stable.
 */
export {
  assertExportContracts,
  bindBuffers,
  classifyEditKinds,
  compressIsolatedEyeImages,
  conversion,
  decideExportRoute,
  DEFAULT_EXPORT_OPTIONS,
  diagnoseGlbEyeState,
  exportOptsNeedReencode,
  fixEyeTransparentCutoff,
  getData,
  isolateEyeImagesFromFaceShare,
  isPatchCandidateMeta,
  lipTextureToPngBytes,
  normalizeEyeBlendModeToCutout,
  patchLipOntoGlb,
  patchMaterialColorsOntoGlb,
  patchTexturesOntoGlb,
  putData,
  repairEyeImagesFromPristine,
  resolveExportPath,
  restoreLipTexturesAfterExport,
  splitBuffer,
  stripLipPaintFromGlb,
  stripLipTexturesForExport,
  tryPatchExport,
  VRMExport,
} from "./export/index.js";
