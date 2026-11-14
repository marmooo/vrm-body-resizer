/**
 * Lip paint = texture-only edit.
 * Strip lip maps before scene rebuild so eye/face geometry+materials follow the
 * same path as a non-lip export, then surgically patch Face_SKIN in the export
 * state (append image + swap texture indices only).
 */
import { addTexture } from "./texture.js";
import { normalizeMaterialName } from "./seed-assets.js";
import { exportLog } from "./log.js";

function getShadeTex(mat) {
    try {
        if (mat.shadeMultiplyTexture) return mat.shadeMultiplyTexture;
        if (mat.uniforms && mat.uniforms.shadeMultiplyTexture
            && mat.uniforms.shadeMultiplyTexture.value) {
            return mat.uniforms.shadeMultiplyTexture.value;
        }
    } catch (e) {}
    return null;
}

function setShadeTex(mat, tex) {
    try {
        if ("shadeMultiplyTexture" in mat) mat.shadeMultiplyTexture = tex;
        if (mat.uniforms && mat.uniforms.shadeMultiplyTexture) {
            mat.uniforms.shadeMultiplyTexture.value = tex;
        }
    } catch (e) {}
}

function isLipTexture(tex) {
    return !!(tex && tex.userData && tex.userData._isLipBake);
}

/**
 * Temporarily restore original maps on lip-painted materials.
 * @returns {Array<{mat, lipMap, lipShade, originalMap, originalShade, name}>}
 */
export function stripLipTexturesForExport(root) {
    const entries = [];
    if (!root || typeof root.traverse !== "function") return entries;

    root.traverse((obj) => {
        if (!obj || !obj.isMesh) return;
        const mesh = obj;
        const bakList = (mesh.userData && Array.isArray(mesh.userData._lipMapBackup))
            ? mesh.userData._lipMapBackup : [];
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

        mats.forEach((mat) => {
            if (!mat) return;
            const map = mat.map;
            const shade = getShadeTex(mat);
            const hasLip = !!(mat.userData && mat.userData._lipColorOn)
                || isLipTexture(map) || isLipTexture(shade);
            if (!hasLip) return;

            // Prefer explicit backup for this material
            let bak = null;
            for (let i = 0; i < bakList.length; i++) {
                const b = bakList[i];
                if (!b) continue;
                if (b.bakedTex && (b.bakedTex === map || b.bakedTex === shade)) {
                    bak = b;
                    break;
                }
                if (Array.isArray(b.matRefs) && b.matRefs.indexOf(mat) >= 0) {
                    bak = b;
                    break;
                }
            }
            if (!bak && bakList.length === 1) bak = bakList[0];

            const originalMap = (bak && bak.originalMap) ? bak.originalMap : null;
            const lipMap = isLipTexture(map) ? map : (bak && bak.bakedTex) || map;
            const lipShade = isLipTexture(shade) ? shade : null;

            entries.push({
                mat,
                mesh,
                name: mat.name || "",
                lipMap: lipMap || null,
                lipShade: lipShade || lipMap || null,
                originalMap,
                hadLipColorOn: !!(mat.userData && mat.userData._lipColorOn),
                lipMapBackup: bakList.length ? bakList.slice() : null,
            });

            // Strip so makeScenes sees the non-lip material (same as golden path).
            // If originalMap is missing, still clear lip-bake flags so export does not
            // treat the bake canvas as a normal atlas (black-eye regression).
            if (originalMap) {
                try { mat.map = originalMap; } catch (e) {}
                setShadeTex(mat, originalMap);
            } else if (isLipTexture(map) || isLipTexture(shade)) {
                // Last resort: leave map but strip _isLipBake so seed/reuse paths
                // do not special-case this material as lip during A-base rebuild.
                try {
                    if (map && map.userData) delete map.userData._isLipBake;
                } catch (e) {}
                try {
                    if (shade && shade.userData) delete shade.userData._isLipBake;
                } catch (e) {}
                console.warn("[export][lip-patch] strip without originalMap for", mat.name || "(unnamed)");
            }
            if (mat.userData) {
                delete mat.userData._lipColorOn;
                // keep _exportMaterialDirty for skinFilter etc.; lip no longer drives path
            }
            // Do NOT set needsUpdate — MToon recompile can pure-black materials
            // (especially shared Face/Eye atlas paths).
            try { if (mat.uniforms) mat.uniformsNeedUpdate = true; } catch (e) {}
        });
        // Clear mesh-level lip markers so dirty summary matches path A.
        // Backup list is preserved in entries and restored after export.
        if (mesh.userData) {
            delete mesh.userData._lipColorOn;
            delete mesh.userData._lipMapBackup;
            delete mesh.userData._exportMaterialDirty; // will re-mark skinFilter if needed
        }
    });

    return entries;
}

/** Put lip textures back on the live scene after export. */
export function restoreLipTexturesAfterExport(entries) {
    if (!entries || !entries.length) return;
    entries.forEach((e) => {
        if (!e || !e.mat) return;
        try {
            if (e.lipMap) e.mat.map = e.lipMap;
            if (e.lipShade || e.lipMap) setShadeTex(e.mat, e.lipShade || e.lipMap);
            if (!e.mat.userData) e.mat.userData = {};
            if (e.hadLipColorOn) e.mat.userData._lipColorOn = true;
            // Avoid needsUpdate (MToon recompile → pure black on shared atlas).
            try { if (e.mat.uniforms) e.mat.uniformsNeedUpdate = true; } catch (eU) {}
        } catch (err) {}
        // Restore mesh-level backup so subsequent reapplyLipPaintMaps still works
        try {
            if (e.mesh && e.mesh.userData) {
                if (e.lipMapBackup && e.lipMapBackup.length) {
                    e.mesh.userData._lipMapBackup = e.lipMapBackup;
                }
                e.mesh.userData._lipColorOn = true;
            }
        } catch (err2) {}
    });
}

/**
 * After makeScenes: append lip image(s) and swap only matching material slots.
 * Does not rebuild meshes or other materials.
 */
export async function applyLipPatchesToState(state, entries) {
    if (!state || !entries || !entries.length) return 0;
    let patched = 0;
    const seen = new Set();

    for (const e of entries) {
        const key = normalizeMaterialName(e.name || (e.mat && e.mat.name) || "");
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const lipTex = e.lipMap || e.lipShade;
        if (!lipTex) continue;

        // Resolve the material index that primitives actually use *right now*.
        // After filterTint APPEND, Face_SKIN prims point at Face_SKIN__morpholith
        // (not the original seed slot) — matching only the seed index yields prims=0.
        function nameMatchesKey(matName) {
            const n = normalizeMaterialName(matName || "");
            if (n === key) return true;
            // __morpholith / __LipPaint clones of the same base
            const base = n.replace(/__morpholith$/i, "").replace(/__lippaint$/i, "");
            return base === key;
        }
        let matIdx = null;
        // Prefer an index that is actually referenced by a primitive
        const referenced = new Set();
        (state.meshes || []).forEach((mesh) => {
            (mesh.primitives || []).forEach((pr) => {
                if (pr && pr.material != null) referenced.add(pr.material | 0);
            });
        });
        if (Array.isArray(state.materials)) {
            for (let i = 0; i < state.materials.length; i++) {
                if (!nameMatchesKey((state.materials[i] && state.materials[i].name) || "")) continue;
                if (referenced.has(i)) { matIdx = i; break; }
                if (matIdx == null) matIdx = i;
            }
        }
        if (matIdx == null || !state.materials[matIdx]) {
            exportLog(state, "warn", "[export][lip-patch] no material for", key);
            continue;
        }

        const texRes = await addTexture(state, lipTex, true);
        if (!texRes || texRes.index == null) {
            exportLog(state, "warn", "[export][lip-patch] addTexture failed", key);
            continue;
        }

        // APPEND a new material — never mutate the seeded slot in-place.
        const base = state.materials[matIdx];
        const clone = JSON.parse(JSON.stringify(base));
        const baseName = String(clone.name || key).replace(/\s*\(Instance\)\s*$/i, "")
            .replace(/__morpholith$/i, "");
        clone.name = baseName + "__LipPaint";
        if (!clone.pbrMetallicRoughness) clone.pbrMetallicRoughness = {};
        clone.pbrMetallicRoughness.baseColorTexture = { index: texRes.index };
        clone.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
        if (clone.extensions && clone.extensions.VRMC_materials_mtoon) {
            clone.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: texRes.index };
            clone.extensions.VRMC_materials_mtoon.shadeColorFactor = [1, 1, 1];
        }
        const newIdx = state.materials.length;
        state.materials.push(clone);

        if (state.metaVersion == 0 && state.extensions && state.extensions.VRM
            && Array.isArray(state.extensions.VRM.materialProperties)) {
            const propsList = state.extensions.VRM.materialProperties;
            const srcProps = propsList[matIdx]
                ? JSON.parse(JSON.stringify(propsList[matIdx]))
                : { name: clone.name, shader: "VRM/MToon", renderQueue: 2450,
                    floatProperties: {}, vectorProperties: {}, textureProperties: {},
                    keywordMap: {}, tagMap: {} };
            srcProps.name = clone.name;
            if (!srcProps.textureProperties) srcProps.textureProperties = {};
            srcProps.textureProperties._MainTex = texRes.index;
            srcProps.textureProperties._ShadeTexture = texRes.index;
            if (!srcProps.vectorProperties) srcProps.vectorProperties = {};
            srcProps.vectorProperties._Color = [1, 1, 1, 1];
            srcProps.vectorProperties._ShadeColor = [1, 1, 1, 1];
            if (lipTex.offset && lipTex.repeat) {
                const uv = [lipTex.offset.x, lipTex.offset.y, lipTex.repeat.x, lipTex.repeat.y];
                srcProps.vectorProperties._MainTex = uv;
                srcProps.vectorProperties._ShadeTexture = uv;
            }
            while (propsList.length < newIdx) propsList.push(null);
            propsList[newIdx] = srcProps;
        }

        // Retarget every prim that points at any Face_SKIN-matching material
        let primSwitched = 0;
        (state.meshes || []).forEach((mesh) => {
            (mesh.primitives || []).forEach((pr) => {
                if (!pr || pr.material == null) return;
                const mi = pr.material | 0;
                if (mi === matIdx) {
                    pr.material = newIdx;
                    primSwitched++;
                    return;
                }
                const m = state.materials[mi];
                if (m && nameMatchesKey(m.name || "")) {
                    pr.material = newIdx;
                    primSwitched++;
                }
            });
        });

        patched++;
        exportLog(state, "warn", "[export][lip-patch] texture-only APPEND",
            key, "from", matIdx, "→", newIdx, "tex", texRes.index,
            "prims", primSwitched);
    }
    return patched;
}
