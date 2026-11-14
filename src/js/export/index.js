/**
 * Morpholith export — public entry (VRMExport).
 * Split from the former monolithic VRMExporter.js for lower debug cost.
 */
import { DEFAULT_EXPORT_OPTIONS, resolveExportFlags } from "./options.js";
import { init } from "./core.js";
import { makeScenes } from "./scene.js";
import { makeVRM } from "./vrm-ext.js";
import { applyDracoCompression } from "./draco.js";
import { makeGlb } from "./glb.js";
import { seedImagesFromOriginal, seedMaterialsFromOriginal } from "./seed-assets.js";
import { exportLog } from "./log.js";
import {
    stripLipTexturesForExport,
    restoreLipTexturesAfterExport,
    applyLipPatchesToState
} from "./lip-patch.js";


/** Dump material→texture→image chain; flag broken eye / out-of-range refs. */
function validateSeededMaterials(state) {
    try {
        const mats = state.materials || [];
        const texs = state.textures || [];
        const imgs = state.images || [];
        const props = (state.extensions && state.extensions.VRM
            && state.extensions.VRM.materialProperties) || [];
        const texSrc = (ti) => {
            if (ti == null || ti < 0 || ti >= texs.length) return "OOB:" + ti;
            const t = texs[ti];
            const src = t && t.source;
            if (src == null) return "tex" + ti + "→noSource";
            if (src < 0 || src >= imgs.length) return "tex" + ti + "→imgOOB:" + src;
            const img = imgs[src];
            const bv = img && img.bufferView != null && state.bufferViews
                ? state.bufferViews[img.bufferView] : null;
            const bytes = bv && bv.byteLength ? bv.byteLength : 0;
            return "tex" + ti + "→img" + src + "(" + bytes + "b," + (img.mimeType || "?") + ")";
        };
        // Per-material summary — eyes / skin / cloth / hair (black-clothing class)
        mats.forEach((m, i) => {
            const name = (m && m.name) || ("#" + i);
            const isEye = /eye|iris|highlight|pupil|瞳|目/i.test(name);
            const isBodyLike = /skin|face|lip|body|cloth|hair|hada|肌|体|服|髪|靴|shoe/i.test(name);
            const pbr = m && m.pbrMetallicRoughness;
            const baseTi = pbr && pbr.baseColorTexture && pbr.baseColorTexture.index;
            const prop = props[i];
            const mainTi = prop && prop.textureProperties && prop.textureProperties._MainTex;
            const shadeTi = prop && prop.textureProperties && prop.textureProperties._ShadeTexture;
            const line = [
                "i=" + i,
                name,
                "pbrBase=" + texSrc(baseTi),
                "vrm0Main=" + texSrc(mainTi),
                "vrm0Shade=" + texSrc(shadeTi),
                "propsName=" + ((prop && prop.name) || "-"),
                "shader=" + ((prop && prop.shader) || "-")
            ].join(" ");
            if (isEye || isBodyLike) {
                exportLog(state, "warn", "[export][validate]", line);
            }
            // Flag problems
            const check = (label, ti) => {
                if (ti == null) return;
                if (ti < 0 || ti >= texs.length) {
                    exportLog(state, "warn", "[export][validate] BAD", name, label, "texIndex", ti);
                    return;
                }
                const src = texs[ti] && texs[ti].source;
                if (src == null || src < 0 || src >= imgs.length) {
                    exportLog(state, "warn", "[export][validate] BAD", name, label, "imgSource", src);
                    return;
                }
                const img = imgs[src];
                const bv = img && img.bufferView != null && state.bufferViews
                    ? state.bufferViews[img.bufferView] : null;
                if (!bv || !bv.byteLength) {
                    exportLog(state, "warn", "[export][validate] BAD", name, label, "emptyImage", src);
                }
            };
            check("pbrBase", baseTi);
            check("vrm0Main", mainTi);
            check("vrm0Shade", shadeTi);
            if (isEye && prop && mainTi == null && baseTi == null) {
                exportLog(state, "warn", "[export][validate] eye has NO main texture slots", name, "i=" + i);
            }
            // Cloth/body/hair with no main texture → pure black MToon on reload
            if (isBodyLike && !isEye && mainTi == null && baseTi == null) {
                exportLog(state, "warn", "[export][validate] BODY/CLOTH has NO main texture", name, "i=" + i,
                    "(will render pure black)");
            }
        });
        // materials vs materialProperties length
        if (state.metaVersion == 0 && props.length !== mats.length) {
            exportLog(state, "warn", "[export][validate] LEN mismatch materials=", mats.length,
                "materialProperties=", props.length);
        }
        // Which mesh primitives point at which material (all body-ish)
        (state.meshes || []).forEach((mesh, mi) => {
            (mesh.primitives || []).forEach((pr, pi) => {
                const matIdx = pr.material;
                const mat = mats[matIdx];
                const nm = (mat && mat.name) || "?";
                if (/eye|iris|highlight|pupil|瞳|目|skin|face|body|cloth|hair|shoe|靴|服|髪/i.test(nm)
                    || /eye|iris|face|skin|body|hair/i.test(mesh.name || "")) {
                    exportLog(state, "warn", "[export][validate] prim",
                        "mesh=" + (mesh.name || mi), "p=" + pi, "matIdx=" + matIdx, "mat=" + nm);
                }
            });
        });
    } catch (e) {
        console.warn("[export][validate] failed", e);
    }
}



/** Deep-freeze Eye* materials right after seed; restore before pack so no path can alter them. */
function snapshotEyeMaterials(state) {
    const snap = [];
    try {
        (state.materials || []).forEach((m, i) => {
            const name = (m && m.name) || "";
            if (!/eye|iris|highlight|pupil|瞳|目/i.test(name)) return;
            let props = null;
            try {
                const list = state.extensions && state.extensions.VRM
                    && state.extensions.VRM.materialProperties;
                if (list && list[i]) props = JSON.parse(JSON.stringify(list[i]));
            } catch (e) {}
            snap.push({
                index: i,
                material: JSON.parse(JSON.stringify(m)),
                props
            });
        });
    } catch (e) {}
    state._eyeMaterialSnapshot = snap;
    if (snap.length) {
        exportLog(state, "warn", "[export][eye-freeze] snapshot count=", snap.length,
            "idx=", snap.map(s => s.index).join(","));
    }
}

function restoreEyeMaterials(state) {
    const snap = state._eyeMaterialSnapshot;
    if (!snap || !snap.length) return;
    snap.forEach((s) => {
        if (s.index == null || !state.materials[s.index]) return;
        try {
            state.materials[s.index] = JSON.parse(JSON.stringify(s.material));
            if (s.props && state.extensions && state.extensions.VRM
                && Array.isArray(state.extensions.VRM.materialProperties)) {
                state.extensions.VRM.materialProperties[s.index] =
                    JSON.parse(JSON.stringify(s.props));
            }
        } catch (e) {}
    });
    // v6: restore snapshot as-is (no Cutout force). Shared atlas + original
    // Transparent blendMode matches pristine VRoid eyes.
    exportLog(state, "warn", "[export][eye-freeze] restored count=", snap.length,
        "(no-cutout, shared-atlas path)");
}

export async function VRMExport(originalVrm, metaVersion = 1, exportOptions = {}) {
    const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const state = {};
    state.org = originalVrm;
    state.metaVersion = metaVersion;
    state.exportOptions = resolveExportFlags(exportOptions);
    // VRM0 disk coords (forward -Z) → VRM1 (forward +Z) needs Y-180° ≡ (-x, y, -z).
    // three-vrm leaves local TRS/geometry in VRM0 file space and only rotates the
    // scene root via rotateVRM0 for display — so when source is VRM0 and we write
    // VRM1, we must apply this conversion or humanoid animations face the wrong way.
    let sourceIsVrm0 = false;
    try {
        const mv = originalVrm && originalVrm.meta && originalVrm.meta.metaVersion;
        sourceIsVrm0 = (mv === "0" || mv === 0);
    } catch (e) { /* ignore */ }
    state.sourceIsVrm0 = sourceIsVrm0;
    // flipAxis: apply (-x,y,-z) to positions / normals / node TRS / IBMs
    state.flipAxis = sourceIsVrm0 && (metaVersion === 1 || metaVersion === "1");
    // Also when writing VRM0 format from live scene (legacy path used the same flip)
    if (metaVersion === 0 || metaVersion === "0") state.flipAxis = true;
    init(state);
    if (state.flipAxis) {
        exportLog(state, "warn", "[export] flipAxis ON (VRM0→VRM1 coordinate conversion)");
    }

    const opts = state.exportOptions;
    // Geometry rebuild + untouched textures: pre-copy image BIN from source GLB
    // (images + materials share one GLB parse via ensureOriginalGlbParsed)
    if (opts.originalGlbBuffer && !opts.skipTextures && !opts.debugFast
        && (opts.textureScale == null || opts.textureScale >= 0.999)
        && opts.textureCompressMode !== "always") {
        const doImg = !opts.skipImageSeed;
        const doMat = !opts.skipMaterialSeed;
        if (!doImg && !doMat) {
            exportLog(state, "warn", "[export][seed] skipped (skipImageSeed+skipMaterialSeed)");
        } else {
            try {
                let imgOk = false;
                if (doImg) {
                    imgOk = !!seedImagesFromOriginal(state, opts.originalGlbBuffer);
                } else {
                    exportLog(state, "warn", "[export][seed] images skipped (skipImageSeed)");
                }
                // Materials need image seed tables for texture index remap; if
                // images were skipped, still attempt material JSON seed alone.
                if (doMat) {
                    try {
                        if (imgOk || !doImg) {
                            // When images skipped, parse GLB for materials only
                            seedMaterialsFromOriginal(state, opts.originalGlbBuffer);
                        }
                    } catch (e2) {
                        console.warn("[export] seedMaterialsFromOriginal failed", e2);
                    }
                } else {
                    exportLog(state, "warn", "[export][seed] materials skipped (skipMaterialSeed)");
                }
            } catch (e) {
                console.warn("[export] seedImagesFromOriginal failed", e);
            }
        }
    }
    if (opts.debugFast || opts.skipTextures || opts.skipMorphTargets || opts.skipSpringBones) {
        exportLog(opts, "verbose", "[export] debug flags:", {
            debugFast: !!opts.debugFast,
            skipTextures: !!opts.skipTextures,
            skipMorphTargets: !!opts.skipMorphTargets,
            skipSpringBones: !!opts.skipSpringBones,
            draco: !!opts.draco
        });
    }

    const tSeed = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    snapshotEyeMaterials(state);
    // Lip handling during hybrid-seed:
    // - skipInternalLip (post GLB lip-patch path): do NOT strip live lip maps.
    //   Materials are SEEDED from original GLB JSON (eyes + Face_SKIN frozen),
    //   so live _isLipBake textures are never read into the export state.
    //   Stripping was previously always done and still correlated with black eyes
    //   on the hybrid+lip combined path — the strip/restore cycle mutates shared
    //   Three.js Texture objects that eyes also reference (same atlas Image).
    // - in-export lip path: strip so applyLipPatchesToState sees clean maps.
    let lipStripEntries = [];
    const skipInternalLip = !!(opts.skipInternalLipPatch || opts.skipLipExport);
    if (!skipInternalLip) {
        try {
            const root = state.org && (state.org.scene || state.org);
            lipStripEntries = stripLipTexturesForExport(root) || [];
            if (lipStripEntries.length) {
                exportLog(state, "warn", "[export][lip-patch] stripped lip maps for rebuild count=",
                    lipStripEntries.length, "(in-export lip path)");
            }
        } catch (eStrip) {
            console.warn("[export][lip-patch] strip failed", eStrip);
        }
    } else {
        exportLog(state, "warn", "[export][lip-patch] skip live strip (post-patch path; seed materials only)");
    }
    try {
        await makeScenes(state);
        // Never apply lip inside VRMExport when skipInternalLip (post-patch path).
        if (lipStripEntries.length && !skipInternalLip) {
            try {
                const n = await applyLipPatchesToState(state, lipStripEntries);
                exportLog(state, "warn", "[export][lip-patch] applied texture-only patches=", n);
            } catch (ePatch) {
                console.warn("[export][lip-patch] apply failed", ePatch);
            }
        }
        if (opts.skipMaterialSeed || !(state._eyeMaterialSnapshot && state._eyeMaterialSnapshot.length)) {
            snapshotEyeMaterials(state);
        }
        validateSeededMaterials(state);
    } finally {
        try { restoreLipTexturesAfterExport(lipStripEntries); } catch (eRest) {}
    }
    const tScenes = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    await makeVRM(state, metaVersion);
    const tVrm = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    try {
        await applyDracoCompression(state);
    } catch (e) {
        console.warn("[export] Draco step failed", e);
    }
    const tDraco = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    restoreEyeMaterials(state);
    const glb = makeGlb(state);
    const tEnd = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    try {
        let imgBytes = 0;
        (state.images || []).forEach(img => {
            const bv = img && state.bufferViews && state.bufferViews[img.bufferView];
            if (bv && bv.byteLength) imgBytes += bv.byteLength;
        });
        let geoBytes = 0;
        (state.bufferViews || []).forEach(bv => {
            if (bv && bv.byteLength) geoBytes += bv.byteLength;
        });
        geoBytes = Math.max(0, geoBytes - imgBytes);
        exportLog(state, "warn", "[export] size breakdown: images≈", Math.round(imgBytes / 1024), "KB",
            "geometry≈", Math.round(geoBytes / 1024), "KB",
            "images=", (state.images || []).length,
            "textures=", (state.textures || []).length,
            "meshes=", (state.meshes || []).length,
            "nodes=", (state.nodes || []).length,
            "glb≈", Math.round((glb && glb.byteLength || 0) / 1024), "KB");
        exportLog(state, "warn", "[export] timing ms: seed≈", Math.round(tSeed - t0),
            "scenes≈", Math.round(tScenes - tSeed),
            "vrmExt≈", Math.round(tVrm - tScenes),
            "draco≈", Math.round(tDraco - tVrm),
            "pack≈", Math.round(tEnd - tDraco),
            "total≈", Math.round(tEnd - t0));
        // 大きいメッシュを列挙（二重化の手がかり）
        try {
            const meshNames = (state.nodes || [])
                .filter(n => n && n.mesh != null)
                .map(n => n.name || "(unnamed)");
            exportLog(state, "warn", "[export] mesh nodes:", meshNames.join(", "));
        } catch (e) {}
    } catch (e) {}
    return glb;
}


// Re-export public API surface (same as old VRMExporter.js)
export { DEFAULT_EXPORT_OPTIONS, resolveExportFlags } from "./options.js";
export {
    splitBuffer, bindBuffers, getData, putData, conversion
} from "./conversion.js";
export { tryPatchExport, isPatchCandidateMeta } from "./patch.js";

export {
    patchLipOntoGlb,
    lipTextureToPngBytes,
    patchTexturesOntoGlb,
    patchMaterialColorsOntoGlb,
    textureToPngBytes,
    stripLipPaintFromGlb,
    repairEyeImagesFromPristine,
    isolateEyeImagesFromFaceShare,
    normalizeEyeBlendModeToCutout, fixEyeTransparentCutoff,
    compressIsolatedEyeImages,
    assertExportContracts,
    diagnoseGlbEyeState
} from "./glb-patch.js";
export { classifyEditKinds, resolveExportPath, decideExportRoute, exportOptsNeedReencode, GEOMETRY_REASONS, TEXTURE_ONLY_REASONS, MATERIAL_ONLY_REASONS } from "./edit-kind.js";

export { stripLipTexturesForExport, restoreLipTexturesAfterExport } from "./lip-patch.js";
