/**
 * Pure GLB surgery — texture / material patches without mesh rebuild.
 *
 * textureOnly edits (lip, future atlas paints) and materialOnly edits
 * (color factors) should go through here, not full VRMExport.
 */
import { exportLog } from "./log.js";

export function parseGlb(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.byteLength < 12) throw new Error("GLB too short");
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== "glTF") throw new Error("not GLB");
    let offset = 12;
    let json = null;
    let bin = null;
    while (offset + 8 <= u8.byteLength) {
        const chunkLen = dv.getUint32(offset, true);
        const chunkType = String.fromCharCode(
            u8[offset + 4], u8[offset + 5], u8[offset + 6], u8[offset + 7]
        );
        const start = offset + 8;
        const end = start + chunkLen;
        if (end > u8.byteLength) break;
        if (chunkType === "JSON") {
            const text = new TextDecoder().decode(u8.subarray(start, end)).replace(/\0+$/, "");
            json = JSON.parse(text);
        } else if (chunkType.indexOf("BIN") === 0) {
            bin = u8.subarray(start, end);
        }
        offset = (end + 3) & ~3;
    }
    return { json, bin, u8 };
}

function align4(n) { return (n + 3) & ~3; }

export function packGlb(json, binU8) {
    // Direct GLB write — do NOT go through bindBuffers (legacy path that can
    // reinterpret bufferViews). Keep BIN bytes byte-identical to what we built.
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonPad = align4(jsonBytes.length);
    const binSrc = binU8 instanceof Uint8Array ? binU8 : new Uint8Array(binU8);
    const binPad = align4(binSrc.length);
    const total = 12 + 8 + jsonPad + 8 + binPad;
    const out = new ArrayBuffer(total);
    const view = new DataView(out);
    const u8 = new Uint8Array(out);
    let o = 0;
    // header
    view.setUint32(o, 0x46546C67, true); o += 4; // glTF
    view.setUint32(o, 2, true); o += 4;          // version
    view.setUint32(o, total, true); o += 4;      // length
    // JSON chunk
    view.setUint32(o, jsonPad, true); o += 4;
    view.setUint32(o, 0x4E4F534A, true); o += 4; // JSON
    u8.set(jsonBytes, o);
    for (let i = jsonBytes.length; i < jsonPad; i++) u8[o + i] = 0x20;
    o += jsonPad;
    // BIN chunk
    view.setUint32(o, binPad, true); o += 4;
    view.setUint32(o, 0x004E4942, true); o += 4; // BIN\0
    u8.set(binSrc, o);
    // remaining pad stays 0
    return out;
}

/**
 * Rebuild BIN so only bufferViews still referenced by accessors/images/… remain.
 * Drops dead weight left when Face_LipPaint is reused (old lip bytes stayed in BIN).
 * @returns {{ json: object, bin: Uint8Array, savedBytes: number }}
 */
export function compactGlbBin(json, binU8) {
    const src = binU8 instanceof Uint8Array ? binU8 : new Uint8Array(binU8);
    const views = Array.isArray(json.bufferViews) ? json.bufferViews : [];
    if (!views.length) return { json, bin: src, savedBytes: 0 };

    const keep = new Set();
    function markBv(i) {
        if (i == null || i < 0 || i >= views.length) return;
        keep.add(i | 0);
    }
    (json.accessors || []).forEach(a => {
        if (!a) return;
        markBv(a.bufferView);
        if (a.sparse) {
            if (a.sparse.indices) markBv(a.sparse.indices.bufferView);
            if (a.sparse.values) markBv(a.sparse.values.bufferView);
        }
    });
    (json.images || []).forEach(im => { if (im) markBv(im.bufferView); });
    try {
        const meshes = json.meshes || [];
        for (const mesh of meshes) {
            for (const prim of (mesh.primitives || [])) {
                if (prim && prim.extensions && prim.extensions.KHR_draco_mesh_compression) {
                    markBv(prim.extensions.KHR_draco_mesh_compression.bufferView);
                }
            }
        }
    } catch (e) {}

    const newViews = new Array(views.length);
    let cursor = 0;
    const chunks = [];
    for (let i = 0; i < views.length; i++) {
        const v = views[i];
        if (!v || !keep.has(i)) {
            // Keep index slots stable with empty placeholders so indices stay valid
            // only for kept views; unreferenced slots become 0-length at offset 0.
            newViews[i] = { buffer: 0, byteOffset: 0, byteLength: 0 };
            if (v && v.byteStride != null) newViews[i].byteStride = v.byteStride;
            if (v && v.target != null) newViews[i].target = v.target;
            continue;
        }
        const off = v.byteOffset || 0;
        const len = v.byteLength || 0;
        const start = align4(cursor);
        const padGap = start - cursor;
        if (padGap > 0) chunks.push(new Uint8Array(padGap));
        const slice = src.subarray(off, off + len);
        chunks.push(slice);
        const nv = { buffer: 0, byteOffset: start, byteLength: len };
        if (v.byteStride != null) nv.byteStride = v.byteStride;
        if (v.target != null) nv.target = v.target;
        newViews[i] = nv;
        cursor = start + len;
    }
    const total = align4(cursor);
    const outBin = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
        outBin.set(c, o);
        o += c.byteLength;
    }
    json.bufferViews = newViews;
    if (json.buffers && json.buffers[0]) {
        json.buffers[0].byteLength = outBin.byteLength;
    }
    const saved = Math.max(0, src.byteLength - outBin.byteLength);
    if (saved > 256) {
        console.warn("[export][glb-patch] compactGlbBin saved=", saved, "bytes",
            "before=", src.byteLength, "after=", outBin.byteLength);
    }
    return { json, bin: outBin, savedBytes: saved };
}

export function normalizeMaterialName(n) {
    return String(n || "").replace(/\s*\(Instance\)\s*$/i, "").trim().toLowerCase();
}

function nameMatches(matName, match) {
    if (!match) return false;
    const n = normalizeMaterialName(matName);
    if (typeof match === "function") return !!match(matName, n);
    if (match instanceof RegExp) return match.test(matName) || match.test(n);
    const m = normalizeMaterialName(match);
    return n === m || n.indexOf(m) >= 0 || m.indexOf(n) >= 0;
}

/**
 * Append PNG images and point matching materials' Main/Shade at them.
 *
 * @param {ArrayBuffer|Uint8Array} baseGlb
 * @param {Array<{ materialNameMatch: string|RegExp|Function, pngBytes: Uint8Array, name?: string, whiteFactors?: boolean }>} patches
 * @param {object} [opts]
 * @returns {ArrayBuffer}
 */
export function patchTexturesOntoGlb(baseGlb, patches, opts = {}) {
    const { json, bin } = parseGlb(baseGlb);
    if (!Array.isArray(patches) || !patches.length) {
        return baseGlb instanceof ArrayBuffer ? baseGlb : baseGlb.buffer;
    }

    let binArr = new Uint8Array(bin);
    if (!json.bufferViews) json.bufferViews = [];
    if (!json.images) json.images = [];
    if (!json.textures) json.textures = [];
    if (!json.samplers || !json.samplers.length) {
        json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    }
    if (!json.materials) json.materials = [];

    let totalPatched = 0;

    for (const patch of patches) {
        const png = patch.pngBytes instanceof Uint8Array
            ? patch.pngBytes
            : new Uint8Array(patch.pngBytes || []);
        if (png.byteLength < 64) continue;

        const pngOffset = align4(binArr.byteLength);
        const paddedLen = align4(png.byteLength);
        const next = new Uint8Array(pngOffset + paddedLen);
        next.set(binArr, 0);
        next.set(png, pngOffset);
        binArr = next;

        const bvIndex = json.bufferViews.length;
        json.bufferViews.push({
            buffer: 0,
            byteOffset: pngOffset,
            byteLength: png.byteLength
        });
        const imgIndex = json.images.length;
        json.images.push({
            name: patch.name || "PatchedTexture",
            mimeType: "image/png",
            bufferView: bvIndex
        });
        const texIndex = json.textures.length;
        json.textures.push({
            sampler: 0,
            source: imgIndex,
            name: patch.name || "PatchedTexture"
        });

        const white = patch.whiteFactors !== false;
        let n = 0;
        json.materials.forEach((mat, i) => {
            if (!mat || !nameMatches(mat.name, patch.materialNameMatch)) return;
            if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
            mat.pbrMetallicRoughness.baseColorTexture = { index: texIndex };
            if (white) mat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
            if (mat.extensions && mat.extensions.VRMC_materials_mtoon) {
                mat.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: texIndex };
                if (white) mat.extensions.VRMC_materials_mtoon.shadeColorFactor = [1, 1, 1];
            }
            try {
                const props = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties
                    && json.extensions.VRM.materialProperties[i];
                if (props) {
                    if (!props.textureProperties) props.textureProperties = {};
                    props.textureProperties._MainTex = texIndex;
                    props.textureProperties._ShadeTexture = texIndex;
                    if (white) {
                        if (!props.vectorProperties) props.vectorProperties = {};
                        props.vectorProperties._Color = [1, 1, 1, 1];
                        props.vectorProperties._ShadeColor = [1, 1, 1, 1];
                    }
                }
            } catch (e) {}
            n++;
        });
        totalPatched += n;
        if (opts.log !== false) {
            console.warn("[export][glb-patch] texture", patch.name || "(unnamed)",
                "tex=", texIndex, "materials=", n, "pngBytes=", png.byteLength);
        }
    }

    if (!json.buffers || !json.buffers[0]) json.buffers = [{ byteLength: binArr.byteLength }];
    else json.buffers[0].byteLength = binArr.byteLength;

    if (opts.log !== false) {
        console.warn("[export][glb-patch] texture patches done, materials touched=", totalPatched);
    }
    return packGlb(json, binArr);
}

/**
 * Patch baseColor / shadeColor factors on matching materials (no new images).
 *
 * @param {ArrayBuffer|Uint8Array} baseGlb
 * @param {Array<{ materialNameMatch: string|RegExp|Function, color?: number[], shadeColor?: number[] }>} patches
 * @param {object} [opts]
 * @returns {ArrayBuffer}
 */
export function patchMaterialColorsOntoGlb(baseGlb, patches, opts = {}) {
    const { json, bin } = parseGlb(baseGlb);
    if (!Array.isArray(patches) || !patches.length) {
        return baseGlb instanceof ArrayBuffer ? baseGlb : baseGlb.buffer;
    }
    let total = 0;
    for (const patch of patches) {
        (json.materials || []).forEach((mat, i) => {
            if (!mat || !nameMatches(mat.name, patch.materialNameMatch)) return;
            if (patch.color && patch.color.length >= 3) {
                if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
                const a = patch.color[3] != null ? patch.color[3] : 1;
                mat.pbrMetallicRoughness.baseColorFactor = [
                    patch.color[0], patch.color[1], patch.color[2], a
                ];
            }
            if (patch.shadeColor && patch.shadeColor.length >= 3
                && mat.extensions && mat.extensions.VRMC_materials_mtoon) {
                mat.extensions.VRMC_materials_mtoon.shadeColorFactor = [
                    patch.shadeColor[0], patch.shadeColor[1], patch.shadeColor[2]
                ];
            }
            try {
                const props = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties
                    && json.extensions.VRM.materialProperties[i];
                if (props) {
                    if (!props.vectorProperties) props.vectorProperties = {};
                    if (patch.color && patch.color.length >= 3) {
                        const a = patch.color[3] != null ? patch.color[3] : 1;
                        props.vectorProperties._Color = [
                            patch.color[0], patch.color[1], patch.color[2], a
                        ];
                    }
                    if (patch.shadeColor && patch.shadeColor.length >= 3) {
                        props.vectorProperties._ShadeColor = [
                            patch.shadeColor[0], patch.shadeColor[1], patch.shadeColor[2], 1
                        ];
                    }
                }
            } catch (e) {}
            total++;
        });
    }
    if (opts.log !== false) {
        console.warn("[export][glb-patch] material color patches=", total);
    }
    const binU8 = bin instanceof Uint8Array ? bin : new Uint8Array(bin);
    return packGlb(json, binU8);
}

/**
 * GLB texture-patch contract (§45 P1 / §46):
 *   - materials.length は変えない
 *   - 全 prim.material index は変えない
 *   - 既存 image / bufferView の byte は変えない（末尾に PNG を append するだけ）
 *   - Eye* material JSON / VRM materialProperties はパッチ前後で byte 一致
 *   - 変更してよいのは Face_SKIN（または指定 material）の texture index のみ
 *   - packGlb は BIN を再解釈せずそのまま書く
 */
/**
 * Strip Face_LipPaint from a previously lip-patched GLB and restore Face_SKIN
 * to the original shared atlas (the texture used by Eye* materials).
 * Used on load so hybrid-seed / pristine always starts from a clean base:
 * no black eyes, no skin loss, no repeated image append bloat.
 * @returns {ArrayBuffer|null} cleaned GLB, or null if nothing to strip / parse failed
 */
export function stripLipPaintFromGlb(baseGlb) {
    try {
        const { json, bin } = parseGlb(baseGlb);
        if (!json || !bin) return null;
        const mats = json.materials || [];
        const imgs = json.images || [];
        const texs = json.textures || [];
        const bvs = json.bufferViews || [];

        function isEyeName(name) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(normalizeMaterialName(name));
        }
        function isFaceSkinName(name) {
            const n = normalizeMaterialName(name);
            if (isEyeName(n)) return false;
            if (/face.*skin|skin.*face|face_00_skin|n00_000_00_face_00_skin/i.test(n)) return true;
            return n.indexOf("face") >= 0 && n.indexOf("skin") >= 0;
        }
        function texRefOf(mat) {
            try {
                const pbr = mat && mat.pbrMetallicRoughness;
                const idx = pbr && pbr.baseColorTexture && pbr.baseColorTexture.index;
                return idx != null ? idx : null;
            } catch (e) { return null; }
        }

        // Find Face_LipPaint image / texture indices
        let lipImgIdx = -1;
        let lipTexIdx = -1;
        for (let i = 0; i < imgs.length; i++) {
            if (imgs[i] && /Face_LipPaint/i.test(imgs[i].name || "")) {
                lipImgIdx = i;
                break;
            }
        }
        for (let i = 0; i < texs.length; i++) {
            if (texs[i] && /Face_LipPaint/i.test(texs[i].name || "")) {
                lipTexIdx = i;
                break;
            }
            if (lipImgIdx >= 0 && texs[i] && texs[i].source === lipImgIdx) {
                lipTexIdx = i;
                break;
            }
        }
        let hasEyeIso = false;
        for (let i = 0; i < imgs.length; i++) {
            if (imgs[i] && /__eye_iso|Eye_Isolated/i.test(imgs[i].name || "")) {
                hasEyeIso = true;
                break;
            }
        }
        if (lipImgIdx < 0 && lipTexIdx < 0 && !hasEyeIso) return null;

        // Original shared atlas = textures used by Eye* / FaceMouth (main + shade).
        // Do NOT force shade to the same index as main — original Face_SKIN uses
        // main=tex0 / shade=tex7; collapsing both to tex0 was correlated with
        // missing skin after strip → hybrid-seed re-export.
        // VRM0 keeps shade in materialProperties; VRM1 in VRMC_materials_mtoon.
        function shadeTexRefOf(mat, matIndex) {
            try {
                const mtoon = mat && mat.extensions && mat.extensions.VRMC_materials_mtoon;
                const si = mtoon && mtoon.shadeMultiplyTexture && mtoon.shadeMultiplyTexture.index;
                if (si != null) return si | 0;
            } catch (e) {}
            try {
                const propsList = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties;
                if (Array.isArray(propsList) && matIndex != null && propsList[matIndex]
                    && propsList[matIndex].textureProperties
                    && propsList[matIndex].textureProperties._ShadeTexture != null) {
                    return propsList[matIndex].textureProperties._ShadeTexture | 0;
                }
            } catch (e) {}
            return null;
        }
        // Prefer FaceMouth atlas — NOT Eye*. After isolateEye, eyes point at
        // __eye_iso copies; using those as "original" made strip redirect
        // Face_SKIN onto eye_iso (origTex=13/14) and poisoned pristine.
        function texIsEyeIso(ti) {
            try {
                if (ti == null || !texs[ti] || texs[ti].source == null) return false;
                const im = imgs[texs[ti].source];
                return !!(im && /__eye_iso|Eye_Isolated/i.test(im.name || ""));
            } catch (e) { return false; }
        }
        let origTexIdx = null;
        let origShadeTexIdx = null;
        // 1) FaceMouth first (stable shared atlas even after isolate)
        for (let i = 0; i < mats.length; i++) {
            const nm = mats[i] && mats[i].name || "";
            if (!/FaceMouth|Face_00_FACE|face.*mouth/i.test(nm)) continue;
            const t = texRefOf(mats[i]);
            if (t != null && t !== lipTexIdx && !texIsEyeIso(t)) {
                origTexIdx = t;
                const st = shadeTexRefOf(mats[i], i);
                if (st != null && st !== lipTexIdx && !texIsEyeIso(st)) origShadeTexIdx = st;
                break;
            }
        }
        // 2) Fallback: Eye* only if not pointing at __eye_iso
        if (origTexIdx == null) {
            for (let i = 0; i < mats.length; i++) {
                if (!mats[i] || !isEyeName(mats[i].name || "")) continue;
                const t = texRefOf(mats[i]);
                if (t != null && t !== lipTexIdx && !texIsEyeIso(t)) {
                    origTexIdx = t;
                    const st = shadeTexRefOf(mats[i], i);
                    if (st != null && st !== lipTexIdx && !texIsEyeIso(st)) origShadeTexIdx = st;
                    break;
                }
            }
        }
        // Prefer shade from any non-lip Face_SKIN materialProperties still on the file
        // (before redirect) — captures tex7 even when eye mtoon extension is absent.
        if (origShadeTexIdx == null || origShadeTexIdx === origTexIdx) {
            for (let i = 0; i < mats.length; i++) {
                if (!mats[i] || isEyeName(mats[i].name || "")) continue;
                if (!isFaceSkinName(mats[i].name || "")) continue;
                try {
                    const propsList = json.extensions && json.extensions.VRM
                        && json.extensions.VRM.materialProperties;
                    const tp = propsList && propsList[i] && propsList[i].textureProperties;
                    if (tp && tp._ShadeTexture != null && (tp._ShadeTexture | 0) !== lipTexIdx) {
                        const st = tp._ShadeTexture | 0;
                        if (st !== origTexIdx) { origShadeTexIdx = st; break; }
                    }
                } catch (e) {}
            }
        }
        if (origShadeTexIdx == null) origShadeTexIdx = origTexIdx;
        if (origTexIdx == null) {
            console.warn("[export][glb-patch] stripLip: no original atlas tex found — abort");
            return null;
        }

        // Redirect Face_SKIN / lip-named mats / any mat still pointing at lipTex
        // back to original shared atlas (main + shade separately).
        // ALSO redirect Eye* that point at __eye_iso copies back to the same
        // original atlas — so load/display always uses the proven shared path
        // (isolate is export-only; on load we restore the clean shared state).
        let redirected = 0;
        let eyeRestored = 0;
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat) continue;
            const nm = mat.name || "";
            const isEye = isEyeName(nm);
            const isLipMat = /__LipPaint|Face_LipPaint/i.test(nm);
            const isFace = isFaceSkinName(nm);
            const cur = texRefOf(mat);
            const pointsAtLip = (lipTexIdx >= 0 && cur === lipTexIdx);
            const pointsAtIso = (cur != null && texIsEyeIso(cur));
            if (isEye) {
                // Restore eyes from __eye_iso → original shared atlas
                if (!pointsAtIso && cur === origTexIdx) continue;
                if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
                mat.pbrMetallicRoughness.baseColorTexture = { index: origTexIdx };
                mat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
                if (mat.extensions && mat.extensions.VRMC_materials_mtoon) {
                    mat.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: origShadeTexIdx };
                    mat.extensions.VRMC_materials_mtoon.shadeColorFactor = [1, 1, 1];
                }
                try {
                    if (json.extensions && json.extensions.VRM
                        && Array.isArray(json.extensions.VRM.materialProperties)
                        && json.extensions.VRM.materialProperties[i]) {
                        const props = json.extensions.VRM.materialProperties[i];
                        if (!props.textureProperties) props.textureProperties = {};
                        props.textureProperties._MainTex = origTexIdx;
                        props.textureProperties._ShadeTexture = origShadeTexIdx;
                    }
                } catch (e) {}
                eyeRestored++;
                redirected++;
                continue;
            }
            if (!isFace && !isLipMat && !pointsAtLip) continue;
            // Always rewrite when pointing at lip; skip only if already on orig main
            // AND shade is already correct (or no shade slot).
            const curShade = shadeTexRefOf(mat, i);
            if (cur === origTexIdx && (curShade == null || curShade === origShadeTexIdx)) continue;
            if (!mat.pbrMetallicRoughness) mat.pbrMetallicRoughness = {};
            mat.pbrMetallicRoughness.baseColorTexture = { index: origTexIdx };
            mat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
            if (mat.extensions && mat.extensions.VRMC_materials_mtoon) {
                mat.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: origShadeTexIdx };
                mat.extensions.VRMC_materials_mtoon.shadeColorFactor = [1, 1, 1];
            }
            try {
                if (json.extensions && json.extensions.VRM
                    && Array.isArray(json.extensions.VRM.materialProperties)
                    && json.extensions.VRM.materialProperties[i]) {
                    const props = json.extensions.VRM.materialProperties[i];
                    if (!props.textureProperties) props.textureProperties = {};
                    props.textureProperties._MainTex = origTexIdx;
                    props.textureProperties._ShadeTexture = origShadeTexIdx;
                }
            } catch (e) {}
            redirected++;
        }

        // Collect image indices to drop: lip + any __eye_iso
        const dropImgIdx = new Set();
        if (lipImgIdx >= 0) dropImgIdx.add(lipImgIdx);
        for (let i = 0; i < imgs.length; i++) {
            if (imgs[i] && /__eye_iso|Eye_Isolated/i.test(imgs[i].name || "")) {
                dropImgIdx.add(i);
            }
        }
        const dropTexIdx = new Set();
        if (lipTexIdx >= 0) dropTexIdx.add(lipTexIdx);
        for (let i = 0; i < texs.length; i++) {
            if (!texs[i]) continue;
            if (/Face_LipPaint|__eye_iso|Eye_Isolated/i.test(texs[i].name || "")) {
                dropTexIdx.add(i);
                continue;
            }
            if (texs[i].source != null && dropImgIdx.has(texs[i].source | 0)) {
                dropTexIdx.add(i);
            }
        }

        // Rebuild BIN without lip / eye_iso bufferViews to stop size growth.
        const dropBv = new Set();
        dropImgIdx.forEach(ii => {
            if (imgs[ii] && imgs[ii].bufferView != null) dropBv.add(imgs[ii].bufferView | 0);
        });
        const binArr = new Uint8Array(bin);
        const usedBv = new Set();
        for (let i = 0; i < bvs.length; i++) {
            if (dropBv.has(i)) continue;
            usedBv.add(i);
        }
        (json.accessors || []).forEach(a => {
            if (a && a.bufferView != null) usedBv.add(a.bufferView | 0);
        });
        (imgs || []).forEach((im, ii) => {
            if (dropImgIdx.has(ii)) return;
            if (im && im.bufferView != null) usedBv.add(im.bufferView | 0);
        });

        const sortedUsed = Array.from(usedBv).filter(i => i >= 0 && i < bvs.length).sort((a, b) => a - b);
        const bvRemap = new Map();
        let newBin = new Uint8Array(0);
        const newBvs = [];
        for (const oldIdx of sortedUsed) {
            const bv = bvs[oldIdx];
            if (!bv) continue;
            const off = bv.byteOffset || 0;
            const len = bv.byteLength || 0;
            if (off + len > binArr.byteLength) continue;
            const padOff = align4(newBin.byteLength);
            const next = new Uint8Array(padOff + align4(len));
            next.set(newBin, 0);
            next.set(binArr.subarray(off, off + len), padOff);
            newBin = next;
            bvRemap.set(oldIdx, newBvs.length);
            newBvs.push({
                buffer: 0,
                byteOffset: padOff,
                byteLength: len,
                ...(bv.byteStride != null ? { byteStride: bv.byteStride } : {}),
                ...(bv.target != null ? { target: bv.target } : {})
            });
        }

        // Remap all bufferView refs
        (json.accessors || []).forEach(a => {
            if (a && a.bufferView != null && bvRemap.has(a.bufferView | 0))
                a.bufferView = bvRemap.get(a.bufferView | 0);
        });
        const newImgs = [];
        const imgRemap = new Map();
        for (let i = 0; i < imgs.length; i++) {
            if (dropImgIdx.has(i)) continue;
            const im = imgs[i];
            if (!im) continue;
            const copy = Object.assign({}, im);
            if (copy.bufferView != null && bvRemap.has(copy.bufferView | 0))
                copy.bufferView = bvRemap.get(copy.bufferView | 0);
            imgRemap.set(i, newImgs.length);
            newImgs.push(copy);
        }
        const newTexs = [];
        const texRemap = new Map();
        for (let i = 0; i < texs.length; i++) {
            if (dropTexIdx.has(i)) continue;
            const t = texs[i];
            if (!t) continue;
            const copy = Object.assign({}, t);
            if (copy.source != null && imgRemap.has(copy.source | 0))
                copy.source = imgRemap.get(copy.source | 0);
            texRemap.set(i, newTexs.length);
            newTexs.push(copy);
        }
        // Remap material texture indices
        const remapTex = (idx) => (idx != null && texRemap.has(idx | 0) ? texRemap.get(idx | 0) : idx);
        mats.forEach(mat => {
            if (!mat) return;
            try {
                if (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture
                    && mat.pbrMetallicRoughness.baseColorTexture.index != null)
                    mat.pbrMetallicRoughness.baseColorTexture.index =
                        remapTex(mat.pbrMetallicRoughness.baseColorTexture.index);
                if (mat.extensions && mat.extensions.VRMC_materials_mtoon) {
                    const mtoon = mat.extensions.VRMC_materials_mtoon;
                    if (mtoon.shadeMultiplyTexture && mtoon.shadeMultiplyTexture.index != null)
                        mtoon.shadeMultiplyTexture.index = remapTex(mtoon.shadeMultiplyTexture.index);
                    if (mtoon.matcapTexture && mtoon.matcapTexture.index != null)
                        mtoon.matcapTexture.index = remapTex(mtoon.matcapTexture.index);
                    if (mtoon.rimMultiplyTexture && mtoon.rimMultiplyTexture.index != null)
                        mtoon.rimMultiplyTexture.index = remapTex(mtoon.rimMultiplyTexture.index);
                    if (mtoon.outlineWidthMultiplyTexture && mtoon.outlineWidthMultiplyTexture.index != null)
                        mtoon.outlineWidthMultiplyTexture.index = remapTex(mtoon.outlineWidthMultiplyTexture.index);
                    if (mtoon.uvAnimationMaskTexture && mtoon.uvAnimationMaskTexture.index != null)
                        mtoon.uvAnimationMaskTexture.index = remapTex(mtoon.uvAnimationMaskTexture.index);
                }
            } catch (e) {}
        });
        try {
            if (json.extensions && json.extensions.VRM
                && Array.isArray(json.extensions.VRM.materialProperties)) {
                json.extensions.VRM.materialProperties.forEach(props => {
                    if (!props || !props.textureProperties) return;
                    const tp = props.textureProperties;
                    ["_MainTex", "_ShadeTexture", "_BumpMap", "_EmissionMap",
                     "_SphereAdd", "_OutlineWidthTexture", "_UvAnimMaskTexture"].forEach(k => {
                        if (tp[k] != null) tp[k] = remapTex(tp[k]);
                    });
                });
            }
        } catch (e) {}

        json.bufferViews = newBvs;
        json.images = newImgs;
        json.textures = newTexs;
        if (!json.buffers || !json.buffers[0]) json.buffers = [{ byteLength: newBin.byteLength }];
        else json.buffers[0].byteLength = newBin.byteLength;

        // Extra diagnostics: sizes of the atlas we restored eyes/face onto
        let origMainInfo = "n/a", origShadeInfo = "n/a";
        try {
            function imgSizeStr(ti) {
                if (ti == null || !texs[ti] || texs[ti].source == null) return "missing";
                const ii = texs[ti].source | 0;
                const im = imgs[ii];
                if (!im || im.bufferView == null || !bvs[im.bufferView]) return "no-bv";
                const bv = bvs[im.bufferView];
                const off = bv.byteOffset || 0;
                const len = bv.byteLength || 0;
                const magic = (len >= 4 && binArr[off] === 0x89 && binArr[off + 1] === 0x50) ? "png"
                    : (len >= 2 && binArr[off] === 0xFF && binArr[off + 1] === 0xD8) ? "jpeg" : "?";
                return "tex" + ti + "→img" + ii + "(" + magic + "," + len + "b"
                    + (im.name ? ",name=" + im.name : "") + ")";
            }
            origMainInfo = imgSizeStr(origTexIdx);
            origShadeInfo = imgSizeStr(origShadeTexIdx);
        } catch (e) {}
        console.warn("[export][glb-patch] stripLipPaint: redirected=", redirected,
            "eyeRestored=", eyeRestored,
            "lipImg=", lipImgIdx, "lipTex=", lipTexIdx, "origTex=", origTexIdx,
            "origShade=", origShadeTexIdx,
            "origMain=", origMainInfo, "origShadeInfo=", origShadeInfo,
            "dropImgs=", dropImgIdx.size, "dropTexs=", dropTexIdx.size,
            "imgs", imgs.length, "→", newImgs.length,
            "bytes", binArr.byteLength, "→", newBin.byteLength);
        return packGlb(json, newBin);
    } catch (e) {
        console.warn("[export][glb-patch] stripLipPaintFromGlb failed", e);
        return null;
    }
}

export function patchLipOntoGlb(baseGlb, lipPngBytes, opts = {}) {
    const png = lipPngBytes instanceof Uint8Array ? lipPngBytes : new Uint8Array(lipPngBytes);
    if (png.byteLength < 64) {
        return baseGlb instanceof ArrayBuffer ? baseGlb : baseGlb.buffer;
    }
    const { json, bin } = parseGlb(baseGlb);
    let binArr = new Uint8Array(bin);

    function isEyeName(name) {
        return /eye|iris|highlight|pupil|瞳|目/i.test(normalizeMaterialName(name));
    }
    function isFaceSkinName(name) {
        const n = normalizeMaterialName(name);
        if (isEyeName(n)) return false;
        if (/face.*skin|skin.*face|face_00_skin|n00_000_00_face_00_skin/i.test(n)) return true;
        return n.indexOf("face") >= 0 && n.indexOf("skin") >= 0;
    }
    function texRefOf(mat) {
        try {
            const pbr = mat && mat.pbrMetallicRoughness;
            const idx = pbr && pbr.baseColorTexture && pbr.baseColorTexture.index;
            return idx != null ? idx : null;
        } catch (e) { return null; }
    }

    const mats = json.materials || [];
    const matCountBefore = mats.length;

    // Snapshot contract-critical state BEFORE mutation
    const eyeSnap = [];
    for (let i = 0; i < mats.length; i++) {
        if (!mats[i] || !isEyeName(mats[i].name || "")) continue;
        eyeSnap.push({
            index: i,
            name: mats[i].name,
            tex: texRefOf(mats[i]),
            matJson: JSON.stringify(mats[i]),
            propsJson: null
        });
        try {
            const propsList = json.extensions && json.extensions.VRM
                && json.extensions.VRM.materialProperties;
            if (propsList && propsList[i]) {
                eyeSnap[eyeSnap.length - 1].propsJson = JSON.stringify(propsList[i]);
            }
        } catch (e) {}
    }
    const primMatBefore = [];
    (json.meshes || []).forEach((mesh, mi) => {
        (mesh.primitives || []).forEach((pr, pi) => {
            if (pr && pr.material != null) primMatBefore.push({ mi, pi, mat: pr.material | 0 });
        });
    });

    let srcIdx = -1;
    for (let i = 0; i < mats.length; i++) {
        if (mats[i] && isFaceSkinName(mats[i].name || "")) {
            const nm = mats[i].name || "";
            if (/__LipPaint/i.test(nm)) continue;
            if (/__morpholith/i.test(nm)) { srcIdx = i; break; }
            if (srcIdx < 0) srcIdx = i;
        }
    }
    if (srcIdx < 0) {
        console.warn("[export][glb-patch] no Face_SKIN material found — no-op");
        return baseGlb instanceof ArrayBuffer ? baseGlb : baseGlb.buffer;
    }

    if (!json.bufferViews) json.bufferViews = [];
    if (!json.images) json.images = [];
    if (!json.textures) json.textures = [];
    if (!json.samplers || !json.samplers.length) {
        json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    }

    // Reuse existing Face_LipPaint slot when present (avoids repeated append bloat).
    let texIndex = -1;
    let imgIndex = -1;
    let reused = false;
    for (let i = 0; i < json.images.length; i++) {
        if (json.images[i] && /Face_LipPaint/i.test(json.images[i].name || "")) {
            imgIndex = i;
            break;
        }
    }
    for (let i = 0; i < json.textures.length; i++) {
        if (json.textures[i] && /Face_LipPaint/i.test(json.textures[i].name || "")) {
            texIndex = i;
            break;
        }
        if (imgIndex >= 0 && json.textures[i] && json.textures[i].source === imgIndex) {
            texIndex = i;
            break;
        }
    }

    const lipMime = (png && png.mimeType) || "image/png";
    // Append new lip bytes, then compact BIN so a reused Face_LipPaint slot
    // does not leave the previous lip payload as permanent dead weight.
    const pngOffset = align4(binArr.byteLength);
    const paddedLen = align4(png.byteLength);
    const next = new Uint8Array(pngOffset + paddedLen);
    next.set(binArr, 0);
    next.set(png, pngOffset);
    binArr = next;

    if (imgIndex >= 0 && texIndex >= 0) {
        const bvIndex = json.bufferViews.length;
        json.bufferViews.push({ buffer: 0, byteOffset: pngOffset, byteLength: png.byteLength });
        json.images[imgIndex].bufferView = bvIndex;
        json.images[imgIndex].mimeType = lipMime;
        json.images[imgIndex].name = "Face_LipPaint";
        if (json.textures[texIndex]) {
            json.textures[texIndex].source = imgIndex;
            json.textures[texIndex].name = "Face_LipPaint";
        }
        reused = true;
    } else {
        const bvIndex = json.bufferViews.length;
        json.bufferViews.push({ buffer: 0, byteOffset: pngOffset, byteLength: png.byteLength });
        imgIndex = json.images.length;
        json.images.push({ name: "Face_LipPaint", mimeType: lipMime, bufferView: bvIndex });
        texIndex = json.textures.length;
        json.textures.push({ sampler: 0, source: imgIndex, name: "Face_LipPaint" });
    }
    try {
        const compacted = compactGlbBin(json, binArr);
        binArr = compacted.bin;
        if (compacted.savedBytes > 256) {
            console.warn("[export][glb-patch] lip patch compact saved=", compacted.savedBytes);
        }
    } catch (eC) {
        console.warn("[export][glb-patch] compact after lip failed", eC);
    }

    // IN-PLACE: only Face_SKIN texture refs change. No new material, no prim retarget.
    const faceMat = mats[srcIdx];
    if (!faceMat.pbrMetallicRoughness) faceMat.pbrMetallicRoughness = {};
    faceMat.pbrMetallicRoughness.baseColorTexture = { index: texIndex };
    faceMat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, 1];
    if (faceMat.extensions && faceMat.extensions.VRMC_materials_mtoon) {
        faceMat.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: texIndex };
        faceMat.extensions.VRMC_materials_mtoon.shadeColorFactor = [1, 1, 1];
    }
    try {
        if (json.extensions && json.extensions.VRM
            && Array.isArray(json.extensions.VRM.materialProperties)
            && json.extensions.VRM.materialProperties[srcIdx]) {
            const props = json.extensions.VRM.materialProperties[srcIdx];
            if (!props.textureProperties) props.textureProperties = {};
            props.textureProperties._MainTex = texIndex;
            props.textureProperties._ShadeTexture = texIndex;
            if (!props.vectorProperties) props.vectorProperties = {};
            props.vectorProperties._Color = [1, 1, 1, 1];
            props.vectorProperties._ShadeColor = [1, 1, 1, 1];
        }
    } catch (e) {}

    // --- Contract asserts: eyes must stay on pre-lip atlas ---
    let eyeOk = 0;
    let eyeFail = 0;
    for (const s of eyeSnap) {
        if (!mats[s.index]) { eyeFail++; continue; }
        try {
            // Always restore from snapshot (not only on mismatch) so any accidental
            // shared-object mutation during Face_SKIN rewrite cannot stick.
            mats[s.index] = JSON.parse(s.matJson);
            if (s.propsJson && json.extensions && json.extensions.VRM
                && Array.isArray(json.extensions.VRM.materialProperties)) {
                json.extensions.VRM.materialProperties[s.index] = JSON.parse(s.propsJson);
            }
            // Guard: if eye tex still points at the new lip slot, force back.
            const curTex = texRefOf(mats[s.index]);
            if (curTex === texIndex && s.tex != null && s.tex !== texIndex) {
                if (!mats[s.index].pbrMetallicRoughness) mats[s.index].pbrMetallicRoughness = {};
                mats[s.index].pbrMetallicRoughness.baseColorTexture = { index: s.tex };
                if (mats[s.index].extensions && mats[s.index].extensions.VRMC_materials_mtoon) {
                    mats[s.index].extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: s.tex };
                }
                try {
                    const props = json.extensions && json.extensions.VRM
                        && json.extensions.VRM.materialProperties
                        && json.extensions.VRM.materialProperties[s.index];
                    if (props && props.textureProperties) {
                        props.textureProperties._MainTex = s.tex;
                        props.textureProperties._ShadeTexture = s.tex;
                    }
                } catch (e2) {}
                console.warn("[export][glb-patch] ASSERT eye tex was lip — forced back", s.name, "→", s.tex);
                eyeFail++;
            } else {
                eyeOk++;
            }
        } catch (e) { eyeFail++; }
    }
    // Also scan by name in case material indices drifted
    try {
        for (let i = 0; i < mats.length; i++) {
            if (!mats[i] || !isEyeName(mats[i].name || "")) continue;
            const cur = texRefOf(mats[i]);
            if (cur !== texIndex) continue;
            const snap = eyeSnap.find(s => s.index === i)
                || eyeSnap.find(s => normalizeMaterialName(s.name) === normalizeMaterialName(mats[i].name || ""));
            if (!snap || snap.tex == null) continue;
            mats[i] = JSON.parse(snap.matJson);
            if (snap.propsJson && json.extensions && json.extensions.VRM
                && Array.isArray(json.extensions.VRM.materialProperties)) {
                json.extensions.VRM.materialProperties[i] = JSON.parse(snap.propsJson);
            }
            console.warn("[export][glb-patch] ASSERT eye-by-name was on lip — restored", mats[i].name);
            eyeFail++;
        }
    } catch (e) {}
    if (mats.length !== matCountBefore) {
        console.warn("[export][glb-patch] ASSERT FAIL materials.length", matCountBefore, "→", mats.length);
    }
    let primDrift = 0;
    let pi = 0;
    (json.meshes || []).forEach((mesh, mi) => {
        (mesh.primitives || []).forEach((pr, pii) => {
            if (!pr || pr.material == null) return;
            const expected = primMatBefore[pi];
            if (expected && (expected.mat !== (pr.material | 0))) {
                primDrift++;
                console.warn("[export][glb-patch] ASSERT FAIL prim material drift",
                    "mesh", mi, "prim", pii, expected.mat, "→", pr.material);
            }
            pi++;
        });
    });

    if (!json.buffers || !json.buffers[0]) json.buffers = [{ byteLength: binArr.byteLength }];
    else json.buffers[0].byteLength = binArr.byteLength;

    // Post-patch eye image health: confirm eye main/shade still point at large PNGs
    try {
        const imgs = json.images || [];
        const texs = json.textures || [];
        const bvs = json.bufferViews || [];
        for (const s of eyeSnap) {
            const m = mats[s.index];
            if (!m) continue;
            const pbrIdx = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture
                && m.pbrMetallicRoughness.baseColorTexture.index;
            let imgBytes = -1;
            if (pbrIdx != null && texs[pbrIdx] && texs[pbrIdx].source != null) {
                const img = imgs[texs[pbrIdx].source];
                if (img && img.bufferView != null && bvs[img.bufferView]) {
                    imgBytes = bvs[img.bufferView].byteLength | 0;
                }
            }
            if (imgBytes >= 0 && imgBytes < 10000) {
                console.warn("[export][glb-patch] EYE IMAGE TOO SMALL after patch",
                    s.name, "bytes=", imgBytes, "— possible corruption");
            }
        }
    } catch (eHealth) {}

    console.warn("[export][glb-patch] lip IN-PLACE mat", srcIdx,
        "tex=", texIndex, "bytes=", png.byteLength, "mime=", lipMime,
        "reused=", reused, "eyeOk=", eyeOk, "eyeFail=", eyeFail, "primDrift=", primDrift,
        "matCount=", mats.length,
        "(contract: no new material, prims unchanged, eyes frozen)");
    return packGlb(json, binArr);
}

/**
 * Give Eye* materials their own copy of any image still shared with Face_SKIN.
 * Some VRM loaders appear to break eye sampling when Face_SKIN later retargets
 * away from a previously shared atlas (hybrid+lip path → black eyes on reload),
 * even though the GLB JSON still points eyes at the original large PNG.
 *
 * Duplicates shared image bytes, adds a new texture, redirects only Eye* mats.
 *
 * @param {ArrayBuffer|Uint8Array} glb
 * @returns {ArrayBuffer}
 */
/**
 * Eyes left on VRM0 blendMode=2 (Transparent) after isolate/lip correlate with
 * pure-black MToon in three-vrm while texture samples remain healthy.
 * Force Cutout (1) + reasonable cutoff so load matches opaque-ish eye shading.
 * Mutates JSON materials / materialProperties in place. Returns count fixed.
 *
 * Robust: always walk materialProperties by name (index can drift after
 * isolate / outline inserts), force glTF alphaMode MASK, clear mtoon
 * transparentWithZWrite, and set keywordMap / tagMap for VRM0 viewers.
 */
export function normalizeEyeBlendModeToCutout(glb) {
    try {
        const { json, bin } = parseGlb(glb);
        if (!json || !json.materials) return { glb, fixed: 0 };
        let fixed = 0;
        const mats = json.materials;
        const propsList = (json.extensions && json.extensions.VRM
            && json.extensions.VRM.materialProperties) || [];
        function isEyeName(n) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(String(n || ""));
        }
        function forcePropsCutout(props) {
            if (!props) return false;
            if (!props.floatProperties) props.floatProperties = {};
            const fp = props.floatProperties;
            // Coerce string/float — some seed paths leave "2" or 2.0
            const bmRaw = fp._BlendMode;
            const bm = bmRaw == null ? null : Number(bmRaw);
            let changed = false;
            // Always force Cutout (1) unless already 1
            if (bm !== 1) {
                fp._BlendMode = 1;
                changed = true;
            }
            if (fp._Cutoff == null || Number(fp._Cutoff) <= 0) {
                fp._Cutoff = 0.5;
                changed = true;
            }
            // Transparent keywords off → Cutout keywords on
            if (!props.keywordMap) props.keywordMap = {};
            if (props.keywordMap._ALPHABLEND_ON) {
                props.keywordMap._ALPHABLEND_ON = false;
                changed = true;
            }
            if (!props.keywordMap._ALPHATEST_ON) {
                props.keywordMap._ALPHATEST_ON = true;
                changed = true;
            }
            if (!props.tagMap) props.tagMap = {};
            if (props.tagMap.RenderType !== "TransparentCutout") {
                props.tagMap.RenderType = "TransparentCutout";
                changed = true;
            }
            // ZWrite on for cutout
            if (fp._ZWrite === 0 || fp._ZWrite === "0") {
                fp._ZWrite = 1;
                changed = true;
            }
            return changed;
        }
        // 1) materials[] by name
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat || !isEyeName(mat.name)) continue;
            let did = false;
            // Prefer parallel index, then any props with matching name
            let props = (propsList[i] && isEyeName(propsList[i].name || mats[i].name))
                ? propsList[i]
                : propsList.find(p => p && isEyeName(p.name));
            // Also try exact name match ignoring Instance suffix
            if (!props) {
                const base = String(mat.name || "").replace(/\s*\(Instance\)\s*$/i, "");
                props = propsList.find(p => p && String(p.name || "").replace(/\s*\(Instance\)\s*$/i, "") === base);
            }
            if (forcePropsCutout(props)) did = true;
            // glTF alphaMode → MASK
            if (mat.alphaMode === "BLEND" || mat.alphaMode == null || mat.alphaMode === "OPAQUE") {
                // Eyes with texture alpha need MASK not OPAQUE; BLEND is the black-eye culprit
                if (mat.alphaMode !== "MASK") {
                    mat.alphaMode = "MASK";
                    did = true;
                }
                if (mat.alphaCutoff == null || mat.alphaCutoff <= 0) mat.alphaCutoff = 0.5;
            }
            // VRMC_materials_mtoon
            const mtoon = mat.extensions && mat.extensions.VRMC_materials_mtoon;
            if (mtoon) {
                if (mtoon.transparentWithZWrite) {
                    mtoon.transparentWithZWrite = false;
                    did = true;
                }
                // Prefer renderQueue for cutout-ish (2450) over transparent (3000+)
                if (typeof mtoon.renderQueue === "number" && mtoon.renderQueue >= 3000) {
                    mtoon.renderQueue = 2450;
                    did = true;
                }
            }
            if (did) fixed++;
        }
        // 2) Orphan materialProperties whose name is eye but materials[] missed them
        for (let pi = 0; pi < propsList.length; pi++) {
            const props = propsList[pi];
            if (!props || !isEyeName(props.name)) continue;
            if (forcePropsCutout(props)) fixed++;
        }
        if (!fixed) {
            // Dump actual bm values so we can see why nothing changed
            const dump = [];
            for (let i = 0; i < mats.length; i++) {
                if (!mats[i] || !isEyeName(mats[i].name)) continue;
                const p = propsList[i] || propsList.find(x => x && isEyeName(x.name));
                const bm = p && p.floatProperties && p.floatProperties._BlendMode;
                dump.push(mats[i].name + " bm=" + bm + " alpha=" + mats[i].alphaMode);
            }
            console.warn("[export][glb-patch] normalizeEyeBlendModeToCutout fixed=0",
                "propsLen=", propsList.length, "dump=", dump.join(" | ") || "(no eye mats)");
            return { glb, fixed: 0 };
        }
        const out = packGlb(json, bin || new Uint8Array(0));
        console.warn("[export][glb-patch] normalizeEyeBlendModeToCutout fixed=", fixed);
        return { glb: out, fixed };
    } catch (e) {
        console.warn("[export][glb-patch] normalizeEyeBlendModeToCutout failed", e);
        return { glb, fixed: 0 };
    }
}


/**
 * Transparent eyes often keep _Cutoff=0.5 from VRoid seed while alphaMode is BLEND.
 * That combo makes three-vrm discard / mis-blend sclera (looks transparent / black).
 * Keep blendMode=2 (Transparent) but force _Cutoff=0 and clear alphaCutoff.
 */
export function fixEyeTransparentCutoff(glb) {
    try {
        const { json, bin } = parseGlb(glb);
        if (!json || !json.materials) return { glb, fixed: 0 };
        let fixed = 0;
        const mats = json.materials;
        const propsList = (json.extensions && json.extensions.VRM
            && json.extensions.VRM.materialProperties) || [];
        function isEyeName(n) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(String(n || ""));
        }
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat || !isEyeName(mat.name)) continue;
            let changed = false;
            // Prefer Transparent blend for soft iris edges; kill bogus cutoff
            if (mat.alphaMode === "MASK") {
                mat.alphaMode = "BLEND";
                changed = true;
            }
            if (mat.alphaCutoff != null && mat.alphaCutoff > 0) {
                delete mat.alphaCutoff;
                changed = true;
            }
            // Match materialProperties by name (not first eye-only find)
            let props = null;
            const matBase = String(mat.name || "").replace(/\s*\(Instance\)\s*$/i, "");
            for (let pi = 0; pi < propsList.length; pi++) {
                const p = propsList[pi];
                if (!p) continue;
                const pn = String(p.name || "").replace(/\s*\(Instance\)\s*$/i, "");
                if (pn === matBase || p.name === mat.name) { props = p; break; }
            }
            if (!props && propsList[i] && isEyeName(propsList[i].name)) props = propsList[i];
            if (props) {
                if (!props.floatProperties) props.floatProperties = {};
                const fp = props.floatProperties;
                const bm = fp._BlendMode == null ? null : Number(fp._BlendMode);
                if (bm !== 2) {
                    fp._BlendMode = 2;
                    changed = true;
                }
                if (fp._Cutoff == null || Number(fp._Cutoff) !== 0) {
                    fp._Cutoff = 0;
                    changed = true;
                }
                if (fp._ZWrite == null || Number(fp._ZWrite) !== 0) {
                    fp._ZWrite = 0;
                    changed = true;
                }
                if (!props.keywordMap) props.keywordMap = {};
                if (!props.keywordMap._ALPHABLEND_ON) {
                    props.keywordMap._ALPHABLEND_ON = true;
                    changed = true;
                }
                if (props.keywordMap._ALPHATEST_ON) {
                    props.keywordMap._ALPHATEST_ON = false;
                    changed = true;
                }
                if (!props.tagMap) props.tagMap = {};
                if (props.tagMap.RenderType !== "Transparent") {
                    props.tagMap.RenderType = "Transparent";
                    changed = true;
                }
            }
            if (changed) fixed++;
        }
        if (!fixed) return { glb, fixed: 0 };
        const out = packGlb(json, bin || new Uint8Array(0));
        console.warn("[export][glb-patch] fixEyeTransparentCutoff fixed=", fixed);
        return { glb: out, fixed };
    } catch (e) {
        console.warn("[export][glb-patch] fixEyeTransparentCutoff failed", e);
        return { glb, fixed: 0 };
    }
}

export function isolateEyeImagesFromFaceShare(glb) {
    try {
        const { json, bin } = parseGlb(glb);
        if (!json || !bin) return glb instanceof ArrayBuffer ? glb : glb.buffer;
        const mats = json.materials || [];
        const texs = json.textures || [];
        const imgs = json.images || [];
        const bvs = json.bufferViews || [];
        let binArr = new Uint8Array(bin);

        function isEyeName(name) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(normalizeMaterialName(name));
        }
        function isFaceSkinName(name) {
            const n = normalizeMaterialName(name);
            if (isEyeName(n)) return false;
            return /face.*skin|skin.*face|face_00_skin|n00_000_00_face_00_skin/i.test(n)
                || (n.indexOf("face") >= 0 && n.indexOf("skin") >= 0);
        }
        function texIndicesOf(mat) {
            const out = [];
            try {
                const pbr = mat && mat.pbrMetallicRoughness;
                const ti = pbr && pbr.baseColorTexture && pbr.baseColorTexture.index;
                if (ti != null) out.push(ti | 0);
            } catch (e) {}
            try {
                const mtoon = mat && mat.extensions && mat.extensions.VRMC_materials_mtoon;
                const si = mtoon && mtoon.shadeMultiplyTexture && mtoon.shadeMultiplyTexture.index;
                if (si != null) out.push(si | 0);
            } catch (e) {}
            return out;
        }
        function imgOfTex(ti) {
            if (ti == null || !texs[ti] || texs[ti].source == null) return null;
            return texs[ti].source | 0;
        }

        const faceImgs = new Set();
        const eyeMats = [];
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat) continue;
            const nm = mat.name || "";
            // Only Face_SKIN — FaceMouth may keep sharing the atlas with eyes.
            // Isolation is only needed so Face_SKIN can retarget to lip without
            // breaking eye sampling in some VRM loaders.
            if (isFaceSkinName(nm)) {
                for (const ti of texIndicesOf(mat)) {
                    const ii = imgOfTex(ti);
                    if (ii != null) faceImgs.add(ii);
                }
                try {
                    const props = json.extensions && json.extensions.VRM
                        && json.extensions.VRM.materialProperties
                        && json.extensions.VRM.materialProperties[i];
                    const tp = props && props.textureProperties;
                    if (tp) {
                        if (tp._MainTex != null) {
                            const ii = imgOfTex(tp._MainTex | 0);
                            if (ii != null) faceImgs.add(ii);
                        }
                        if (tp._ShadeTexture != null) {
                            const ii = imgOfTex(tp._ShadeTexture | 0);
                            if (ii != null) faceImgs.add(ii);
                        }
                    }
                } catch (e) {}
            }
            if (isEyeName(nm)) eyeMats.push(i);
        }
        if (!eyeMats.length || !faceImgs.size) {
            return glb instanceof ArrayBuffer ? glb : glb.buffer;
        }

        // Map: shared imgIdx → { newImgIdx, newTexIdx, bytes, mime }
        // Physical byte copy is required for black-eye fix (zero-copy was not enough).
        // Bytes are kept here; caller may JPEG-compress via compressIsolatedEyeImages.
        const dupMap = new Map();
        let isolated = 0;

        function ensureDup(imgIdx) {
            if (dupMap.has(imgIdx)) return dupMap.get(imgIdx);
            const img = imgs[imgIdx];
            if (!img || img.bufferView == null) return null;
            const bv = bvs[img.bufferView];
            if (!bv) return null;
            const off = bv.byteOffset || 0;
            const len = bv.byteLength || 0;
            if (len < 64 || off + len > binArr.byteLength) return null;
            const bytes = binArr.subarray(off, off + len);
            const pngOffset = align4(binArr.byteLength);
            const paddedLen = align4(len);
            const next = new Uint8Array(pngOffset + paddedLen);
            next.set(binArr, 0);
            next.set(bytes, pngOffset);
            binArr = next;
            const bvIndex = bvs.length;
            bvs.push({ buffer: 0, byteOffset: pngOffset, byteLength: len });
            const newImgIdx = imgs.length;
            imgs.push({
                name: (img.name || "img") + "__eye_iso",
                mimeType: img.mimeType || "image/png",
                bufferView: bvIndex
            });
            const newTexIdx = texs.length;
            texs.push({
                sampler: (texs[0] && texs[0].sampler != null) ? texs[0].sampler : 0,
                source: newImgIdx,
                name: "Eye_Isolated_" + imgIdx
            });
            const entry = { newImgIdx, newTexIdx, oldImgIdx: imgIdx };
            dupMap.set(imgIdx, entry);
            isolated++;
            return entry;
        }

        function retargetTexIndex(ti) {
            if (ti == null) return ti;
            const ii = imgOfTex(ti);
            if (ii == null || !faceImgs.has(ii)) return ti;
            const d = ensureDup(ii);
            return d ? d.newTexIdx : ti;
        }

        for (const mi of eyeMats) {
            const mat = mats[mi];
            if (!mat) continue;
            try {
                if (mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorTexture
                    && mat.pbrMetallicRoughness.baseColorTexture.index != null) {
                    mat.pbrMetallicRoughness.baseColorTexture.index =
                        retargetTexIndex(mat.pbrMetallicRoughness.baseColorTexture.index | 0);
                }
            } catch (e) {}
            try {
                const mtoon = mat.extensions && mat.extensions.VRMC_materials_mtoon;
                if (mtoon && mtoon.shadeMultiplyTexture && mtoon.shadeMultiplyTexture.index != null) {
                    mtoon.shadeMultiplyTexture.index =
                        retargetTexIndex(mtoon.shadeMultiplyTexture.index | 0);
                }
            } catch (e) {}
            try {
                const props = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties
                    && json.extensions.VRM.materialProperties[mi];
                if (props && props.textureProperties) {
                    if (props.textureProperties._MainTex != null) {
                        props.textureProperties._MainTex =
                            retargetTexIndex(props.textureProperties._MainTex | 0);
                    }
                    if (props.textureProperties._ShadeTexture != null) {
                        props.textureProperties._ShadeTexture =
                            retargetTexIndex(props.textureProperties._ShadeTexture | 0);
                    }
                }
            } catch (e) {}
        }

        if (!json.buffers || !json.buffers[0]) json.buffers = [{ byteLength: binArr.byteLength }];
        else json.buffers[0].byteLength = binArr.byteLength;

        if (isolated > 0) {
            console.warn("[export][glb-patch] isolateEye: byte-dup", isolated,
                "atlas(es) for", eyeMats.length, "eye mat(s) — compress next");
            return packGlb(json, binArr);
        }
        return glb instanceof ArrayBuffer ? glb : glb.buffer;
    } catch (e) {
        console.warn("[export][glb-patch] isolateEyeImagesFromFaceShare failed", e);
        return glb instanceof ArrayBuffer ? glb : glb.buffer;
    }
}

/**
 * Re-encode __eye_iso images smaller WITHOUT losing alpha.
 * JPEG strips alpha → black eyes. Prefer WebP (keeps alpha); else leave PNG as-is.
 * @param {ArrayBuffer|Uint8Array} glb
 * @returns {Promise<ArrayBuffer>}
 */
export async function compressIsolatedEyeImages(glb) {
    try {
        const { json, bin } = parseGlb(glb);
        if (!json || !bin) return glb instanceof ArrayBuffer ? glb : glb.buffer;
        const imgs = json.images || [];
        const bvs = json.bufferViews || [];
        let binArr = new Uint8Array(bin);
        let compressed = 0;
        let saved = 0;

        async function encodeWithAlpha(u8, quality) {
            const mime = (u8[0] === 0x89 && u8[1] === 0x50) ? "image/png"
                : (u8[0] === 0x52 && u8[1] === 0x49) ? "image/webp"
                : null;
            if (!mime) return null;
            const blob = new Blob([u8], { type: mime });
            let bitmap = null;
            try {
                if (typeof createImageBitmap === "function") {
                    bitmap = await createImageBitmap(blob);
                }
            } catch (e) {}
            async function toCanvas(source) {
                const canvas = document.createElement("canvas");
                canvas.width = source.width;
                canvas.height = source.height;
                const ctx = canvas.getContext("2d", { alpha: true });
                if (!ctx) return null;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(source, 0, 0);
                // WebP keeps alpha; never use JPEG for eye atlases
                let outBlob = await new Promise(r => canvas.toBlob(r, "image/webp", quality)); // quality=1 still often lossy
                let outMime = "image/webp";
                if (!outBlob || outBlob.size < 64) {
                    console.warn("[export][glb-patch] webp encode unavailable — keep PNG for eye_iso");
                    return null; // leave original PNG (correct alpha, larger)
                }
                return {
                    bytes: new Uint8Array(await outBlob.arrayBuffer()),
                    mimeType: outMime
                };
            }
            if (bitmap) {
                try {
                    return await toCanvas(bitmap);
                } finally {
                    try { bitmap.close(); } catch (e) {}
                }
            }
            const url = URL.createObjectURL(blob);
            try {
                const im = await new Promise((resolve, reject) => {
                    const el = new Image();
                    el.onload = () => resolve(el);
                    el.onerror = reject;
                    el.src = url;
                });
                return await toCanvas(im);
            } finally {
                URL.revokeObjectURL(url);
            }
        }

        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (!img || !/__eye_iso|Eye_Isolated/i.test(img.name || "")) continue;
            if (img.bufferView == null || !bvs[img.bufferView]) continue;
            const bv = bvs[img.bufferView];
            const off = bv.byteOffset || 0;
            const len = bv.byteLength || 0;
            if (len < 100000 || off + len > binArr.byteLength) continue;
            const src = binArr.subarray(off, off + len);
            // already webp
            if (src[0] === 0x52 && src[1] === 0x49 && len > 12 && src[8] === 0x57) continue;
            // JPEG eye_iso is alpha-less and wrong — do not keep; try re-encode from… can't recover alpha
            if (src[0] === 0xFF && src[1] === 0xD8) {
                console.warn("[export][glb-patch] eye_iso img", i, "is JPEG (no alpha) — leave as-is; prefer PNG path next export");
                continue;
            }
            // KEEP PNG for eye_iso. Lossy WebP via canvas correlated with
            // pure-black MToon on reload even when blendMode=Cutout and CPU
            // samples looked fine. Size cost is real; correctness first.
            console.warn("[export][glb-patch] compress eye_iso img", i,
                "skip WebP — keep PNG for alpha-safe iso");
            continue;
            const newOff = align4(binArr.byteLength);
            const pad = align4(out.bytes.byteLength);
            const next = new Uint8Array(newOff + pad);
            next.set(binArr, 0);
            next.set(out.bytes, newOff);
            binArr = next;
            const newBv = bvs.length;
            bvs.push({ buffer: 0, byteOffset: newOff, byteLength: out.bytes.byteLength });
            img.bufferView = newBv;
            img.mimeType = out.mimeType;
            compressed++;
            saved += (len - out.bytes.byteLength);
        }

        if (compressed > 0) {
            // Rebuild BIN without orphaned pre-compress PNG tails
            const used = new Set();
            imgs.forEach(im => { if (im && im.bufferView != null) used.add(im.bufferView | 0); });
            (json.accessors || []).forEach(a => {
                if (a && a.bufferView != null) used.add(a.bufferView | 0);
                if (a && a.sparse) {
                    if (a.sparse.indices && a.sparse.indices.bufferView != null)
                        used.add(a.sparse.indices.bufferView | 0);
                    if (a.sparse.values && a.sparse.values.bufferView != null)
                        used.add(a.sparse.values.bufferView | 0);
                }
            });
            const oldBvs = bvs.slice();
            const newBinParts = [];
            let cursor = 0;
            const remapBv = new Map();
            for (let bi = 0; bi < oldBvs.length; bi++) {
                if (!used.has(bi)) continue;
                const bv = oldBvs[bi];
                if (!bv) continue;
                const off = bv.byteOffset || 0;
                const len = bv.byteLength || 0;
                if (off + len > binArr.byteLength) continue;
                const slice = binArr.subarray(off, off + len);
                const padOff = align4(cursor);
                const pad = new Uint8Array(padOff + align4(len));
                // We'll accumulate via push of {padOff, slice, len, bi}
                remapBv.set(bi, { padOff, len, slice });
                cursor = padOff + align4(len);
            }
            const compact = new Uint8Array(cursor);
            const newBvs = oldBvs.map(() => null);
            remapBv.forEach((v, bi) => {
                compact.set(v.slice, v.padOff);
                newBvs[bi] = {
                    buffer: 0,
                    byteOffset: v.padOff,
                    byteLength: v.len
                };
                if (oldBvs[bi].target != null) newBvs[bi].target = oldBvs[bi].target;
                if (oldBvs[bi].byteStride != null) newBvs[bi].byteStride = oldBvs[bi].byteStride;
            });
            // Keep indices stable: unused slots stay as empty 0-length views
            for (let bi = 0; bi < oldBvs.length; bi++) {
                if (newBvs[bi]) continue;
                newBvs[bi] = { buffer: 0, byteOffset: 0, byteLength: 0 };
            }
            json.bufferViews = newBvs;
            binArr = compact;
            if (!json.buffers || !json.buffers[0]) json.buffers = [{ byteLength: binArr.byteLength }];
            else json.buffers[0].byteLength = binArr.byteLength;
            console.warn("[export][glb-patch] compress eye_iso (webp/alpha):", compressed,
                "image(s), saved≈", Math.round(saved / 1024), "KB",
                "bin≈", Math.round(binArr.byteLength / 1024), "KB");
            return packGlb(json, binArr);
        }
        // Explicit no-op log so missing compress is visible in save.log
        console.warn("[export][glb-patch] compress eye_iso: no change (webp unavailable or not smaller; PNG iso kept)");
        return glb instanceof ArrayBuffer ? glb : glb.buffer;
    } catch (e) {
        console.warn("[export][glb-patch] compressIsolatedEyeImages failed", e);
        return glb instanceof ArrayBuffer ? glb : glb.buffer;
    }
}

/**
 * After any export/patch: ensure every image referenced by Eye* materials still
 * has valid PNG/JPEG magic and matches the pristine GLB when possible.
 * Hybrid-seed + lip combined path was producing black eyes on reload even when
 * material JSON looked correct — this hard-repairs the image bytes.
 *
 * @param {ArrayBuffer|Uint8Array} outGlb
 * @param {ArrayBuffer|Uint8Array|null} pristineGlb
 * @returns {ArrayBuffer}
 */
export function repairEyeImagesFromPristine(outGlb, pristineGlb) {
    try {
        const out = parseGlb(outGlb);
        if (!out.json || !out.bin) return outGlb instanceof ArrayBuffer ? outGlb : outGlb.buffer;

        function isEyeName(name) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(normalizeMaterialName(name));
        }
        function collectImageIndices(json) {
            const mats = json.materials || [];
            const texs = json.textures || [];
            const idxs = new Set();
            for (const mat of mats) {
                if (!mat || !isEyeName(mat.name || "")) continue;
                try {
                    const pbr = mat.pbrMetallicRoughness;
                    const ti = pbr && pbr.baseColorTexture && pbr.baseColorTexture.index;
                    if (ti != null && texs[ti] && texs[ti].source != null)
                        idxs.add(texs[ti].source | 0);
                    const mtoon = mat.extensions && mat.extensions.VRMC_materials_mtoon;
                    const si = mtoon && mtoon.shadeMultiplyTexture && mtoon.shadeMultiplyTexture.index;
                    if (si != null && texs[si] && texs[si].source != null)
                        idxs.add(texs[si].source | 0);
                } catch (e) {}
                try {
                    const props = json.extensions && json.extensions.VRM
                        && json.extensions.VRM.materialProperties;
                    // materialProperties is parallel array — find by name
                } catch (e) {}
            }
            // Also from VRM0 materialProperties by eye name
            try {
                const propsList = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties;
                if (Array.isArray(propsList)) {
                    propsList.forEach((props, i) => {
                        const nm = (props && props.name) || (mats[i] && mats[i].name) || "";
                        if (!isEyeName(nm)) return;
                        const tp = props && props.textureProperties;
                        if (!tp) return;
                        ["_MainTex", "_ShadeTexture"].forEach(k => {
                            const ti = tp[k];
                            if (ti != null && texs[ti] && texs[ti].source != null)
                                idxs.add(texs[ti].source | 0);
                        });
                    });
                }
            } catch (e) {}
            return idxs;
        }

        function isPngMagic(u8, off) {
            return u8[off] === 0x89 && u8[off+1] === 0x50 && u8[off+2] === 0x4E && u8[off+3] === 0x47;
        }
        function isJpegMagic(u8, off) {
            return u8[off] === 0xFF && u8[off+1] === 0xD8;
        }
        function isWebpMagic(u8, off) {
            return u8[off] === 0x52 && u8[off+1] === 0x49 && u8[off+2] === 0x46 && u8[off+3] === 0x46;
        }

        const eyeImgIdxs = collectImageIndices(out.json);
        if (!eyeImgIdxs.size) {
            console.warn("[export][glb-patch] repairEye: no eye images found");
            return outGlb instanceof ArrayBuffer ? outGlb : outGlb.buffer;
        }

        let binArr = new Uint8Array(out.bin);
        const imgs = out.json.images || [];
        const bvs = out.json.bufferViews || [];
        let repaired = 0;
        let ok = 0;

        // Build pristine image fingerprint map: byteLength → bytes (and name)
        let prisImgs = null;
        let prisBin = null;
        let prisBvs = null;
        if (pristineGlb) {
            try {
                const pr = parseGlb(pristineGlb);
                prisImgs = pr.json && pr.json.images;
                prisBin = pr.bin ? new Uint8Array(pr.bin) : null;
                prisBvs = pr.json && pr.json.bufferViews;
            } catch (e) {}
        }

        // Restore eye image bytes from pristine when available — EXCEPT intentional
        // __eye_iso copies (byte-dup + JPEG compress for black-eye isolation).
        // Replacing those with a wrong-size pristine candidate was turning eyes black.
        for (const imgIdx of eyeImgIdxs) {
            const img = imgs[imgIdx];
            if (!img || img.bufferView == null) continue;
            if (/__eye_iso|Eye_Isolated/i.test(img.name || "")) {
                const bv0 = bvs[img.bufferView];
                const off0 = bv0 ? (bv0.byteOffset || 0) : 0;
                const len0 = bv0 ? (bv0.byteLength || 0) : 0;
                const magic0 = bv0 && len0 >= 8 && (
                    isPngMagic(binArr, off0) || isJpegMagic(binArr, off0) || isWebpMagic(binArr, off0)
                );
                if (magic0 && len0 >= 10000) {
                    ok++;
                    console.warn("[export][glb-patch] repairEye: skip __eye_iso img", imgIdx,
                        "len=", len0, "(isolated+compressed, leave alone)");
                } else {
                    console.warn("[export][glb-patch] repairEye: __eye_iso img", imgIdx,
                        "looks bad len=", len0, "— not rewriting from pristine");
                }
                continue;
            }
            const bv = bvs[img.bufferView];
            if (!bv) continue;
            const off = bv.byteOffset || 0;
            const len = bv.byteLength || 0;
            if (off + len > binArr.byteLength) {
                console.warn("[export][glb-patch] repairEye: bv OOB img", imgIdx);
                continue;
            }
            const magicOk = len >= 8 && (isPngMagic(binArr, off) || isJpegMagic(binArr, off) || isWebpMagic(binArr, off));
            const sizeOk = len >= 10000;

            if (!prisBin || !prisImgs || !prisBvs) {
                if (magicOk && sizeOk) ok++;
                else console.warn("[export][glb-patch] repairEye: BAD eye img (no pristine)", imgIdx,
                    "len=", len, "magicOk=", magicOk);
                continue;
            }

            // Match pristine candidate: prefer same byteLength + magic, then ~3.2MB face atlas
            let best = null;
            for (let pi = 0; pi < prisImgs.length; pi++) {
                const pimg = prisImgs[pi];
                if (!pimg || pimg.bufferView == null) continue;
                const pbv = prisBvs[pimg.bufferView];
                if (!pbv) continue;
                const plen = pbv.byteLength || 0;
                if (plen < 10000) continue;
                const poff = pbv.byteOffset || 0;
                if (poff + plen > prisBin.byteLength) continue;
                if (!isPngMagic(prisBin, poff) && !isJpegMagic(prisBin, poff)) continue;
                let score;
                if (len > 0 && plen === len) score = 0; // exact size match
                else if (img.name && pimg.name && img.name === pimg.name) score = 10;
                else score = Math.abs(plen - (len > 10000 ? len : 3235422));
                if (best == null || score < best.score) {
                    best = { pi, plen, poff, score, mime: pimg.mimeType || "image/png" };
                }
            }
            if (!best || best.score > 500000) {
                for (let pi = 0; pi < prisImgs.length; pi++) {
                    const pimg = prisImgs[pi];
                    if (!pimg || pimg.bufferView == null) continue;
                    const pbv = prisBvs[pimg.bufferView];
                    if (!pbv) continue;
                    const plen = pbv.byteLength || 0;
                    if (plen < 100000) continue;
                    const poff = pbv.byteOffset || 0;
                    if (poff + plen > prisBin.byteLength) continue;
                    if (!isPngMagic(prisBin, poff)) continue;
                    const score = Math.abs(plen - 3235422);
                    if (best == null || score < best.score) {
                        best = { pi, plen, poff, score, mime: pimg.mimeType || "image/png" };
                    }
                }
            }
            if (!best) {
                if (magicOk && sizeOk) ok++;
                else console.warn("[export][glb-patch] repairEye: no pristine candidate for img", imgIdx);
                continue;
            }

            // Valid large image (PNG/JPEG/WebP, >=10KB): leave alone.
            // Intentional re-encode / textureScale (軽量 preset) produces different
            // bytes and often smaller size than pristine. Rewriting those with a
            // size-heuristic pristine match was overwriting Face+Eye shared atlas
            // main AND shade with the SAME image → solid blue / wrong face.
            // Only restore when magic is broken or payload is tiny (true corruption).
            if (magicOk && sizeOk) {
                ok++;
                if (len !== best.plen) {
                    try {
                        console.warn("[export][glb-patch] repairEye: keep reencoded img", imgIdx,
                            "len=", len, "pristine~", best.plen, "(scale/compress — no rewrite)");
                    } catch (e) {}
                }
                continue;
            }

            // Append pristine bytes and retarget bufferView (keep other offsets stable)
            const newOff = align4(binArr.byteLength);
            const padded = align4(best.plen);
            const next = new Uint8Array(newOff + padded);
            next.set(binArr, 0);
            next.set(prisBin.subarray(best.poff, best.poff + best.plen), newOff);
            binArr = next;
            bv.byteOffset = newOff;
            bv.byteLength = best.plen;
            if (best.mime) img.mimeType = best.mime;
            repaired++;
            console.warn("[export][glb-patch] repairEye: restored img", imgIdx,
                "from pristine pi", best.pi, "bytes", best.plen, "(was BAD)");
        }

        if (!out.json.buffers || !out.json.buffers[0])
            out.json.buffers = [{ byteLength: binArr.byteLength }];
        else
            out.json.buffers[0].byteLength = binArr.byteLength;

        console.warn("[export][glb-patch] repairEye: ok=", ok, "repaired=", repaired,
            "eyeImgs=", eyeImgIdxs.size);
        if (repaired > 0) return packGlb(out.json, binArr);
        return outGlb instanceof ArrayBuffer ? outGlb : outGlb.buffer;
    } catch (e) {
        console.warn("[export][glb-patch] repairEyeImagesFromPristine failed", e);
        return outGlb instanceof ArrayBuffer ? outGlb : outGlb.buffer;
    }
}

/**
 * Encode lip bake texture for GLB append.
 * Prefer WebP (much smaller than PNG) → JPEG → PNG.
 * Returns Uint8Array with .mimeType set for the caller.
 */
/**
 * Encode the lip-painted Face atlas for GLB append.
 *
 * Size note: lip paint is a full Face atlas (often 2048–4096²), not a tiny
 * lip crop — Face_SKIN needs the whole map. Growth of several MB as PNG was
 * expected but avoidable:
 *  - honor textureScale / maxSide (UI テクスチャ解像度 %)
 *  - prefer JPEG when alpha is unused (Face skin is usually opaque)
 *  - PNG only when alpha is actually needed
 *
 * @param {THREE.Texture} tex
 * @param {{ maxSide?: number, textureScale?: number, quality?: number }} [opts]
 */
export async function lipTextureToPngBytes(tex, opts = {}) {
    if (!tex) return null;
    try {
        const img = tex.image || (tex.source && tex.source.data);
        if (!img) return null;
        // Always snapshot onto a private canvas (never encode the live bake canvas).
        const srcW = img.width || img.videoWidth || 0;
        const srcH = img.height || img.videoHeight || 0;
        if (!srcW || !srcH) return null;

        let scale = opts.textureScale != null ? Number(opts.textureScale) : 1;
        if (!(scale > 0) || scale > 1) scale = 1;
        let maxSide = opts.maxSide != null ? Number(opts.maxSide) : 0;
        if (!(maxSide > 0)) {
            // Default cap: 2048 keeps lips sharp enough, cuts 4096² PNG bloat hard.
            maxSide = Math.round(4096 * scale);
            if (maxSide > 2048 && scale >= 0.999) maxSide = 2048;
            if (maxSide < 256) maxSide = 256;
        }
        let w = Math.max(1, Math.round(srcW * scale));
        let h = Math.max(1, Math.round(srcH * scale));
        const long = Math.max(w, h);
        if (long > maxSide) {
            const s = maxSide / long;
            w = Math.max(1, Math.round(w * s));
            h = Math.max(1, Math.round(h * s));
        }

        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        try {
            ctx.drawImage(img, 0, 0, w, h);
        } catch (eDraw) {
            console.warn("[export][glb-patch] lip canvas snapshot drawImage failed", eDraw);
            return null;
        }

        // Detect whether alpha is actually used. Opaque Face skin → JPEG is safe
        // and typically 3–10× smaller than PNG at the same resolution.
        let needsAlpha = false;
        try {
            const sample = ctx.getImageData(0, 0, w, h).data;
            // Stride sample — full scan is fine for ≤2048² but keep it light.
            const step = Math.max(1, Math.floor(sample.length / 4 / 4096));
            for (let i = 3; i < sample.length; i += 4 * step) {
                if (sample[i] < 250) { needsAlpha = true; break; }
            }
        } catch (eA) {
            needsAlpha = true; // CORS / tainted → stay on PNG
        }

        const q = opts.quality != null ? Number(opts.quality) : 0.85;
        async function tryEncode(mime, quality) {
            const blob = await new Promise((resolve) => {
                try { canvas.toBlob(resolve, mime, quality); }
                catch (e) { resolve(null); }
            });
            if (!blob || blob.size < 64) return null;
            const ab = await blob.arrayBuffer();
            const u8 = new Uint8Array(ab);
            u8.mimeType = mime;
            return u8;
        }

        let out = null;
        if (!needsAlpha) {
            // Dedicated Face_LipPaint image (only Face_SKIN references it).
            // JPEG here does NOT touch the shared eye atlas — that was the old
            // black-eye correlation when JPEG was applied to hybrid/shared paths.
            out = await tryEncode("image/jpeg", q);
            if (!out) out = await tryEncode("image/webp", q);
        }
        if (!out) out = await tryEncode("image/png", undefined);
        if (!out) out = await tryEncode("image/webp", q);
        if (!out) out = await tryEncode("image/jpeg", q);

        if (out) {
            console.warn("[export][glb-patch] lip encode", out.mimeType,
                "bytes=", out.byteLength,
                "canvas=", canvas.width + "x" + canvas.height,
                "src=", srcW + "x" + srcH,
                "needsAlpha=", needsAlpha,
                "scale=", scale, "maxSide=", maxSide);
        }
        return out;
    } catch (e) {
        console.warn("[export][glb-patch] textureToPngBytes failed", e);
        return null;
    }
}

/**
 * Post-export structural contracts (morpholith-export-status §55).
 * Logs violations; returns { ok, violations[] }. Does not throw.
 *
 * @param {ArrayBuffer|Uint8Array} glb
 * @param {{ expectLip?: boolean, bodyOnly?: boolean, label?: string }} [opts]
 * @returns {{ ok: boolean, violations: string[], info: object }}
 */
export function assertExportContracts(glb, opts = {}) {
    const violations = [];
    const info = {
        eyeImgs: [],
        faceImgs: [],
        shared: [],
        lipPresent: false,
        eyeIsoPresent: false,
        imagesKB: 0,
        matCount: 0
    };
    try {
        const { json, bin } = parseGlb(glb);
        if (!json || !bin) {
            violations.push("parseGlb failed");
            return { ok: false, violations, info };
        }
        const mats = json.materials || [];
        const texs = json.textures || [];
        const imgs = json.images || [];
        const bvs = json.bufferViews || [];
        const binArr = new Uint8Array(bin);
        info.matCount = mats.length;

        function isEyeName(name) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(normalizeMaterialName(name));
        }
        function isFaceSkinName(name) {
            const n = normalizeMaterialName(name);
            if (isEyeName(n)) return false;
            return /face.*skin|skin.*face|face_00_skin|n00_000_00_face_00_skin/i.test(n)
                || (n.indexOf("face") >= 0 && n.indexOf("skin") >= 0);
        }
        function imgIndicesForMat(mat, matIndex) {
            const out = new Set();
            function addTex(ti) {
                if (ti == null || !texs[ti] || texs[ti].source == null) return;
                out.add(texs[ti].source | 0);
            }
            try {
                const pbr = mat && mat.pbrMetallicRoughness;
                if (pbr && pbr.baseColorTexture) addTex(pbr.baseColorTexture.index);
            } catch (e) {}
            try {
                const mtoon = mat && mat.extensions && mat.extensions.VRMC_materials_mtoon;
                if (mtoon && mtoon.shadeMultiplyTexture) addTex(mtoon.shadeMultiplyTexture.index);
            } catch (e) {}
            try {
                const props = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties
                    && json.extensions.VRM.materialProperties[matIndex];
                const tp = props && props.textureProperties;
                if (tp) {
                    if (tp._MainTex != null) addTex(tp._MainTex | 0);
                    if (tp._ShadeTexture != null) addTex(tp._ShadeTexture | 0);
                }
            } catch (e) {}
            return out;
        }

        const eyeImgs = new Set();
        const faceImgs = new Set();
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat) continue;
            const nm = mat.name || "";
            const imgsSet = imgIndicesForMat(mat, i);
            if (isEyeName(nm)) {
                imgsSet.forEach(x => eyeImgs.add(x));
            }
            // Only Face_SKIN for share check — FaceMouth may still share the
            // original atlas with eyes after lip (that is normal and OK).
            if (isFaceSkinName(nm)) {
                imgsSet.forEach(x => faceImgs.add(x));
            }
        }
        info.eyeImgs = [...eyeImgs];
        info.faceImgs = [...faceImgs];
        const shared = [...eyeImgs].filter(i => faceImgs.has(i));
        info.shared = shared;

        let imgBytes = 0;
        for (let i = 0; i < imgs.length; i++) {
            const img = imgs[i];
            if (!img) continue;
            if (/Face_LipPaint|LipPaint/i.test(img.name || "")) info.lipPresent = true;
            if (/__eye_iso|Eye_Isolated/i.test(img.name || "")) info.eyeIsoPresent = true;
            if (img.bufferView != null && bvs[img.bufferView]) {
                imgBytes += bvs[img.bufferView].byteLength || 0;
            }
        }
        info.imagesKB = Math.round(imgBytes / 1024);

        // Eye images must be large enough and have valid magic
        for (const ii of eyeImgs) {
            const img = imgs[ii];
            if (!img || img.bufferView == null) {
                violations.push("eye img " + ii + " missing bufferView");
                continue;
            }
            const bv = bvs[img.bufferView];
            if (!bv) {
                violations.push("eye img " + ii + " bad bufferView");
                continue;
            }
            const off = bv.byteOffset || 0;
            const len = bv.byteLength || 0;
            if (len < 10000) {
                violations.push("eye img " + ii + " too small bytes=" + len);
            }
            if (off + len > binArr.byteLength) {
                violations.push("eye img " + ii + " OOB");
                continue;
            }
            const magicOk = len >= 8 && (
                (binArr[off] === 0x89 && binArr[off + 1] === 0x50) || // PNG
                (binArr[off] === 0xFF && binArr[off + 1] === 0xD8) || // JPEG
                (binArr[off + 0] === 0x52 && binArr[off + 1] === 0x49 && binArr[off + 8] === 0x57) // RIFF/WEBP rough
            );
            if (!magicOk) {
                violations.push("eye img " + ii + " bad magic len=" + len);
            }
        }

        // After lip (explicit or detected): eyes must NOT share with Face_SKIN
        if (opts.expectLip || info.lipPresent) {
            if (shared.length > 0) {
                violations.push("after lip, eye↔Face_SKIN still share img " + shared.join(","));
            }
            if (!info.lipPresent && opts.expectLip) {
                violations.push("expectLip but no Face_LipPaint image");
            }
        }

        // Body-only: must not embed lip paint image
        if (opts.bodyOnly) {
            if (info.lipPresent) {
                violations.push("bodyOnly but Face_LipPaint present");
            }
        }
        // Note: eye_iso is zero-copy (shared bufferView) — no size bloat check needed

        // Material count sanity (VRoid-ish models usually stay small)
        if (mats.length > 64) {
            violations.push("materials.length unusually high: " + mats.length);
        }

        const label = opts.label || "export";
        if (violations.length) {
            console.error("[export][contract] FAIL", label, violations.join(" | "),
                "eyeImgs=", info.eyeImgs, "faceImgs=", info.faceImgs,
                "shared=", info.shared, "imagesKB=", info.imagesKB);
        } else {
            console.warn("[export][contract] ok", label,
                "eyeImgs=", info.eyeImgs.join(",") || "-",
                "faceImgs=", info.faceImgs.join(",") || "-",
                "shared=", info.shared.length ? info.shared.join(",") : "none",
                "lip=", info.lipPresent, "eyeIso=", info.eyeIsoPresent,
                "imagesKB=", info.imagesKB, "mats=", info.matCount);
        }
        return { ok: violations.length === 0, violations, info };
    } catch (e) {
        violations.push(String(e && e.message || e));
        console.error("[export][contract] exception", e);
        return { ok: false, violations, info };
    }
}

/**
 * Deep diagnostic for eye/face texture health in a GLB.
 * Does NOT mutate. Logs a structured report so black-eye root cause can be
 * identified without guessing (magic, IHDR size, mime, bufferView, mat slots).
 *
 * @param {ArrayBuffer|Uint8Array} glb
 * @param {string} [label]
 * @returns {object} report stored also on window.__morpholithEyeDiag if available
 */
export function diagnoseGlbEyeState(glb, label = "glb") {
    const report = {
        label,
        ts: Date.now(),
        ok: true,
        reasons: [],
        materials: [],
        images: [],
        summary: ""
    };
    try {
        const { json, bin } = parseGlb(glb);
        if (!json || !bin) {
            report.ok = false;
            report.reasons.push("parseGlb failed");
            console.error("[eye-diag]", label, "parse failed");
            return report;
        }
        const mats = json.materials || [];
        const texs = json.textures || [];
        const imgs = json.images || [];
        const bvs = json.bufferViews || [];
        const binArr = new Uint8Array(bin);

        function isEyeName(name) {
            return /eye|iris|highlight|pupil|瞳|目/i.test(normalizeMaterialName(name));
        }
        function isFaceSkinName(name) {
            const n = normalizeMaterialName(name);
            if (isEyeName(n)) return false;
            return /face.*skin|skin.*face|face_00_skin|n00_000_00_face_00_skin/i.test(n)
                || (n.indexOf("face") >= 0 && n.indexOf("skin") >= 0);
        }
        function isFaceMouthName(name) {
            return /facemouth|face_00_face|face.*mouth/i.test(normalizeMaterialName(name));
        }
        function readPngIhdr(off, len) {
            // PNG: 8 magic + 4 len + 4 "IHDR" + 4 width + 4 height
            if (len < 24) return null;
            if (!(binArr[off] === 0x89 && binArr[off + 1] === 0x50)) return null;
            // IHDR type at offset 12
            if (binArr[off + 12] !== 0x49 || binArr[off + 13] !== 0x48) return null;
            const w = (binArr[off + 16] << 24) | (binArr[off + 17] << 16)
                | (binArr[off + 18] << 8) | binArr[off + 19];
            const h = (binArr[off + 20] << 24) | (binArr[off + 21] << 16)
                | (binArr[off + 22] << 8) | binArr[off + 23];
            const bitDepth = binArr[off + 24];
            const colorType = binArr[off + 25];
            return { w: w >>> 0, h: h >>> 0, bitDepth, colorType };
        }
        function magicOf(off, len) {
            if (len < 4) return "short";
            if (binArr[off] === 0x89 && binArr[off + 1] === 0x50) return "png";
            if (binArr[off] === 0xFF && binArr[off + 1] === 0xD8) return "jpeg";
            if (binArr[off] === 0x52 && binArr[off + 1] === 0x49
                && len > 12 && binArr[off + 8] === 0x57) return "webp";
            return "unknown(" + binArr[off].toString(16) + "," + binArr[off + 1].toString(16) + ")";
        }
        function headHex(off, len, n = 16) {
            const parts = [];
            for (let i = 0; i < Math.min(n, len); i++) {
                parts.push(binArr[off + i].toString(16).padStart(2, "0"));
            }
            return parts.join(" ");
        }
        function texSlots(mat, matIndex) {
            const slots = {};
            try {
                const pbr = mat && mat.pbrMetallicRoughness;
                if (pbr && pbr.baseColorTexture && pbr.baseColorTexture.index != null)
                    slots.pbrBase = pbr.baseColorTexture.index | 0;
                if (pbr && pbr.baseColorFactor)
                    slots.pbrFactor = Array.from(pbr.baseColorFactor);
            } catch (e) {}
            try {
                const mtoon = mat && mat.extensions && mat.extensions.VRMC_materials_mtoon;
                if (mtoon) {
                    if (mtoon.shadeMultiplyTexture && mtoon.shadeMultiplyTexture.index != null)
                        slots.mtoonShade = mtoon.shadeMultiplyTexture.index | 0;
                    if (mtoon.shadeColorFactor) slots.shadeFactor = Array.from(mtoon.shadeColorFactor);
                    if (mtoon.transparentWithZWrite != null)
                        slots.transparentWithZWrite = mtoon.transparentWithZWrite;
                }
            } catch (e) {}
            try {
                const props = json.extensions && json.extensions.VRM
                    && json.extensions.VRM.materialProperties
                    && json.extensions.VRM.materialProperties[matIndex];
                if (props && props.textureProperties) {
                    const tp = props.textureProperties;
                    if (tp._MainTex != null) slots.vrm0Main = tp._MainTex | 0;
                    if (tp._ShadeTexture != null) slots.vrm0Shade = tp._ShadeTexture | 0;
                }
                if (props && props.floatProperties) {
                    const fp = props.floatProperties;
                    if (fp._BlendMode != null) slots.blendMode = fp._BlendMode;
                    if (fp._Cutoff != null) slots.cutoff = fp._Cutoff;
                }
                if (props && props.vectorProperties && props.vectorProperties._Color)
                    slots.vrm0Color = Array.from(props.vectorProperties._Color);
            } catch (e) {}
            return slots;
        }
        function imgInfo(ii) {
            const img = imgs[ii];
            if (!img) return { idx: ii, missing: true };
            const row = {
                idx: ii,
                name: img.name || "",
                mime: img.mimeType || "",
                uri: img.uri ? String(img.uri).slice(0, 40) : null,
                bv: img.bufferView
            };
            if (img.bufferView == null || !bvs[img.bufferView]) {
                row.bad = "no-bufferView";
                report.ok = false;
                report.reasons.push("img" + ii + " no bufferView");
                return row;
            }
            const bv = bvs[img.bufferView];
            const off = bv.byteOffset || 0;
            const len = bv.byteLength || 0;
            row.off = off;
            row.len = len;
            if (off + len > binArr.byteLength) {
                row.bad = "OOB";
                report.ok = false;
                report.reasons.push("img" + ii + " OOB");
                return row;
            }
            row.magic = magicOf(off, len);
            row.head = headHex(off, len, 12);
            if (row.magic === "png") {
                const ihdr = readPngIhdr(off, len);
                if (ihdr) {
                    row.w = ihdr.w;
                    row.h = ihdr.h;
                    row.bitDepth = ihdr.bitDepth;
                    row.colorType = ihdr.colorType; // 2=RGB 6=RGBA
                    if (ihdr.w < 16 || ihdr.h < 16) {
                        row.bad = "tiny-ihdr";
                        report.ok = false;
                        report.reasons.push("img" + ii + " tiny " + ihdr.w + "x" + ihdr.h);
                    }
                } else {
                    row.bad = "png-no-ihdr";
                    report.ok = false;
                    report.reasons.push("img" + ii + " png without IHDR");
                }
            } else if (row.magic === "jpeg") {
                row.warn = "jpeg-no-alpha";
                // JPEG eyes historically correlated with black irises
                report.reasons.push("img" + ii + " is JPEG (no alpha) — suspect for black eyes");
            } else if (row.magic === "unknown" || row.magic.indexOf("unknown") === 0) {
                row.bad = "bad-magic";
                report.ok = false;
                report.reasons.push("img" + ii + " bad magic " + row.magic);
            }
            if (len < 1000) {
                row.bad = (row.bad || "") + "+tiny-bytes";
                report.ok = false;
                report.reasons.push("img" + ii + " only " + len + " bytes");
            }
            return row;
        }

        const eyeImgSet = new Set();
        const faceImgSet = new Set();
        const mouthImgSet = new Set();
        for (let i = 0; i < mats.length; i++) {
            const mat = mats[i];
            if (!mat) continue;
            const nm = mat.name || "";
            const slots = texSlots(mat, i);
            let role = isEyeName(nm) ? "eye"
                : isFaceSkinName(nm) ? "faceSkin"
                : isFaceMouthName(nm) ? "faceMouth"
                : /body.*skin|skin.*body|n00_000_00_body/i.test(normalizeMaterialName(nm))
                    ? "bodySkin"
                : /cloth|shoe|靴|服|hair|髪|n00_000_hair/i.test(normalizeMaterialName(nm))
                    ? "clothHair"
                : "other";
            // Also surface tinted materials (filter/solid) even if role was other
            const fac = (slots.pbrFactor || slots.vrm0Color || null);
            const tinted = fac && fac.length >= 3
                && (Math.abs(fac[0] - 1) > 0.02 || Math.abs(fac[1] - 1) > 0.02
                    || Math.abs(fac[2] - 1) > 0.02);
            if (role === "other" && tinted) role = "tinted";
            if (role === "other") continue;
            const matRow = {
                idx: i,
                name: nm,
                role,
                slots,
                imgIdxs: []
            };
            ["pbrBase", "mtoonShade", "vrm0Main", "vrm0Shade"].forEach(k => {
                if (slots[k] != null && texs[slots[k]] && texs[slots[k]].source != null) {
                    const ii = texs[slots[k]].source | 0;
                    matRow.imgIdxs.push({ slot: k, tex: slots[k], img: ii });
                    if (role === "eye") eyeImgSet.add(ii);
                    if (role === "faceSkin") faceImgSet.add(ii);
                    if (role === "faceMouth") mouthImgSet.add(ii);
                }
            });
            // Body/clothes/hair with no main texture → pure black on reload
            if ((role === "bodySkin" || role === "clothHair")
                && slots.pbrBase == null && slots.vrm0Main == null) {
                matRow.warn = (matRow.warn || "") + "no-main-tex;";
                report.reasons.push(nm + " BODY/CLOTH has NO main texture (will render pure black)");
                report.ok = false;
            }
            // Flag suspicious color factors (near-black)
            if (slots.pbrFactor) {
                const f = slots.pbrFactor;
                if (f[0] < 0.05 && f[1] < 0.05 && f[2] < 0.05) {
                    matRow.warn = (matRow.warn || "") + "pbrFactor-near-black;";
                    report.reasons.push(nm + " pbrFactor near black " + JSON.stringify(f));
                    report.ok = false;
                }
            }
            if (slots.vrm0Color) {
                const f = slots.vrm0Color;
                if (f[0] < 0.05 && f[1] < 0.05 && f[2] < 0.05) {
                    matRow.warn = (matRow.warn || "") + "vrm0Color-near-black;";
                    report.reasons.push(nm + " vrm0Color near black");
                    report.ok = false;
                }
            }
            // blendMode: 0=Opaque 1=Cutout 2=Transparent 3=TransparentWithZWrite (VRM0)
            // Eyes on Transparent after isolate/lip have been correlated with black
            // irises in some loaders — flag clearly for next-step decisions.
            if (role === "eye" && slots.blendMode != null) {
                matRow.blendMode = slots.blendMode;
                if (slots.blendMode === 2 || slots.blendMode === 3) {
                    matRow.warn = (matRow.warn || "") + "eye-blendMode-" + slots.blendMode + ";";
                    report.reasons.push(nm + " blendMode=" + slots.blendMode
                        + " (Transparent) cutoff=" + (slots.cutoff != null ? slots.cutoff : "?"));
                }
            }
            report.materials.push(matRow);
        }

        const allImgIdx = new Set([...eyeImgSet, ...faceImgSet, ...mouthImgSet]);
        // Always include __eye_iso / LipPaint by name even if not referenced
        for (let i = 0; i < imgs.length; i++) {
            const n = (imgs[i] && imgs[i].name) || "";
            if (/__eye_iso|Eye_Isolated|LipPaint|Face_LipPaint/i.test(n)) allImgIdx.add(i);
        }
        for (const ii of allImgIdx) {
            report.images.push(imgInfo(ii));
        }

        const sharedEyeFace = [...eyeImgSet].filter(i => faceImgSet.has(i));
        const sharedEyeMouth = [...eyeImgSet].filter(i => mouthImgSet.has(i));
        report.eyeImgs = [...eyeImgSet];
        report.faceImgs = [...faceImgSet];
        report.mouthImgs = [...mouthImgSet];
        report.sharedEyeFace = sharedEyeFace;
        report.sharedEyeMouth = sharedEyeMouth;
        if (sharedEyeFace.length) {
            report.reasons.push("Eye↔Face_SKIN share img " + sharedEyeFace.join(","));
        }

        report.summary = [
            "eyeImgs=" + (report.eyeImgs.join(",") || "-"),
            "face=" + (report.faceImgs.join(",") || "-"),
            "mouth=" + (report.mouthImgs.join(",") || "-"),
            "shareEF=" + (sharedEyeFace.length ? sharedEyeFace.join(",") : "none"),
            "shareEM=" + (sharedEyeMouth.length ? sharedEyeMouth.join(",") : "none"),
            "imgs=" + report.images.map(r => {
                const sz = (r.w && r.h) ? (r.w + "x" + r.h) : "?";
                return r.idx + ":" + (r.magic || "?") + "/" + sz + "/" + (r.len || 0) + "b"
                    + (r.bad ? "!" + r.bad : "");
            }).join(" ")
        ].join(" | ");

        const level = report.ok && report.reasons.length === 0 ? "warn" : "error";
        console[level === "error" ? "error" : "warn"](
            "[eye-diag]", label,
            report.ok ? "PASS" : "FAIL",
            report.summary,
            report.reasons.length ? ("reasons=" + report.reasons.join(" || ")) : ""
        );
        // Per-image detail lines (easy to grep)
        report.images.forEach(r => {
            console.warn("[eye-diag][img]", label,
                "i=" + r.idx,
                "name=" + (r.name || "").slice(0, 40),
                "magic=" + r.magic,
                "mime=" + r.mime,
                "len=" + r.len,
                r.w ? ("wh=" + r.w + "x" + r.h) : "",
                r.colorType != null ? ("ct=" + r.colorType) : "",
                r.bad || r.warn || "",
                "head=" + (r.head || "")
            );
        });
        report.materials.forEach(m => {
            if (m.role === "other") return;
            console.warn("[eye-diag][mat]", label,
                "i=" + m.idx, m.role, (m.name || "").slice(0, 48),
                "slots=" + JSON.stringify(m.slots),
                "imgs=" + JSON.stringify(m.imgIdxs),
                m.warn || ""
            );
        });
    } catch (e) {
        report.ok = false;
        report.reasons.push(String(e && e.message || e));
        console.error("[eye-diag]", label, "exception", e);
    }
    try {
        if (typeof window !== "undefined") {
            if (!window.__morpholithEyeDiag) window.__morpholithEyeDiag = {};
            window.__morpholithEyeDiag[label] = report;
            window.__morpholithEyeDiag._last = report;
        }
    } catch (e) {}
    return report;
}

export { lipTextureToPngBytes as textureToPngBytes };
