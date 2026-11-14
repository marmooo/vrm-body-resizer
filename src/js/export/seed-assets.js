/**
 * Morpholith export — seed images (and optional materials) from the original GLB.
 *
 * Used when geometry must be rebuilt (body bake) but textures are untouched:
 * copy image bufferViews from the source file once, so addImage becomes O(1)
 * lookups instead of re-walking passthrough / encode for every material slot.
 */
import { align4 } from "./constants.js";
import { splitBuffer } from "./conversion.js";
import { addBufferView } from "./core.js";
import { exportLog } from "./log.js";

/**
 * Parse original GLB once and cache on state for image + material seed.
 * @returns {{ parts: object, json: object }|null}
 */
export function ensureOriginalGlbParsed(state, originalBuffer) {
    if (!state || !originalBuffer) return null;
    if (state._originalGlbParsed && state._originalGlbParsed.buffer === originalBuffer) {
        return state._originalGlbParsed;
    }
    let parts;
    try {
        parts = splitBuffer(originalBuffer);
    } catch (e) {
        console.warn("[export][seed] splitBuffer failed", e);
        return null;
    }
    if (!parts || !parts.jsonChunkData || !parts.binChunkData) return null;
    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(parts.jsonChunkData));
    } catch (e) {
        console.warn("[export][seed] JSON parse failed", e);
        return null;
    }
    state._originalGlbParsed = { buffer: originalBuffer, parts, json };
    return state._originalGlbParsed;
}

/**
 * @param {object} state  export state (after init)
 * @param {ArrayBuffer} originalBuffer
 * @returns {boolean} true if at least one image was seeded
 */
export function seedImagesFromOriginal(state, originalBuffer) {
    if (!state || !originalBuffer) return false;

    const parsed = ensureOriginalGlbParsed(state, originalBuffer);
    if (!parsed) return false;
    const { parts, json } = parsed;

    const images = json.images || [];
    const bufferViews = json.bufferViews || [];
    const bin = parts.binChunkData;
    if (!images.length) return false;

    // original image index → state.images index
    state._seededImageByOrigIndex = new Map();
    // buffer fingerprint → state.images index (extra dedupe)
    state._seededImageByFingerprint = new Map();

    let seeded = 0;
    for (let i = 0; i < images.length; i++) {
        const imgDef = images[i];
        if (!imgDef || imgDef.bufferView == null) continue;
        const bv = bufferViews[imgDef.bufferView];
        if (!bv || bv.byteLength == null) continue;
        const byteOffset = bv.byteOffset || 0;
        const byteLength = bv.byteLength;
        if (byteLength < 16) continue;
        if (byteOffset + byteLength > bin.byteLength) continue;

        const slice = bin.slice(byteOffset, byteOffset + byteLength);
        // Pad-aware copy into a tight buffer for addBufferView
        const tight = slice.byteLength === byteLength
            ? slice
            : slice.slice(0, byteLength);

        const index = state.images.length;
        state.images.push({
            name: imgDef.name || ("seeded_" + i),
            mimeType: imgDef.mimeType || "image/png",
            bufferView: addBufferView(state, new Uint8Array(tight), imgDef.name || ("img_" + i))
        });
        state._seededImageByOrigIndex.set(i, index);

        try {
            const fp = fingerprint(tight);
            if (fp) state._seededImageByFingerprint.set(fp, index);
        } catch (e) {}

        seeded++;
    }

    // Seed samplers + textures so material writers can reuse texture indices
    // when _srcImageIndex is known.
    const samplers = json.samplers || [];
    const textures = json.textures || [];
    state._seededTextureByOrigIndex = new Map();
    state._seededSamplerRemap = new Map();

    const baseSamplerCount = state.samplers.length;
    for (let i = 0; i < samplers.length; i++) {
        const s = samplers[i] || {};
        const entry = {
            magFilter: s.magFilter != null ? s.magFilter : 9729,
            minFilter: s.minFilter != null ? s.minFilter : 9987,
            wrapS: s.wrapS != null ? s.wrapS : 10497,
            wrapT: s.wrapT != null ? s.wrapT : 10497
        };
        const key = `${entry.magFilter}_${entry.minFilter}_${entry.wrapS}_${entry.wrapT}`;
        if (state.samplerMap.has(key)) {
            state._seededSamplerRemap.set(i, state.samplerMap.get(key));
        } else {
            const idx = state.samplers.length;
            state.samplers.push(entry);
            state.samplerMap.set(key, idx);
            state._seededSamplerRemap.set(i, idx);
        }
    }

    for (let i = 0; i < textures.length; i++) {
        const t = textures[i];
        if (!t || t.source == null) continue;
        if (!state._seededImageByOrigIndex.has(t.source)) continue;
        const source = state._seededImageByOrigIndex.get(t.source);
        let sampler = 0;
        if (t.sampler != null && state._seededSamplerRemap.has(t.sampler)) {
            sampler = state._seededSamplerRemap.get(t.sampler);
        } else if (state.samplers.length) {
            sampler = 0;
        }
        const tex = { sampler, source };
        if (t.name) tex.name = t.name;
        const index = state.textures.length;
        state.textures.push(tex);
        state._seededTextureByOrigIndex.set(i, index);
        // Allow addTexture DEDUPE by source image index
        if (!state._textureSrcIndexMap) state._textureSrcIndexMap = new Map();
        state._textureSrcIndexMap.set(t.source, index);
    }

    state._assetsSeededFromOriginal = true;
    exportLog(state, "warn", "[export][seed] images=", seeded,
        "textures=", state._seededTextureByOrigIndex.size,
        "samplers=", state.samplers.length - baseSamplerCount);

    return seeded > 0;
}

function fingerprint(buf) {
    const u8 = buf instanceof ArrayBuffer
        ? new Uint8Array(buf)
        : (buf.buffer
            ? new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength || buf.length)
            : new Uint8Array(buf));
    if (!u8 || u8.byteLength < 4) return null;
    // length + first/last 8 bytes style hash
    let h = u8.byteLength >>> 0;
    const n = Math.min(8, u8.byteLength);
    for (let i = 0; i < n; i++) h = (Math.imul(h, 16777619) ^ u8[i]) >>> 0;
    for (let i = 0; i < n; i++) h = (Math.imul(h, 16777619) ^ u8[u8.byteLength - 1 - i]) >>> 0;
    return h + ":" + u8.byteLength;
}

/**
 * Resolve a seeded image index for a texture that still points at the source
 * GLB image slot (_srcImageIndex).
 * @returns {number|null}
 */
export function lookupSeededImage(state, textureObj, imgSrc) {
    if (!state || !state._seededImageByOrigIndex) return null;

    let srcIdx = null;
    try {
        if (textureObj && textureObj.userData && textureObj.userData._srcImageIndex != null) {
            srcIdx = textureObj.userData._srcImageIndex | 0;
        }
    } catch (e) {}
    try {
        if (srcIdx == null && imgSrc && imgSrc.userData && imgSrc.userData._srcImageIndex != null) {
            srcIdx = imgSrc.userData._srcImageIndex | 0;
        }
    } catch (e) {}
    try {
        if (srcIdx == null && state.exportOptions && state.exportOptions.sourceTextureImageIndex
            && textureObj && textureObj.uuid) {
            const v = state.exportOptions.sourceTextureImageIndex.get(textureObj.uuid);
            if (v != null) srcIdx = v | 0;
        }
    } catch (e) {}

    if (srcIdx != null && state._seededImageByOrigIndex.has(srcIdx)) {
        return state._seededImageByOrigIndex.get(srcIdx);
    }

    // Fingerprint fallback from attached original bytes
    try {
        const buf = (textureObj && textureObj.userData && textureObj.userData.buffer)
            || (imgSrc && imgSrc.userData && imgSrc.userData.buffer);
        if (buf && state._seededImageByFingerprint) {
            const fp = fingerprint(buf);
            if (fp && state._seededImageByFingerprint.has(fp)) {
                return state._seededImageByFingerprint.get(fp);
            }
        }
    } catch (e) {}

    return null;
}


/** Strip Three.js / Unity instance suffixes for name matching. */
export function normalizeMaterialName(name) {
    if (!name || typeof name !== "string") return "";
    return name
        .replace(/\s*\(Instance\)\s*$/i, "")
        .replace(/\s*\(Outline\)\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

function remapTexIndex(state, origIdx) {
    if (origIdx == null || origIdx < 0) return origIdx;
    if (state._seededTextureByOrigIndex && state._seededTextureByOrigIndex.has(origIdx)) {
        return state._seededTextureByOrigIndex.get(origIdx);
    }
    // Never leave an unmapped original index — out-of-range refs → pure black MToon.
    try {
        console.warn("[export][seed] unmapped texture index", origIdx,
            "seededTextures=", state._seededTextureByOrigIndex
                ? state._seededTextureByOrigIndex.size : 0);
    } catch (e) {}
    return null;
}

function applyRemappedTexRef(state, obj, key) {
    if (!obj || !obj[key] || obj[key].index == null) return;
    const next = remapTexIndex(state, obj[key].index);
    if (next == null) delete obj[key];
    else obj[key].index = next;
}

function remapMaterialTextureFields(state, mat) {
    if (!mat) return;
    const pbr = mat.pbrMetallicRoughness;
    if (pbr) {
        applyRemappedTexRef(state, pbr, "baseColorTexture");
        applyRemappedTexRef(state, pbr, "metallicRoughnessTexture");
    }
    applyRemappedTexRef(state, mat, "normalTexture");
    applyRemappedTexRef(state, mat, "occlusionTexture");
    applyRemappedTexRef(state, mat, "emissiveTexture");
    const ext = mat.extensions;
    if (ext && ext.VRMC_materials_mtoon) {
        const m = ext.VRMC_materials_mtoon;
        for (const key of Object.keys(m)) {
            const slot = m[key];
            if (slot && typeof slot === "object" && slot.index != null) {
                const next = remapTexIndex(state, slot.index);
                if (next == null) delete m[key];
                else slot.index = next;
            }
        }
    }
}

function remapVrm0MaterialPropertiesTextures(state, props) {
    if (!props || !props.textureProperties) return;
    const tp = props.textureProperties;
    for (const slot of Object.keys(tp)) {
        if (typeof tp[slot] === "number") {
            const next = remapTexIndex(state, tp[slot]);
            if (next == null) delete tp[slot];
            else tp[slot] = next;
        }
    }
}

/**
 * Seed materials (and VRM0 materialProperties) from the original GLB.
 * Requires seedImagesFromOriginal to have run first (texture index remap).
 * Unedited three.js materials can then resolve by name in makeMaterialFromThree.
 *
 * @returns {number} number of materials seeded
 */
export function seedMaterialsFromOriginal(state, originalBuffer) {
    if (!state || !originalBuffer) return 0;
    if (!state._seededTextureByOrigIndex || state._seededTextureByOrigIndex.size === 0) {
        // textures not seeded — material texture indices would be wrong
        return 0;
    }

    const parsed = ensureOriginalGlbParsed(state, originalBuffer);
    if (!parsed) return 0;
    const { json } = parsed;

    const materials = json.materials || [];
    if (!materials.length) return 0;

    state._seededMaterialByName = new Map();
    state._seededMaterialByOrigIndex = new Map();

    let count = 0;
    for (let i = 0; i < materials.length; i++) {
        let mat;
        try {
            mat = JSON.parse(JSON.stringify(materials[i]));
        } catch (e) {
            continue;
        }
        remapMaterialTextureFields(state, mat);
        const index = state.materials.length;
        state.materials.push(mat);
        state._seededMaterialByOrigIndex.set(i, index);
        const key = normalizeMaterialName(mat.name || "");
        if (key && !state._seededMaterialByName.has(key)) {
            state._seededMaterialByName.set(key, index);
        }
        count++;
    }

    // VRM0 materialProperties — keep parallel to materials when possible
    try {
        const list = json.extensions && json.extensions.VRM
            && json.extensions.VRM.materialProperties;
        if (Array.isArray(list) && list.length) {
            if (!state.extensions.VRM) state.extensions.VRM = { specVersion: "0.0" };
            const cloned = list.map((p) => {
                try {
                    const c = JSON.parse(JSON.stringify(p));
                    remapVrm0MaterialPropertiesTextures(state, c);
                    return c;
                } catch (e) {
                    return p;
                }
            });
            // Align with seeded materials: if lengths match, assign by index
            state.extensions.VRM.materialProperties = cloned;
            state._seededVrm0MaterialProperties = true;
        }
    } catch (e) {}

    // Ensure extensionsUsed carries over unlit / mtoon / texture transform
    try {
        const used = json.extensionsUsed || [];
        for (const u of used) {
            if (u && !state.extensionsUsed.includes(u)) state.extensionsUsed.push(u);
        }
    } catch (e) {}

    exportLog(state, "warn", "[export][seed] materials=", count,
        "byName=", state._seededMaterialByName.size,
        "vrm0Props=", !!state._seededVrm0MaterialProperties);

    state._materialsSeededFromOriginal = true;
    // Indices [0, _seededMaterialCount) are frozen — never in-place overwrite.
    state._seededMaterialCount = state.materials.length;
    return count;
}

/**
 * Whether a live three.js material should skip rebuild and use a seeded entry.
 */
export function canReuseSeededMaterial(state, main) {
    if (!state || !main || !state._seededMaterialByName) return false;
    const ud = main.userData || {};
    // Hard edits: must full-rebuild (solid / lip / cutout bake).
    if (ud._isSolidNailMat || ud._isLipSolidMat || ud._compColorMode === "solid") return false;
    if (typeof ud._solidHex === "string" && ud._solidHex.length > 0) return false;
    if (ud._solidPreserveAlpha) return false;
    if (ud._lipColorOn || ud._lipMapBackup) {
        if (!(state.exportOptions && state.exportOptions.skipLipExport)) return false;
    }
    if (ud._isSolidAlphaBake) return false;
    if (ud._skinSolidBackup) return false;
    if (ud._skinTintApplied && ud._compColorMode === "solid") return false;
    // Lip bake on texture
    try {
        const map = main.map;
        if (map && map.userData && map.userData._isLipBake) {
            if (!(state.exportOptions && state.exportOptions.skipLipExport)) return false;
        }
        const shade = main.shadeMultiplyTexture
            || (main.uniforms && main.uniforms.shadeMultiplyTexture
                && main.uniforms.shadeMultiplyTexture.value);
        if (shade && shade.userData && shade.userData._isLipBake) {
            if (!(state.exportOptions && state.exportOptions.skipLipExport)) return false;
        }
    } catch (e) {}
    // Skin FILTER only: allow seed (caller may clone + patch color factors).
    // Blocking seed on _exportMaterialDirty alone forced full rebuild → black MToon.
    if (ud._exportMaterialDirty && !(ud._skinTintApplied && ud._compColorMode !== "solid")) {
        return false;
    }
    return true;
}

/**
 * @returns {number|null} seeded material index
 */
export function lookupSeededMaterial(state, main) {
    if (!canReuseSeededMaterial(state, main)) return null;
    const key = normalizeMaterialName(main.name || "");
    if (!key) return null;
    if (state._seededMaterialByName.has(key)) {
        return state._seededMaterialByName.get(key);
    }
    return null;
}
