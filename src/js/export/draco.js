/**
 * Morpholith export — KHR_draco_mesh_compression encode + unused bufferView prune.
 */
import { align4, ComponentFunc, ItemSize } from "./constants.js";
import { addAccessor, addBufferView } from "./core.js";
import { DEFAULT_EXPORT_OPTIONS } from "./options.js";

/** @type {Promise<object>|null} */
let _dracoEncoderPromise = null;

export function loadDracoEncoderModule() {
    if (_dracoEncoderPromise) return _dracoEncoderPromise;

    const CDN_URLS = [
        "https://www.gstatic.com/draco/versioned/encoders/1.5.7/draco_encoder.js",
        "https://cdn.jsdelivr.net/gh/google/draco@1.5.7/javascript/draco_encoder.js",
        "https://www.gstatic.com/draco/v1/encoders/draco_encoder.js",
    ];

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = src;
            s.async = true;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error(src + " failed to load"));
            document.head.appendChild(s);
        });
    }

    _dracoEncoderPromise = (async () => {
        if (typeof DracoEncoderModule !== "function") {
            let lastErr;
            for (const url of CDN_URLS) {
                try {
                    await loadScript(url);
                    if (typeof DracoEncoderModule === "function") break;
                } catch (e) {
                    lastErr = e;
                    console.warn("[export] draco encoder script load failed", url, e);
                }
            }
            if (typeof DracoEncoderModule !== "function") {
                throw lastErr || new Error("Draco encoder module unavailable");
            }
        }
        const enc = await DracoEncoderModule({});
        if (!enc || !enc.Encoder) throw new Error("Draco encoder module unavailable");
        return enc;
    })();

    return _dracoEncoderPromise;
}

/**
 * Read typed array bytes for an accessor index from state buffers.
 */
export function readAccessorArray(state, accessorIndex) {
    const acc = state.accessors[accessorIndex];
    if (!acc || acc.bufferView == null) return null;
    const bv = state.bufferViews[acc.bufferView];
    const buf = state.buffers[bv.buffer != null ? bv.buffer : 0];
    // Our exporter stores one ArrayBuffer-like per bufferView push order:
    // state.buffers[i] aligns with bufferViews[i] (see addBufferView).
    const data = state.buffers[acc.bufferView];
    if (!data) return null;
    const Ctor = ComponentFunc[acc.componentType];
    if (!Ctor) return null;
    const itemSize = ItemSize[acc.type] || 1;
    const offset = (acc.byteOffset || 0);
    // data may be TypedArray already
    const byteOffset = (data.byteOffset || 0) + offset;
    const byteLength = acc.count * itemSize * Ctor.BYTES_PER_ELEMENT;
    return new Ctor(data.buffer || data, byteOffset, acc.count * itemSize);
}

/**
 * Apply KHR_draco_mesh_compression to all mesh primitives that have positions.
 * Morph-target primitives keep uncompressed attributes (Draco + morph is fragile).
 */
export async function applyDracoCompression(state) {
    const opts = state.exportOptions || DEFAULT_EXPORT_OPTIONS;
    if (!opts.draco) return;
    let encoderModule;
    try {
        encoderModule = await loadDracoEncoderModule();
    } catch (e) {
        console.warn("[export] Draco encoder unavailable — skipping", e && e.message);
        return;
    }

    const encodeSpeed = Math.max(0, Math.min(10, opts.dracoEncodeSpeed != null ? opts.dracoEncodeSpeed : 5));
    let compressed = 0;
    let skippedMorph = 0, skippedSkin = 0, skippedNoPos = 0, reused = 0;
    // POSITION accessor index → already-built KHR_draco_mesh_compression extension.
    // Multiple primitives (main + outline) often share the same accessors; compress once
    // and reuse the extension so we don't strip bufferViews twice / re-encode garbage.
    const dracoByPosAccessor = new Map();

    console.warn("[export][draco] start, meshes=", state.meshes.length, "encodeSpeed=", encodeSpeed);

    for (const mesh of state.meshes) {
        if (!mesh || !mesh.primitives) continue;
        // Skip meshes that use morph targets — attribute order must stay stable
        if (mesh.extras && mesh.extras.targetNames && mesh.extras.targetNames.length) {
            skippedMorph++;
            console.warn("[export][draco] skip morph mesh:", mesh.name, "targets=", mesh.extras.targetNames.length);
            continue;
        }

        // Multi-primitive meshes often share the *same attributes object reference*
        // (makeMesh2: primitive.attributes = attributes) and the same accessor
        // indices, but each has a different index buffer (material groups /
        // outline). Draco packs faces+attrs together, so each prim needs its
        // own attributes dict AND its own accessor copies.
        if (mesh.primitives.length > 1) {
            // 1) Own attributes object per prim (avoid mutating siblings)
            for (let pi = 0; pi < mesh.primitives.length; pi++) {
                const prim = mesh.primitives[pi];
                if (!prim || !prim.attributes) continue;
                prim.attributes = Object.assign({}, prim.attributes);
            }
            // 2) Clone shared accessors for every prim after the first owner
            const seen = new Map(); // oldAccIdx → first prim index
            for (let pi = 0; pi < mesh.primitives.length; pi++) {
                const prim = mesh.primitives[pi];
                if (!prim || !prim.attributes) continue;
                for (const key of Object.keys(prim.attributes)) {
                    const oldIdx = prim.attributes[key];
                    if (oldIdx == null) continue;
                    if (!seen.has(oldIdx)) {
                        seen.set(oldIdx, pi);
                        continue;
                    }
                    if (seen.get(oldIdx) === pi) continue;
                    const oldAcc = state.accessors[oldIdx];
                    if (!oldAcc || oldAcc.bufferView == null) continue;
                    const arr = readAccessorArray(state, oldIdx);
                    if (!arr) continue;
                    const copy = new arr.constructor(arr);
                    const newIdx = addAccessor(
                        state, copy,
                        oldAcc.type,
                        (oldAcc.name || key) + "_p" + pi,
                        false,
                        !!oldAcc.normalized
                    );
                    const newAcc = state.accessors[newIdx];
                    if (newAcc && oldAcc.componentType != null) {
                        newAcc.componentType = oldAcc.componentType;
                        newAcc.normalized = !!oldAcc.normalized;
                    }
                    prim.attributes[key] = newIdx;
                }
            }
        }

        for (const prim of mesh.primitives) {
            if (!prim || !prim.attributes || prim.attributes.POSITION == null) {
                skippedNoPos++;
                continue;
            }
            if (prim.targets && prim.targets.length) {
                skippedMorph++;
                console.warn("[export][draco] skip morph prim:", mesh.name);
                continue;
            }
            // Log attribute types / material for diagnosis (esp. hair / MToon)
            try {
                const attrInfo = {};
                for (const k of Object.keys(prim.attributes)) {
                    const acc = state.accessors[prim.attributes[k]];
                    if (acc) attrInfo[k] = { type: acc.type, ct: acc.componentType, norm: !!acc.normalized, count: acc.count };
                }
                let matInfo = null;
                if (prim.material != null && state.materials[prim.material]) {
                    const mat = state.materials[prim.material];
                    const mtoon = (mat.extensions && (mat.extensions.VRMC_materials_mtoon || mat.extensions.VRM)) || null;
                    matInfo = {
                        name: mat.name,
                        doubleSided: !!mat.doubleSided,
                        alphaMode: mat.alphaMode,
                        hasMToon: !!mtoon,
                        shadeColor: mtoon && mtoon.shadeColorFactor,
                        shadingToony: mtoon && mtoon.shadingToonyFactor,
                        shadingShift: mtoon && mtoon.shadingShiftFactor,
                    };
                }
                console.warn("[export][draco] compress candidate:", mesh.name, "attrs=", JSON.stringify(attrInfo), "mat=", JSON.stringify(matInfo));
            } catch (logE) { /* ignore log errors */ }

            // Reuse Draco payload if another primitive already compressed the same POSITION accessor
            const posAccIdx = prim.attributes.POSITION;
            if (dracoByPosAccessor.has(posAccIdx)) {
                const prev = dracoByPosAccessor.get(posAccIdx);
                if (!prim.extensions) prim.extensions = {};
                prim.extensions.KHR_draco_mesh_compression = {
                    bufferView: prev.bufferView,
                    attributes: Object.assign({}, prev.attributes)
                };
                // Align this prim's attribute indices to the ones that were stripped/updated
                if (prev.attrIndexMap) {
                    for (const k of Object.keys(prev.attrIndexMap)) {
                        if (prim.attributes[k] != null) prim.attributes[k] = prev.attrIndexMap[k];
                    }
                }
                if (prev.indices != null && prim.indices != null) prim.indices = prev.indices;
                reused++;
                console.warn("[export][draco] reuse for", mesh.name, "mat=", prim.material);
                continue;
            }

            try {
                const meshBuilder = new encoderModule.MeshBuilder();
                const dracoMesh = new encoderModule.Mesh();
                // Encoder is created after the mesh is filled (ExpertEncoder needs the mesh).
                let encoder = null;
                let useExpert = false;

                const posArr = readAccessorArray(state, prim.attributes.POSITION);
                if (!posArr || !posArr.length) {
                    encoderModule.destroy(dracoMesh);
                    encoderModule.destroy(meshBuilder);
                    continue;
                }
                const numVerts = (posArr.length / 3) | 0;

                let indexArr = null;
                if (prim.indices != null) {
                    indexArr = readAccessorArray(state, prim.indices);
                }
                if (indexArr && indexArr.length) {
                    meshBuilder.AddFacesToMesh(dracoMesh, (indexArr.length / 3) | 0, indexArr);
                } else {
                    // Non-indexed: sequential triangles
                    const faces = new Uint32Array(numVerts);
                    for (let i = 0; i < numVerts; i++) faces[i] = i;
                    meshBuilder.AddFacesToMesh(dracoMesh, (numVerts / 3) | 0, faces);
                }

                const attrMap = {}; // glTF attr name → draco unique id

                // Always feed float32 to AddFloatAttributeToMesh.
                // Our exporter often stores NORMAL as normalized INT16 and
                // TEXCOORD as normalized UINT16; passing those typed arrays
                // directly produces garbage (→ black shading / wrong UVs).
                // De-quantize when the accessor is a normalized integer type.
                const toFloat32 = (accessorIndex, expectedComps) => {
                    const acc = state.accessors[accessorIndex];
                    if (!acc) return null;
                    const arr = readAccessorArray(state, accessorIndex);
                    if (!arr || !arr.length) return null;
                    const comps = ItemSize[acc.type] || expectedComps || 1;
                    if (arr.length < numVerts * comps) return null;
                    if (arr instanceof Float32Array && !acc.normalized) {
                        // already float in [raw] range
                        return arr.length === numVerts * comps ? arr : arr.subarray(0, numVerts * comps);
                    }
                    const out = new Float32Array(numVerts * comps);
                    const normalized = !!acc.normalized;
                    const ct = acc.componentType;
                    // De-quantize common glTF normalized integer encodings
                    for (let i = 0; i < numVerts * comps; i++) {
                        let v = arr[i];
                        if (normalized) {
                            if (ct === 5120) { // BYTE
                                v = Math.max(v / 127, -1);
                            } else if (ct === 5121) { // UNSIGNED_BYTE
                                v = v / 255;
                            } else if (ct === 5122) { // SHORT
                                v = Math.max(v / 32767, -1);
                            } else if (ct === 5123) { // UNSIGNED_SHORT
                                v = v / 65535;
                            }
                        } else {
                            // non-normalized integer → just cast
                            v = +v;
                        }
                        out[i] = v;
                    }
                    return out;
                };

                const posId = meshBuilder.AddFloatAttributeToMesh(
                    dracoMesh, encoderModule.POSITION, numVerts, 3, posArr);
                attrMap.POSITION = posId;

                // Attrs that should keep original integer componentType after encode
                const keepIntType = {}; // gltfName → componentType

                const addAttr = (gltfName, dracoType, comps) => {
                    if (prim.attributes[gltfName] == null) return;
                    const acc = state.accessors[prim.attributes[gltfName]];
                    const arr = readAccessorArray(state, prim.attributes[gltfName]);
                    if (!acc || !arr) return;
                    const ct = acc.componentType;
                    let id = -1;
                    // Native integer paths: avoid de-quantize (MToon hair is
                    // sensitive to even small normal bit changes).
                    if (ct === 5122 && typeof meshBuilder.AddInt16Attribute === "function") {
                        id = meshBuilder.AddInt16Attribute(dracoMesh, dracoType, numVerts, comps, arr);
                        if (id >= 0) keepIntType[gltfName] = 5122;
                    } else if (ct === 5123 && typeof meshBuilder.AddUInt16Attribute === "function") {
                        id = meshBuilder.AddUInt16Attribute(dracoMesh, dracoType, numVerts, comps, arr);
                        if (id >= 0) keepIntType[gltfName] = 5123;
                    } else if (ct === 5121 && typeof meshBuilder.AddUInt8Attribute === "function") {
                        id = meshBuilder.AddUInt8Attribute(dracoMesh, dracoType, numVerts, comps, arr);
                        if (id >= 0) keepIntType[gltfName] = 5121;
                    } else if (ct === 5120 && typeof meshBuilder.AddInt8Attribute === "function") {
                        id = meshBuilder.AddInt8Attribute(dracoMesh, dracoType, numVerts, comps, arr);
                        if (id >= 0) keepIntType[gltfName] = 5120;
                    }
                    if (id < 0) {
                        const farr = toFloat32(prim.attributes[gltfName], comps);
                        if (!farr) return;
                        id = meshBuilder.AddFloatAttributeToMesh(
                            dracoMesh, dracoType, numVerts, comps, farr);
                    }
                    if (id < 0) {
                        console.warn("[export] Draco AddAttribute failed for", gltfName);
                        return;
                    }
                    attrMap[gltfName] = id;
                };
                addAttr("NORMAL", encoderModule.NORMAL, 3);
                addAttr("TEXCOORD_0", encoderModule.TEX_COORD, 2);
                addAttr("TEXCOORD_1", encoderModule.TEX_COORD, 2);
                addAttr("COLOR_0", encoderModule.COLOR, 3);

                // JOINTS_0: must stay exact integers. Use typed integer attribute
                // (not float + low GENERIC quant) so bone indices survive.
                const jointsAreInt = { keepType: false, componentType: 5126 };
                if (prim.attributes.JOINTS_0 != null) {
                    const jAcc = state.accessors[prim.attributes.JOINTS_0];
                    const jArr = readAccessorArray(state, prim.attributes.JOINTS_0);
                    if (jArr && jAcc) {
                        const ct = jAcc.componentType;
                        let id = -1;
                        if (ct === 5121 && typeof meshBuilder.AddUInt8Attribute === "function") {
                            id = meshBuilder.AddUInt8Attribute(dracoMesh, encoderModule.GENERIC, numVerts, 4, jArr);
                        } else if (ct === 5123 && typeof meshBuilder.AddUInt16Attribute === "function") {
                            id = meshBuilder.AddUInt16Attribute(dracoMesh, encoderModule.GENERIC, numVerts, 4, jArr);
                        } else if (typeof meshBuilder.AddUInt16Attribute === "function") {
                            const u16 = jArr instanceof Uint16Array ? jArr : Uint16Array.from(jArr);
                            id = meshBuilder.AddUInt16Attribute(dracoMesh, encoderModule.GENERIC, numVerts, 4, u16);
                            jointsAreInt.componentType = 5123;
                        } else {
                            const f = new Float32Array(jArr.length);
                            for (let i = 0; i < jArr.length; i++) f[i] = jArr[i];
                            id = meshBuilder.AddFloatAttributeToMesh(dracoMesh, encoderModule.GENERIC, numVerts, 4, f);
                        }
                        if (id >= 0) {
                            attrMap.JOINTS_0 = id;
                            jointsAreInt.keepType = true;
                            if (ct === 5121 || ct === 5123) jointsAreInt.componentType = ct;
                        }
                    }
                }
                if (prim.attributes.WEIGHTS_0 != null) {
                    const farr = toFloat32(prim.attributes.WEIGHTS_0, 4);
                    if (farr) {
                        attrMap.WEIGHTS_0 = meshBuilder.AddFloatAttributeToMesh(
                            dracoMesh, encoderModule.GENERIC, numVerts, 4, farr);
                    }
                }

                // Prefer ExpertEncoder so we can disable vertex deduplication.
                // Dedup changes vertex count/order and breaks 1:1 attribute alignment
                // (hair geometry holes, mismatched NORMAL, etc.).
                if (typeof encoderModule.ExpertEncoder === "function") {
                    encoder = new encoderModule.ExpertEncoder(dracoMesh);
                    useExpert = true;
                } else {
                    encoder = new encoderModule.Encoder();
                }

                encoder.SetSpeedOptions(encodeSpeed, encodeSpeed);
                // Quantization: per attribute-id on ExpertEncoder, per type on Encoder.
                // Integer attrs (NORMAL INT16, UV UINT16, JOINTS) use full bit depth
                // so values are not re-quantized away from the source.
                if (useExpert) {
                    for (const [name, id] of Object.entries(attrMap)) {
                        if (id == null || id < 0) continue;
                        let bits = 14;
                        if (name === "NORMAL" || keepIntType[name] === 5122) bits = 16;
                        else if (name === "TEXCOORD_0" || name === "TEXCOORD_1" || keepIntType[name] === 5123) bits = 16;
                        else if (name === "JOINTS_0") bits = 8;
                        else if (name === "WEIGHTS_0") bits = 16;
                        else if (name === "POSITION") bits = 14;
                        try { encoder.SetAttributeQuantization(id, bits); } catch (e) {}
                    }
                } else {
                    encoder.SetAttributeQuantization(encoderModule.POSITION, 14);
                    encoder.SetAttributeQuantization(encoderModule.NORMAL, 14);
                    encoder.SetAttributeQuantization(encoderModule.TEX_COORD, 12);
                    encoder.SetAttributeQuantization(encoderModule.COLOR, 10);
                    encoder.SetAttributeQuantization(encoderModule.GENERIC, 10);
                }
                try {
                    if (typeof encoder.SetTrackEncodedProperties === "function") {
                        encoder.SetTrackEncodedProperties(true);
                    }
                } catch (e) {}
                try {
                    encoder.SetEncodingMethod(encoderModule.MESH_SEQUENTIAL_ENCODING);
                } catch (e) {
                    try {
                        encoder.SetEncodingMethod(encoderModule.MESH_EDGEBREAKER_ENCODING);
                    } catch (e2) {}
                }

                const encodedPtr = new encoderModule.DracoInt8Array();
                let encodedLen = 0;
                if (useExpert && typeof encoder.EncodeToDracoBuffer === "function") {
                    // false = do NOT deduplicate vertices (preserve count & order)
                    encodedLen = encoder.EncodeToDracoBuffer(false, encodedPtr);
                } else {
                    encodedLen = encoder.EncodeMeshToDracoBuffer(dracoMesh, encodedPtr);
                }
                if (encodedLen <= 0) {
                    console.warn("[export] Draco encode returned 0 for", mesh.name);
                    encoderModule.destroy(encodedPtr);
                    encoderModule.destroy(dracoMesh);
                    encoderModule.destroy(meshBuilder);
                    encoderModule.destroy(encoder);
                    continue;
                }
                const encoded = new Uint8Array(encodedLen);
                for (let i = 0; i < encodedLen; i++) encoded[i] = encodedPtr.GetValue(i);

                // EdgeBreaker (and some sequential paths) may reorder / deduplicate
                // vertices. Accessor counts MUST match the decoded geometry or
                // loaders produce incomplete / zeroed attributes (black mesh).
                let numEncodedVerts = numVerts;
                let numEncodedFaces = indexArr ? (indexArr.length / 3) | 0 : (numVerts / 3) | 0;
                try {
                    if (typeof encoder.GetNumberOfEncodedPoints === "function") {
                        numEncodedVerts = encoder.GetNumberOfEncodedPoints() | 0;
                    }
                    if (typeof encoder.GetNumberOfEncodedFaces === "function") {
                        numEncodedFaces = encoder.GetNumberOfEncodedFaces() | 0;
                    }
                } catch (e) { /* older encoder builds */ }

                const bvIndex = addBufferView(state, encoded, "Draco:" + (mesh.name || "mesh"));
                if (!prim.extensions) prim.extensions = {};
                prim.extensions.KHR_draco_mesh_compression = {
                    bufferView: bvIndex,
                    attributes: attrMap
                };

                // Strip bufferView from compressed accessors (data lives in Draco)
                // and rewrite counts to the post-encode vertex / index counts.
                // Most attrs are encoded as float → force FLOAT. JOINTS_0 kept
                // as original integer type when we used AddUInt8/16Attribute.
                // Attributes not added to the Draco mesh are dropped.
                const stripAndUpdate = (ai, newCount, forceFloat, keepMinMax, forceComponentType) => {
                    if (ai == null) return;
                    const acc = state.accessors[ai];
                    if (acc) {
                        delete acc.bufferView;
                        delete acc.byteOffset;
                        if (newCount != null && newCount > 0) {
                            acc.count = newCount;
                        }
                        if (!keepMinMax) {
                            delete acc.min;
                            delete acc.max;
                        }
                        if (forceComponentType != null) {
                            acc.componentType = forceComponentType;
                            acc.normalized = false;
                        } else if (forceFloat) {
                            acc.componentType = 5126; // FLOAT
                            acc.normalized = false;
                        }
                    }
                };
                stripAndUpdate(prim.indices, numEncodedFaces * 3, false, false, null);
                for (const k of Object.keys(prim.attributes)) {
                    if (attrMap[k] == null) {
                        const acc = state.accessors[prim.attributes[k]];
                        if (acc && numEncodedVerts > 0 && numEncodedVerts !== numVerts) {
                            delete prim.attributes[k];
                        }
                        continue;
                    } else if (k === "JOINTS_0" && jointsAreInt.keepType) {
                        stripAndUpdate(prim.attributes[k], numEncodedVerts, false, false, jointsAreInt.componentType);
                    } else if (keepIntType[k] != null) {
                        // Keep INT16/UINT16 + normalized so decode matches non-Draco
                        stripAndUpdate(prim.attributes[k], numEncodedVerts, false, k === "POSITION", keepIntType[k]);
                        const acc = state.accessors[prim.attributes[k]];
                        if (acc) acc.normalized = true;
                    } else {
                        stripAndUpdate(prim.attributes[k], numEncodedVerts, true, k === "POSITION", null);
                    }
                }
                // glTF requires min/max on POSITION. Multi-prim clones and strip
                // may omit them — recompute from the source position array.
                if (prim.attributes.POSITION != null && posArr && posArr.length >= 3) {
                    const pAcc = state.accessors[prim.attributes.POSITION];
                    if (pAcc) {
                        let minX = Infinity, minY = Infinity, minZ = Infinity;
                        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                        const n = Math.min(numVerts, (posArr.length / 3) | 0);
                        for (let i = 0; i < n; i++) {
                            const x = posArr[i * 3], y = posArr[i * 3 + 1], z = posArr[i * 3 + 2];
                            if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
                            if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
                        }
                        pAcc.min = [minX, minY, minZ];
                        pAcc.max = [maxX, maxY, maxZ];
                    }
                }

                encoderModule.destroy(encodedPtr);
                encoderModule.destroy(dracoMesh);
                encoderModule.destroy(meshBuilder);
                encoderModule.destroy(encoder);
                compressed++;
                // Remember for sibling primitives (outline etc.) that share accessors
                dracoByPosAccessor.set(posAccIdx, {
                    bufferView: bvIndex,
                    attributes: Object.assign({}, attrMap),
                    attrIndexMap: Object.assign({}, prim.attributes),
                    indices: prim.indices
                });
                console.warn("[export][draco] ok:", mesh.name,
                    "verts", numVerts, "→", numEncodedVerts,
                    "faces", numEncodedFaces,
                    "bytes", encodedLen,
                    "attrs", Object.keys(attrMap).join(","));
            } catch (e) {
                console.warn("[export] Draco encode failed for", mesh && mesh.name, e);
            }
        }
    }
    console.warn("[export][draco] done. compressed=", compressed,
        "reused=", reused,
        "skippedMorph=", skippedMorph, "skippedSkin=", skippedSkin, "skippedNoPos=", skippedNoPos);

    // Only declare the extension when we actually compressed something.
    // Putting it in extensionsRequired with zero compressed primitives can
    // confuse loaders / three-vrm and was a side-effect when everything was
    // skinned or morph-skipped.
    if (compressed > 0) {
        if (!state.extensionsUsed.includes("KHR_draco_mesh_compression"))
            state.extensionsUsed.push("KHR_draco_mesh_compression");
        if (!state.extensionsRequired) state.extensionsRequired = [];
        if (!state.extensionsRequired.includes("KHR_draco_mesh_compression"))
            state.extensionsRequired.push("KHR_draco_mesh_compression");
    }

    // Drop unreferenced bufferViews (pre-Draco raw data after compression, or
    // any accidental orphans). Without this, makeGlb can concatenate both raw
    // mesh data AND Draco payloads → file size grows instead of shrinks.
    // Always run: safe no-op when every view is still referenced.
    pruneUnusedBufferViews(state);
}

/**
 * Rebuild state.bufferViews / state.buffers so only still-referenced views remain.
 * Collects references from accessors (incl. sparse), images, and
 * KHR_draco_mesh_compression extensions, then remaps indices and re-packs
 * byteOffsets.
 */
export function pruneUnusedBufferViews(state) {
    const used = new Set();

    const mark = (idx) => {
        if (idx != null && idx >= 0) used.add(idx);
    };

    for (const acc of state.accessors || []) {
        if (!acc) continue;
        mark(acc.bufferView);
        if (acc.sparse) {
            if (acc.sparse.indices) mark(acc.sparse.indices.bufferView);
            if (acc.sparse.values) mark(acc.sparse.values.bufferView);
        }
    }

    for (const img of state.images || []) {
        if (img) mark(img.bufferView);
    }

    for (const mesh of state.meshes || []) {
        if (!mesh || !mesh.primitives) continue;
        for (const prim of mesh.primitives) {
            if (!prim || !prim.extensions) continue;
            const draco = prim.extensions.KHR_draco_mesh_compression;
            if (draco) mark(draco.bufferView);
        }
    }

    if (used.size === state.bufferViews.length) {
        console.warn("[export][draco] prune: nothing to drop");
        return;
    }

    const newBufferViews = [];
    const newBuffers = [];
    let newOffset = 0;
    const remap = new Map(); // oldIdx → newIdx

    for (let i = 0; i < state.bufferViews.length; i++) {
        if (!used.has(i)) continue;
        const bv = state.bufferViews[i];
        const data = state.buffers[i];
        const newBv = Object.assign({}, bv, { byteOffset: newOffset });
        remap.set(i, newBufferViews.length);
        newBufferViews.push(newBv);
        newBuffers.push(data);
        newOffset += align4(data.byteLength || (data && data.length) || 0);
    }

    const remapIdx = (idx) => (idx != null && remap.has(idx) ? remap.get(idx) : idx);

    for (const acc of state.accessors || []) {
        if (!acc) continue;
        if (acc.bufferView != null) acc.bufferView = remapIdx(acc.bufferView);
        if (acc.sparse) {
            if (acc.sparse.indices && acc.sparse.indices.bufferView != null)
                acc.sparse.indices.bufferView = remapIdx(acc.sparse.indices.bufferView);
            if (acc.sparse.values && acc.sparse.values.bufferView != null)
                acc.sparse.values.bufferView = remapIdx(acc.sparse.values.bufferView);
        }
    }

    for (const img of state.images || []) {
        if (img && img.bufferView != null) img.bufferView = remapIdx(img.bufferView);
    }

    for (const mesh of state.meshes || []) {
        if (!mesh || !mesh.primitives) continue;
        for (const prim of mesh.primitives) {
            if (!prim || !prim.extensions) continue;
            const draco = prim.extensions.KHR_draco_mesh_compression;
            if (draco && draco.bufferView != null)
                draco.bufferView = remapIdx(draco.bufferView);
        }
    }

    const dropped = state.bufferViews.length - newBufferViews.length;
    console.warn("[export][draco] prune: kept=", newBufferViews.length,
        "dropped=", dropped,
        "bytes", state.offset, "→", newOffset);

    state.bufferViews = newBufferViews;
    state.buffers = newBuffers;
    state.offset = newOffset;
}

