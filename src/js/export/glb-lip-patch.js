/**
 * Backward-compatible re-exports. Prefer importing from ./glb-patch.js.
 */
export {
    parseGlb,
    packGlb,
    patchTexturesOntoGlb,
    patchMaterialColorsOntoGlb,
    patchLipOntoGlb,
    lipTextureToPngBytes,
    textureToPngBytes,
    stripLipPaintFromGlb,
    repairEyeImagesFromPristine,
    normalizeMaterialName
} from "./glb-patch.js";
