/**
 * Morpholith export — mesh attributes, morph targets, skins.
 */
import { ComponentType, MORPH_SPARSE_EPS } from "./constants.js";
import { addAccessor, addBufferView } from "./core.js";
import { makeMaterial, makeMaterialFromThree } from "./material.js";
import { exportMaterialList } from "./scene-helpers.js";
import { exportLog } from "./log.js";

export function coalesceGroupsByMaterial(groups, fullIndex) {
    const map = new Map(); // materialIndex -> number[]
    const order = [];
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const start = g.start | 0;
        const count = g.count | 0;
        if (count <= 0) continue;
        const mi = (g.materialIndex != null) ? (g.materialIndex | 0) : 0;
        if (!map.has(mi)) {
            map.set(mi, []);
            order.push(mi);
        }
        const dest = map.get(mi);
        for (let i = 0; i < count; i++) {
            dest.push(fullIndex[start + i]);
        }
    }
    return order.map(mi => ({ materialIndex: mi, indices: map.get(mi) }));
}

export async function makeMesh(state, targets) {
    const mesh = {};
    mesh.name = targets[0].name;
    mesh.primitives = [];
    for (const target of targets) {
        const geo = target.geometry;
        const attrs = {};
        if (geo.attributes?.position) {
            const array = copyAttrArray(geo.attributes.position);
            if (state.flipAxis) {
                for (let i = 0; i < array.length; i += 3) {
                    array[i] = -array[i];
                    array[i + 2] = -array[i + 2];
                }
            }
            attrs.POSITION = addAccessor(state, array, 'VEC3', target.name + '_position', true);
        }
        if (geo.attributes?.uv) {
            const uvArr = copyAttrArray(geo.attributes.uv);
            attrs.TEXCOORD_0 = addAccessor(state, quantizeUVs(uvArr), 'VEC2', target.name + '_uv', true, true);
        }
        {
            let nArr = geo.attributes?.normal ? copyAttrArray(geo.attributes.normal) : null;
            if (nArr == null || normalsArrayIsDegenerate(nArr)) {
                const repaired = recomputeNormalsFromGeometry(geo);
                if (repaired && !normalsArrayIsDegenerate(repaired)) {
                    nArr = repaired;
                    exportLog(state, "warn", "[export][mesh] normals recomputed (makeMesh)",
                        "mesh=", target.name || "", "verts=", (nArr.length / 3) | 0);
                }
            }
            if (nArr) {
                if (state.flipAxis) {
                    for (let i = 0; i < nArr.length; i += 3) {
                        nArr[i] = -nArr[i];
                        nArr[i + 2] = -nArr[i + 2];
                    }
                }
                attrs.NORMAL = addAccessor(state, nArr, 'VEC3', target.name + '_normal', false);
            }
        }
        if (geo.attributes?.skinIndex) {
            const jArr = copyAttrArray(geo.attributes.skinIndex);
            attrs.JOINTS_0 = addAccessor(state, quantizeJoints(jArr), 'VEC4', target.name + '_joint', false);
        }
        if (geo.attributes?.skinWeight) {
            const wArr = copyAttrArray(geo.attributes.skinWeight);
            attrs.WEIGHTS_0 = addAccessor(state, quantizeWeights(wArr), 'VEC4', target.name + '_weight', false, true);
        }
        if (geo.attributes?.color) {
            const cArr = copyAttrArray(geo.attributes.color);
            attrs.COLOR_0 = addAccessor(state, cArr, 'VEC3', target.name + '_color', false);
        }

        let morphTargets = null;
        let targetNames = null;
        if (target.morphTargetDictionary && !(state.exportOptions && state.exportOptions.skipMorphTargets)) {
            targetNames = [];
            for (const morph in target.morphTargetDictionary) {
                const index = target.morphTargetDictionary[morph];
                targetNames[index] = morph;
            }
            const positions = geo.morphAttributes && geo.morphAttributes.position;
            morphTargets = [];
            if (positions) {
                for (let i = 0; i < positions.length; i++) {
                    const item = {};
                    if (positions[i]) {
                        const array = positions[i].array.slice();
                        if (state.flipAxis) {
                            for (let k = 0; k < array.length; k += 3) {
                                array[k] = -array[k];
                                array[k + 2] = -array[k + 2];
                            }
                        }
                        item.POSITION = addSparseMorphPositionAccessor(state, array, (targetNames[i] || ('morph_' + i)) + '_position');
                    }
                    morphTargets.push(item);
                }
            }
        }

        const { matList, remap } = exportMaterialList(target);
        const useGroups = geo.groups && geo.groups.length > 0 && matList.length > 1;

        if (useGroups && geo.index) {
            const fullIndex = geo.index.array;
            const remapped = geo.groups.map(g => {
                const oldMi = (g.materialIndex != null) ? (g.materialIndex | 0) : 0;
                let newMi = (oldMi >= 0 && oldMi < remap.length) ? remap[oldMi] : 0;
                if (newMi < 0) newMi = 0;
                return { start: g.start, count: g.count, materialIndex: newMi };
            });
            const byMat = coalesceGroupsByMaterial(remapped, fullIndex);
            for (let pi = 0; pi < byMat.length; pi++) {
                const { materialIndex, indices } = byMat[pi];
                if (!indices.length) continue;
                const array = indices instanceof fullIndex.constructor
                    ? indices
                    : new fullIndex.constructor(indices);
                const primitive = {};
                primitive.attributes = attrs;
                primitive.name = byMat.length > 1
                    ? (target.name + '_g' + pi)
                    : target.name;
                primitive.indices = addAccessor(state, array, 'SCALAR', target.name + '_g' + pi + '_index', false);
                primitive.material = await makeMaterialFromThree(state, matList[materialIndex] || matList[0], target.renderOrder);
                primitive.mode = 4;
                if (morphTargets) {
                    primitive.extras = { targetNames: targetNames };
                    primitive.targets = morphTargets;
                }
                mesh.primitives.push(primitive);
            }
        } else {
            const primitive = {};
            primitive.attributes = attrs;
            primitive.name = target.name;
            if (geo.index) primitive.indices = addAccessor(state,
                geo.index.array, 'SCALAR', target.name + '_index', false
            );
            if (targetNames) primitive.extras = { targetNames: targetNames };
            if (morphTargets) primitive.targets = morphTargets;
            // アウトラインを除いた先頭マテリアルのみ
            primitive.material = await makeMaterialFromThree(state, matList[0] || target.material, target.renderOrder);
            primitive.mode = 4;
            mesh.primitives.push(primitive);
        }
    }
    if (mesh.primitives[0]?.extras?.targetNames) mesh.extras = { targetNames: mesh.primitives[0].extras.targetNames };
    const index = state.meshes.length;
    state.meshes.push(mesh);
    state.meshMap.set(targets[0], index);
    return index;
}
/**
 * Copy a geometry attribute to a plain float (or same-type) array.
 * CRITICAL: GLTFLoader leaves normalized UINT16/INT16 UVs/weights/normals as
 * the raw typed array with attribute.normalized=true. Reading .array then gives
 * integers (e.g. 28816) instead of 0–1 floats. Feeding those into quantizeUVs
 * clamps everything to 1.0 → all UVs become (1,1) → black eyes / missing skin
 * when re-exporting a previously morpholith-exported VRM.
 */
function copyAttrArray(attr) {
    if (!attr || !attr.array) return null;
    // InterleavedBufferAttribute: .array is the full interleaved buffer and
    // sequential slice would scramble components. Prefer per-component getters.
    if (attr.isInterleavedBufferAttribute || (typeof attr.getX === "function" && attr.data)) {
        const count = attr.count | 0;
        const itemSize = attr.itemSize | 0;
        if (count < 1 || itemSize < 1) return null;
        const out = new Float32Array(count * itemSize);
        for (let i = 0; i < count; i++) {
            const o = i * itemSize;
            if (itemSize >= 1) out[o] = attr.getX(i);
            if (itemSize >= 2) out[o + 1] = attr.getY(i);
            if (itemSize >= 3) out[o + 2] = attr.getZ(i);
            if (itemSize >= 4 && typeof attr.getW === "function") out[o + 3] = attr.getW(i);
        }
        return out;
    }
    const src = attr.array;
    const normalized = !!attr.normalized;
    const isInt = src instanceof Uint16Array || src instanceof Int16Array
        || src instanceof Uint8Array || src instanceof Int8Array;
    if (normalized && isInt) {
        const out = new Float32Array(src.length);
        let denom = 65535;
        if (src instanceof Int16Array) denom = 32767;
        else if (src instanceof Uint8Array) denom = 255;
        else if (src instanceof Int8Array) denom = 127;
        else if (src instanceof Uint16Array) denom = 65535;
        for (let i = 0; i < src.length; i++) {
            let v = src[i];
            if (src instanceof Int16Array || src instanceof Int8Array) {
                // glTF: max negative uses -denom-ish; mirror three.js getX path
                out[i] = Math.max(-1, Math.min(1, v / (v < 0 ? (denom + 1) : denom)));
            } else {
                out[i] = v / denom;
            }
        }
        return out;
    }
    return src.slice();
}

export function makeAttribute(state, targets, name, rotate = false) {
    if (!targets[0].geometry.attributes[name]) return null;
    // Single-mesh fast path: one copy (+ optional VRM0 axis flip) instead of
    // allocate-then-set which doubles work for the common case.
    if (targets.length === 1) {
        const array = copyAttrArray(targets[0].geometry.attributes[name]);
        if (!array) return null;
        if (state.flipAxis && rotate) {
            for (let i = 0; i < array.length; i += 3) {
                array[i] = -array[i];
                array[i + 2] = -array[i + 2];
            }
        }
        return array;
    }
    const parts = targets.map(t => copyAttrArray(t.geometry.attributes[name]));
    if (!parts[0]) return null;
    const length = parts.reduce((sum, p) => sum + p.length, 0);
    const array = new Float32Array(length);
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
        array.set(parts[i], offset);
        offset += parts[i].length;
    }
    if (state.flipAxis && rotate) {
        for (let i = 0; i < array.length; i += 3) {
            array[i] = -array[i];
            array[i + 2] = -array[i + 2];
        }
    }
    return array;
}

/**
 * Prefer geometry.boundingBox for POSITION min/max (set during body bake /
 * computeBoundingBox). Falls back to null so addAccessor scans the array.
 * Applies VRM0 axis flip to bounds when needed.
 */
export function positionMinMaxFromGeometry(state, targets) {
    if (!targets || targets.length !== 1) return null;
    const geo = targets[0].geometry;
    if (!geo) return null;
    try {
        if (!geo.boundingBox) geo.computeBoundingBox();
        const b = geo.boundingBox;
        if (!b || !b.min || !b.max) return null;
        if (state.flipAxis) {
            // POSITION flip: x'=-x, z'=-z → min/max swap on those axes
            return {
                min: [-b.max.x, b.min.y, -b.max.z],
                max: [-b.min.x, b.max.y, -b.min.z]
            };
        }
        return {
            min: [b.min.x, b.min.y, b.min.z],
            max: [b.max.x, b.max.y, b.max.z]
        };
    } catch (e) {
        return null;
    }
}

/** Quantize float normals → normalized INT16 (¼ size, standard in glTF). */
export function quantizeNormals(floatArr) {
    const out = new Int16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) {
        const v = Math.max(-1, Math.min(1, floatArr[i]));
        out[i] = (v < 0) ? Math.round(v * 32768) : Math.round(v * 32767);
    }
    return out;
}
/** Quantize UVs → normalized UINT16.
 * Input MUST be floats in ~0–1 (use copyAttrArray first). Values >> 1 are
 * treated as already-UINT16 raw samples and denormalized (safety net). */
export function quantizeUVs(floatArr) {
    const out = new Uint16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) {
        let v = floatArr[i];
        // Safety: if caller forgot denorm, recover (e.g. raw 28816 → ~0.44)
        if (v > 1.5 && v <= 65535) v = v / 65535;
        v = Math.max(0, Math.min(1, v));
        out[i] = Math.round(v * 65535);
    }
    return out;
}
/** Skin indices → UINT16 (or UINT8 if every joint index < 256). */
export function quantizeJoints(floatArr) {
    let max = 0;
    for (let i = 0; i < floatArr.length; i++) {
        const v = floatArr[i] | 0;
        if (v > max) max = v;
    }
    if (max <= 255) {
        const out = new Uint8Array(floatArr.length);
        for (let i = 0; i < floatArr.length; i++) out[i] = floatArr[i] | 0;
        return out;
    }
    const out = new Uint16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) out[i] = floatArr[i] | 0;
    return out;
}
/** Skin weights → normalized UINT16. */
export function quantizeWeights(floatArr) {
    const out = new Uint16Array(floatArr.length);
    for (let i = 0; i < floatArr.length; i++) {
        let v = floatArr[i];
        if (v > 1.5 && v <= 65535) v = v / 65535;
        v = Math.max(0, Math.min(1, v));
        out[i] = Math.round(v * 65535);
    }
    return out;
}

export function makeAttributes(state, targets) {
    const name = targets[0].name;

    const newAttributes = {};
    // Positions stay float32 (need precision after body-type bake)
    const POSITION = makeAttribute(state, targets, 'position', true);
    if (POSITION != null) {
        const bb = positionMinMaxFromGeometry(state, targets);
        newAttributes.POSITION = addAccessor(state, POSITION, 'VEC3', name + '_position', true, false, bb);
    }

    // Normals: keep float32. Re-quantizing to INT16 changes subtle N·L on thin
    // hair cards and makes MToon shade (underside) look darker than the source.
    // UVs / joints / weights are still quantized for size.
    //
    // Safety net (VRM_EXPORT_NORMALS_FIX): if the live geometry carries all-zero
    // or non-finite normals (common after split-multi-prim computeVertexNormals
    // or failed body-bake LBS), recompute from positions+indices so the packed
    // GLB never ships (0,0,0) face normals → white/black MToon face.
    let NORMAL = makeAttribute(state, targets, 'normal', true);
    if (NORMAL == null || normalsArrayIsDegenerate(NORMAL)) {
        const geo = targets[0] && targets[0].geometry;
        const repaired = geo ? recomputeNormalsFromGeometry(geo) : null;
        if (repaired && !normalsArrayIsDegenerate(repaired)) {
            NORMAL = repaired;
            if (state.flipAxis) {
                for (let i = 0; i < NORMAL.length; i += 3) {
                    NORMAL[i] = -NORMAL[i];
                    NORMAL[i + 2] = -NORMAL[i + 2];
                }
            }
            exportLog(state, "warn", "[export][mesh] normals recomputed (were zero/degenerate)",
                "mesh=", name, "verts=", (NORMAL.length / 3) | 0);
        }
    }
    if (NORMAL != null) {
        newAttributes.NORMAL = addAccessor(state, NORMAL, 'VEC3', name + '_normal', false, false);
    }

    const TEXCOORD_0 = makeAttribute(state, targets, 'uv');
    if (TEXCOORD_0 != null) {
        newAttributes.TEXCOORD_0 = addAccessor(state, quantizeUVs(TEXCOORD_0), 'VEC2', name + '_uv', true, true);
    }
    const JOINTS_0 = makeAttribute(state, targets, 'skinIndex');
    if (JOINTS_0 != null) {
        newAttributes.JOINTS_0 = addAccessor(state, quantizeJoints(JOINTS_0), 'VEC4', name + '_joint', false, false);
    }
    const WEIGHTS_0 = makeAttribute(state, targets, 'skinWeight');
    if (WEIGHTS_0 != null) {
        newAttributes.WEIGHTS_0 = addAccessor(state, quantizeWeights(WEIGHTS_0), 'VEC4', name + '_weight', false, true);
    }
    return newAttributes;
}
/**
 * Morph targets are almost always sparse (only a region of the face moves).
 * Encode as glTF sparse accessors initialized to zero — often 5–20× smaller
 * than dense float32 position deltas.
 */
export function addSparseMorphPositionAccessor(state, dense, name) {
    const vertexCount = dense.length / 3;
    const indices = [];
    const values = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < vertexCount; i++) {
        const o = i * 3;
        const dx = dense[o], dy = dense[o + 1], dz = dense[o + 2];
        if (Math.abs(dx) > MORPH_SPARSE_EPS || Math.abs(dy) > MORPH_SPARSE_EPS || Math.abs(dz) > MORPH_SPARSE_EPS) {
            indices.push(i);
            values.push(dx, dy, dz);
            if (dx < minX) minX = dx; if (dx > maxX) maxX = dx;
            if (dy < minY) minY = dy; if (dy > maxY) maxY = dy;
            if (dz < minZ) minZ = dz; if (dz > maxZ) maxZ = dz;
        }
    }

    // Empty morph → tiny dense zero array is wasteful; sparse count 0 is awkward
    // for some loaders, so store a single zero vertex dense accessor of count verts
    // with no bufferView (not widely supported). Prefer 1-entry sparse at vertex 0.
    if (indices.length === 0) {
        indices.push(0);
        values.push(0, 0, 0);
        minX = minY = minZ = 0;
        maxX = maxY = maxZ = 0;
    }

    const IndexCtor = vertexCount > 65535 ? Uint32Array : Uint16Array;
    const indexArr = new IndexCtor(indices);
    const valueArr = new Float32Array(values);

    // Fall back to dense when sparse is not smaller (rare, very dense morphs)
    // or when caller disabled sparse morph encoding.
    const sparseBytes = indexArr.byteLength + valueArr.byteLength;
    const preferSparse = !state.exportOptions || state.exportOptions.sparseMorph !== false;
    if (!preferSparse || sparseBytes >= dense.byteLength * 0.95) {
        return addAccessor(state, dense, 'VEC3', name, true, false);
    }

    const accessor = {
        name,
        componentType: ComponentType.Float32Array,
        count: vertexCount,
        type: 'VEC3',
        max: [maxX, maxY, maxZ],
        min: [minX, minY, minZ],
        sparse: {
            count: indices.length,
            indices: {
                bufferView: addBufferView(state, indexArr, name + '_sparse_idx'),
                byteOffset: 0,
                componentType: IndexCtor === Uint32Array ? ComponentType.Uint32Array : ComponentType.Uint16Array
            },
            values: {
                bufferView: addBufferView(state, valueArr, name + '_sparse_val'),
                byteOffset: 0
            }
        }
    };
    const index = state.accessors.length;
    state.accessors.push(accessor);
    return index;
}

export function makeMorph(state, primitives) {
    if (state.exportOptions && state.exportOptions.skipMorphTargets) return null;
    if (!primitives[0].morphTargetDictionary) return null;

    const targetNames = [];
    for (const morphName in primitives[0].morphTargetDictionary) {
        const index = primitives[0].morphTargetDictionary[morphName];
        targetNames[index] = morphName;
    }

    function makeMorphTargetDense(primitives, morphIndex) {
        const length = primitives.reduce((sum, target) => {
            return sum + target.geometry.attributes.position.array.length;
        }, 0);
        const array = new Float32Array(length);
        let offset = 0;
        for (let j = 0; j < primitives.length; j++) {
            const target = primitives[j];
            const morphAttr = target.geometry.morphAttributes && target.geometry.morphAttributes.position;
            const posLen = target.geometry.attributes.position.array.length;
            if (morphAttr && morphAttr[morphIndex] && morphAttr[morphIndex].array) {
                array.set(morphAttr[morphIndex].array, offset);
            }
            offset += posLen;
        }
        if (state.flipAxis) {
            for (let k = 0; k < array.length; k += 3) {
                array[k] = -array[k];
                array[k + 2] = -array[k + 2];
            }
        }
        return array;
    }

    const targets = [];
    for (let i = 0; i < targetNames.length; i++) {
        const name = targetNames[i] || ('morph_' + i);
        const dense = makeMorphTargetDense(primitives, i);
        // POSITION only — morph normals are large and rarely needed for VRM expressions
        targets.push({
            POSITION: addSparseMorphPositionAccessor(state, dense, name + '_position')
        });
    }
    return { targets, targetNames };
}
/**
 * When estimate-side component tint splits a mesh into material[] + geometry.groups,
 * emit one glTF primitive per group so each tinted part keeps its own material.
 * Shared vertex attributes (POSITION etc.) stay on the parent mesh level via the
 * same accessor indices; only the index buffer is sliced per group.
 */
function geometryForExport(target) {
    try {
        if (target && target.userData && target.userData._exportBakedGeometry)
            return target.userData._exportBakedGeometry;
    } catch (e) {}
    return target && target.geometry;
}

/**
 * True when a normal float array is missing, empty, or effectively all zero /
 * non-finite. Used to decide whether to recompute from positions+indices.
 */
function normalsArrayIsDegenerate(arr, itemSize = 3) {
    if (!arr || arr.length < itemSize) return true;
    const n = (arr.length / itemSize) | 0;
    if (n < 1) return true;
    let finite = 0, nonZero = 0;
    // Full scan for small buffers; sample denser for large so we never miss
    // a whole material group that was zeroed by per-split computeVertexNormals.
    const step = n <= 512 ? 1 : Math.max(1, Math.floor(n / 256));
    for (let i = 0; i < n; i += step) {
        const o = i * itemSize;
        const x = arr[o], y = arr[o + 1], z = arr[o + 2];
        if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
            finite++;
            if (x * x + y * y + z * z > 1e-12) nonZero++;
        }
    }
    // Require a meaningful fraction of samples to be non-zero. A single
    // valid normal among hundreds of zeros still means the face is broken.
    const samples = Math.ceil(n / step);
    return finite < Math.max(2, samples * 0.1) || nonZero < Math.max(2, samples * 0.1);
}

/**
 * Recompute vertex normals on a geometry from positions + indices.
 * Prefer THREE.BufferGeometry.computeVertexNormals when available (via
 * geo.computeVertexNormals). Returns the float32 normal array, or null.
 *
 * IMPORTANT for multi-prim Face meshes: three.js splits one glTF mesh into
 * N Mesh objects that each hold a FULL copy of vertex attributes but only
 * the indices for one material group. Calling computeVertexNormals on one
 * sibling zeros normals for vertices not referenced by that sibling's index
 * buffer. When export later shares one attribute set across all primitives
 * (split-multi-prim dedupe), those zeros ship in the GLB and MToon shades
 * the face pure white/black. Always pass the UNION of sibling indices when
 * repairing shared attribute sources.
 */
function recomputeNormalsFromGeometry(geo) {
    if (!geo || !geo.attributes || !geo.attributes.position) return null;
    try {
        if (typeof geo.computeVertexNormals === "function") {
            geo.computeVertexNormals();
            if (geo.attributes.normal) {
                geo.attributes.normal.needsUpdate = true;
                const arr = copyAttrArray(geo.attributes.normal);
                if (arr && !normalsArrayIsDegenerate(arr)) return arr;
            }
        }
    } catch (e) { /* fall through to manual */ }
    // Manual fan-in (indexed or non-indexed triangles)
    try {
        const pos = geo.attributes.position.array;
        const vCount = (pos.length / 3) | 0;
        const out = new Float32Array(vCount * 3);
        const idx = geo.index && geo.index.array;
        const triCount = idx ? ((idx.length / 3) | 0) : ((vCount / 3) | 0);
        const ax = (i) => pos[i * 3], ay = (i) => pos[i * 3 + 1], az = (i) => pos[i * 3 + 2];
        for (let t = 0; t < triCount; t++) {
            let i0, i1, i2;
            if (idx) {
                i0 = idx[t * 3] | 0; i1 = idx[t * 3 + 1] | 0; i2 = idx[t * 3 + 2] | 0;
            } else {
                i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2;
            }
            if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= vCount || i1 >= vCount || i2 >= vCount) continue;
            const e1x = ax(i1) - ax(i0), e1y = ay(i1) - ay(i0), e1z = az(i1) - az(i0);
            const e2x = ax(i2) - ax(i0), e2y = ay(i2) - ay(i0), e2z = az(i2) - az(i0);
            const nx = e1y * e2z - e1z * e2y;
            const ny = e1z * e2x - e1x * e2z;
            const nz = e1x * e2y - e1y * e2x;
            out[i0 * 3] += nx; out[i0 * 3 + 1] += ny; out[i0 * 3 + 2] += nz;
            out[i1 * 3] += nx; out[i1 * 3 + 1] += ny; out[i1 * 3 + 2] += nz;
            out[i2 * 3] += nx; out[i2 * 3 + 1] += ny; out[i2 * 3 + 2] += nz;
        }
        for (let i = 0; i < vCount; i++) {
            const x = out[i * 3], y = out[i * 3 + 1], z = out[i * 3 + 2];
            const len = Math.sqrt(x * x + y * y + z * z);
            if (len > 1e-12) {
                out[i * 3] = x / len; out[i * 3 + 1] = y / len; out[i * 3 + 2] = z / len;
            } else {
                // Unreferenced vertex — keep a neutral up so MToon never sees (0,0,0)
                out[i * 3] = 0; out[i * 3 + 1] = 1; out[i * 3 + 2] = 0;
            }
        }
        // Write back so subsequent attribute copies see valid data
        try {
            if (geo.attributes.normal && geo.attributes.normal.array
                && geo.attributes.normal.array.length === out.length
                && !geo.attributes.normal.isInterleavedBufferAttribute) {
                geo.attributes.normal.array.set(out);
                geo.attributes.normal.needsUpdate = true;
            } else if (typeof geo.setAttribute === "function") {
                // Avoid importing THREE here; only set if BufferAttribute-like already present
                const nrm = geo.attributes.normal;
                if (nrm && nrm.array && nrm.array.length === out.length) {
                    nrm.array.set(out);
                    nrm.needsUpdate = true;
                }
            }
        } catch (eW) { /* ignore write-back */ }
        return out;
    } catch (e2) {
        return null;
    }
}

/**
 * Build normals for a split-multi-prim group using the UNION of every
 * sibling's index buffer so no material region is left at (0,0,0).
 * Mutates attrSrc.geometry normals in place when possible.
 */
function repairSharedNormalsForSplitMultiPrim(targets, attrSrc, state) {
    if (!targets || targets.length < 1 || !attrSrc || !attrSrc.geometry) return;
    const geo = attrSrc.geometry;
    const pos = geo.attributes && geo.attributes.position;
    if (!pos || pos.count < 3) return;
    const vCount = pos.count | 0;

    // Collect union of all indices
    let totalIdx = 0;
    const indexParts = [];
    for (let i = 0; i < targets.length; i++) {
        const g = targets[i] && targets[i].geometry;
        if (!g || !g.index || !g.index.array) continue;
        indexParts.push(g.index.array);
        totalIdx += g.index.array.length;
    }
    if (totalIdx < 3) {
        // Fall back to attrSrc alone
        const repaired = recomputeNormalsFromGeometry(geo);
        if (repaired && state) {
            exportLog(state, "warn", "[export][mesh] normals repaired (single index)",
                "verts=", vCount, "src=", (attrSrc.name || "").slice(0, 40));
        }
        return;
    }

    // Temporary geometry-like object with combined indices
    const combined = new (indexParts[0].constructor)(totalIdx);
    let off = 0;
    for (let i = 0; i < indexParts.length; i++) {
        combined.set(indexParts[i], off);
        off += indexParts[i].length;
    }
    const temp = {
        attributes: geo.attributes,
        index: { array: combined },
        computeVertexNormals: geo.computeVertexNormals
            ? geo.computeVertexNormals.bind(geo)
            : undefined,
        setAttribute: geo.setAttribute ? geo.setAttribute.bind(geo) : undefined
    };
    // Swap index, recompute, restore
    const prevIndex = geo.index;
    try {
        geo.index = { array: combined, count: (combined.length / 1) | 0 };
        // Prefer native path: it reads geo.index
        if (typeof geo.computeVertexNormals === "function") {
            // Native computeVertexNormals needs a real BufferAttribute index.
            // Use manual path with combined indices instead — more reliable
            // without THREE.BufferAttribute construction.
            const arr = (() => {
                const posArr = pos.array;
                const out = new Float32Array(vCount * 3);
                const triCount = (combined.length / 3) | 0;
                for (let t = 0; t < triCount; t++) {
                    const i0 = combined[t * 3] | 0;
                    const i1 = combined[t * 3 + 1] | 0;
                    const i2 = combined[t * 3 + 2] | 0;
                    if (i0 >= vCount || i1 >= vCount || i2 >= vCount) continue;
                    const ax = posArr[i0 * 3], ay = posArr[i0 * 3 + 1], az = posArr[i0 * 3 + 2];
                    const bx = posArr[i1 * 3], by = posArr[i1 * 3 + 1], bz = posArr[i1 * 3 + 2];
                    const cx = posArr[i2 * 3], cy = posArr[i2 * 3 + 1], cz = posArr[i2 * 3 + 2];
                    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
                    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
                    const nx = e1y * e2z - e1z * e2y;
                    const ny = e1z * e2x - e1x * e2z;
                    const nz = e1x * e2y - e1y * e2x;
                    out[i0 * 3] += nx; out[i0 * 3 + 1] += ny; out[i0 * 3 + 2] += nz;
                    out[i1 * 3] += nx; out[i1 * 3 + 1] += ny; out[i1 * 3 + 2] += nz;
                    out[i2 * 3] += nx; out[i2 * 3 + 1] += ny; out[i2 * 3 + 2] += nz;
                }
                for (let i = 0; i < vCount; i++) {
                    const x = out[i * 3], y = out[i * 3 + 1], z = out[i * 3 + 2];
                    const len = Math.sqrt(x * x + y * y + z * z);
                    if (len > 1e-12) {
                        out[i * 3] = x / len; out[i * 3 + 1] = y / len; out[i * 3 + 2] = z / len;
                    } else {
                        out[i * 3] = 0; out[i * 3 + 1] = 1; out[i * 3 + 2] = 0;
                    }
                }
                return out;
            })();
            // Write into attrSrc normal buffer (and siblings that share the same array ref)
            const nrm = geo.attributes.normal;
            if (nrm && nrm.array && nrm.array.length === arr.length
                && !nrm.isInterleavedBufferAttribute) {
                nrm.array.set(arr);
                nrm.needsUpdate = true;
            } else if (nrm && typeof nrm.setXYZ === "function") {
                for (let i = 0; i < vCount; i++) nrm.setXYZ(i, arr[i * 3], arr[i * 3 + 1], arr[i * 3 + 2]);
                nrm.needsUpdate = true;
            }
            // Propagate to siblings that have their own normal copies
            for (let i = 0; i < targets.length; i++) {
                const g = targets[i] && targets[i].geometry;
                if (!g || g === geo) continue;
                const sn = g.attributes && g.attributes.normal;
                if (!sn || !sn.array || sn.array.length !== arr.length) continue;
                if (sn.array === (nrm && nrm.array)) continue; // shared ref already updated
                if (sn.isInterleavedBufferAttribute) continue;
                try {
                    sn.array.set(arr);
                    sn.needsUpdate = true;
                } catch (eP) { /* ignore */ }
            }
            if (state) {
                exportLog(state, "warn", "[export][mesh] shared normals recomputed from union indices",
                    "targets=", targets.length, "verts=", vCount, "tris=", (combined.length / 3) | 0,
                    "src=", (attrSrc.name || "").slice(0, 40));
            }
        } else {
            recomputeNormalsFromGeometry(temp);
        }
    } catch (e) {
        if (state) {
            exportLog(state, "warn", "[export][mesh] shared normal repair failed",
                (attrSrc.name || ""), e && e.message);
        }
    } finally {
        geo.index = prevIndex;
    }
}

/**
 * After a multi-primitive glTF mesh is loaded, three.js often splits it into
 * N meshes that each hold a FULL copy of the vertex attributes (same positions).
 * Concatenating those on re-export multiplies geometry size by N (e.g. 4× Face).
 * Detect that case so we export one attribute set + per-material indices only.
 *
 * Safety: require matching position + UV samples so we never share attributes
 * across genuinely different meshes (black-eye risk when UV islands differ).
 */
function isSplitMultiPrimDuplicate(targets) {
    if (!targets || targets.length < 2) return false;
    const g0 = targets[0] && targets[0].geometry;
    if (!g0 || !g0.attributes || !g0.attributes.position) return false;
    const n0 = g0.attributes.position.count | 0;
    if (n0 < 3) return false;
    const p0 = g0.attributes.position.array;
    const uv0 = g0.attributes.uv && g0.attributes.uv.array;
    for (let i = 1; i < targets.length; i++) {
        const g = targets[i] && targets[i].geometry;
        if (!g || !g.attributes || !g.attributes.position) return false;
        if ((g.attributes.position.count | 0) !== n0) return false;
        const p = g.attributes.position.array;
        if (p.length !== p0.length) return false;
        // Sample positions — full compare is expensive
        for (let k = 0; k < Math.min(24, p0.length); k++) {
            if (Math.abs(p[k] - p0[k]) > 1e-5) return false;
        }
        // Mid/end samples catch partial divergences after contour/nose deform
        if (p0.length > 48) {
            const mid = (p0.length >>> 1) - 8;
            for (let k = 0; k < 16; k++) {
                if (Math.abs(p[mid + k] - p0[mid + k]) > 1e-5) return false;
            }
            for (let k = p0.length - 16; k < p0.length; k++) {
                if (Math.abs(p[k] - p0[k]) > 1e-5) return false;
            }
        }
        if (!g.index) return false;
        // UV must match when both have uv (shared atlas multi-prim)
        const uv = g.attributes.uv && g.attributes.uv.array;
        if (!!uv0 !== !!uv) return false;
        if (uv0 && uv) {
            if (uv.length !== uv0.length) return false;
            for (let k = 0; k < Math.min(16, uv0.length); k++) {
                if (Math.abs(uv[k] - uv0[k]) > 1e-5) return false;
            }
            if (uv0.length > 32) {
                for (let k = uv0.length - 16; k < uv0.length; k++) {
                    if (Math.abs(uv[k] - uv0[k]) > 1e-5) return false;
                }
            }
        }
    }
    return true;
}

export async function makeMesh2(state, targets) {
    const mesh = {};
    mesh.name = targets[0].name;
    mesh.primitives = [];

    // Temporarily point targets at export geometry so attribute helpers stay unchanged
    const geoRestore = [];
    targets.forEach(t => {
        const eg = geometryForExport(t);
        if (eg && t.geometry !== eg) {
            geoRestore.push({ t, g: t.geometry });
            t.geometry = eg;
        }
    });
    try {

    // Re-export after load: avoid N× vertex attribute bloat.
    // three.js splits multi-prim into N meshes with full attribute copies;
    // concatenating them multiplies geometry (Face×4 is common).
    // §84/§85: contour often deforms only one sibling → positions diverge and
    // strict isSplitMultiPrimDuplicate fails. If vert count + UV match, still
    // share one attribute set (prefer the mesh that has contour/extraDeform).
    let splitDup = isSplitMultiPrimDuplicate(targets);
    let attrSrc = targets[0];
    if (!splitDup && targets.length >= 2) {
        try {
            const n0 = targets[0].geometry && targets[0].geometry.attributes
                && targets[0].geometry.attributes.position
                ? (targets[0].geometry.attributes.position.count | 0) : 0;
            const sameN = n0 > 0 && targets.every(t => t.geometry && t.geometry.attributes
                && t.geometry.attributes.position
                && (t.geometry.attributes.position.count | 0) === n0
                && t.geometry.index);
            let sameUv = sameN;
            if (sameN) {
                const uv0 = targets[0].geometry.attributes.uv
                    && targets[0].geometry.attributes.uv.array;
                for (let i = 1; sameUv && i < targets.length; i++) {
                    const uv = targets[i].geometry.attributes.uv
                        && targets[i].geometry.attributes.uv.array;
                    if (!!uv0 !== !!uv) { sameUv = false; break; }
                    if (uv0 && uv && uv.length !== uv0.length) { sameUv = false; break; }
                    if (uv0 && uv) {
                        for (let k = 0; k < Math.min(16, uv0.length); k++) {
                            if (Math.abs(uv[k] - uv0[k]) > 1e-5) { sameUv = false; break; }
                        }
                    }
                }
            }
            if (sameN && sameUv) {
                // Prefer sibling with contour / extraDeform so edit is not lost
                let srcIdx = 0;
                for (let i = 0; i < targets.length; i++) {
                    const eds = targets[i].userData && targets[i].userData.extraDeformers;
                    if (eds && eds.some(fn => fn && (fn._contourDeform || fn._noseDeform))) {
                        srcIdx = i;
                        break;
                    }
                }
                attrSrc = targets[srcIdx];
                splitDup = true;
                exportLog(state, "warn", "[export][mesh] split-multi-prim force-dedupe",
                    "targets=", targets.length, "verts=", n0,
                    "attrSrc=", (attrSrc.name || "").slice(0, 40),
                    "(positions diverged after contour — share attrs, avoid ×",
                    targets.length, ")");
            } else if (sameN && n0 > 0) {
                exportLog(state, "warn", "[export][mesh] split-multi-prim NOT deduped",
                    "targets=", targets.length, "verts=", n0,
                    "(UVs diverged — will write ×", targets.length, ")");
            }
        } catch (e) { /* ignore */ }
    }
    if (splitDup) {
        exportLog(state, "warn", "[export][mesh] split-multi-prim dedupe targets=",
            targets.length, "verts=", attrSrc.geometry.attributes.position.count,
            "src=", (attrSrc.name || "").slice(0, 40),
            "(avoided ×", targets.length, " geometry bloat)");
        // CRITICAL: each sibling only has valid normals for its own index range
        // after per-mesh computeVertexNormals. Recompute from the UNION of all
        // indices so Face_SKIN / eye / mouth verts are all non-zero before we
        // share one attribute set across primitives.
        try {
            repairSharedNormalsForSplitMultiPrim(targets, attrSrc, state);
        } catch (eRep) {
            exportLog(state, "warn", "[export][mesh] shared normal repair error", eRep && eRep.message);
        }
        // Use attrSrc attributes; each target contributes indices + material
        const attributes = makeAttributes(state, [attrSrc]);
        const COLOR_0 = makeAttribute(state, [attrSrc], 'color');
        if (COLOR_0 != null) {
            attributes.COLOR_0 = addAccessor(state, COLOR_0, 'VEC3', attrSrc.name + '_color', false);
        }
        const morph = makeMorph(state, [attrSrc]);
        if (morph) mesh.extras = { targetNames: morph.targetNames };
        for (let ti = 0; ti < targets.length; ti++) {
            const target = targets[ti];
            const geo = target.geometry;
            const fullIndex = geo.index.array;
            const { matList } = exportMaterialList(target);
            const mat = matList[0] || (Array.isArray(target.material) ? target.material[0] : target.material);
            const array = fullIndex.slice ? fullIndex.slice() : new fullIndex.constructor(fullIndex);
            // indices already reference the shared 0..vertCount space — no offset
            const primitive = {};
            primitive.attributes = attributes;
            primitive.name = target.name;
            primitive.indices = addAccessor(state, array, 'SCALAR', (target.name || 'mesh') + '_index', false);
            primitive.material = await makeMaterialFromThree(state, mat, target.renderOrder);
            primitive.mode = 4;
            if (morph) {
                primitive.extras = { targetNames: morph.targetNames };
                primitive.targets = morph.targets;
            }
            mesh.primitives.push(primitive);
        }
        const index = state.meshes.length;
        state.meshes.push(mesh);
        state.meshMap.set(targets[0], index);
        return index;
    }

    const attributes = makeAttributes(state, targets);
    // COLOR_0 for non-MToon vertex-color tints (estimate part colors on standard mats)
    const COLOR_0 = makeAttribute(state, targets, 'color');
    if (COLOR_0 != null) {
        attributes.COLOR_0 = addAccessor(state, COLOR_0, 'VEC3', targets[0].name + '_color', false);
    }
    const morph = makeMorph(state, targets);
    if (morph) mesh.extras = { targetNames: morph.targetNames };

    let offset = 0;
    for (const target of targets) {
        const geo = target.geometry;
        if (!geo || !geo.index) {
            // Fallback: single primitive (rare non-indexed)
            const primitive = {};
            primitive.attributes = attributes;
            primitive.name = target.name;
            if (geo && geo.index) {
                const array = geo.index.array.slice();
                for (let i = 0; i < array.length; i++) array[i] += offset;
                primitive.indices = addAccessor(state, array, 'SCALAR', target.name + '_index', false);
            }
            const length = geo && geo.attributes.position
                ? geo.attributes.position.array.length / 3 : 0;
            offset += length;
            primitive.material = await makeMaterial(state, target);
            primitive.mode = 4;
            if (morph) {
                primitive.extras = { targetNames: morph.targetNames };
                primitive.targets = morph.targets;
            }
            mesh.primitives.push(primitive);
            continue;
        }

        const fullIndex = geo.index.array;
        const vertCount = geo.attributes.position.array.length / 3;
        const { matList, remap } = exportMaterialList(target);
        try {
            const eyeish = matList.some(m => m && /eye|iris|highlight|pupil|瞳|目/i.test(m.name || ""));
            if (eyeish && geo.attributes && geo.attributes.position) {
                const pos = geo.attributes.position.array;
                // Denormalize UV for diagnostics (same bug as export path)
                const uvAttr = geo.attributes.uv;
                const uv = uvAttr ? copyAttrArray(uvAttr) : null;
                const idx = geo.index && geo.index.array;
                let umin=1,umax=0,vmin=1,vmax=0;
                let xmin=1e9,xmax=-1e9,ymin=1e9,ymax=-1e9,zmin=1e9,zmax=-1e9;
                const use = new Set();
                if (idx) {
                    for (let i = 0; i < idx.length; i++) use.add(idx[i] | 0);
                } else {
                    for (let i = 0; i < pos.length / 3; i++) use.add(i);
                }
                use.forEach(vi => {
                    const x = pos[vi*3], y = pos[vi*3+1], z = pos[vi*3+2];
                    if (x<xmin)xmin=x; if(x>xmax)xmax=x;
                    if (y<ymin)ymin=y; if(y>ymax)ymax=y;
                    if (z<zmin)zmin=z; if(z>zmax)zmax=z;
                    if (uv) {
                        const u = uv[vi*2], v = uv[vi*2+1];
                        if (u<umin)umin=u; if(u>umax)umax=u;
                        if (v<vmin)vmin=v; if(v>vmax)vmax=v;
                    }
                });
                exportLog(state, "warn", "[export][uv] eye mesh", target.name,
                    "usedVerts=", use.size,
                    "tris=", idx ? (idx.length/3)|0 : 0,
                    "uv=", umin.toFixed(3), umax.toFixed(3), vmin.toFixed(3), vmax.toFixed(3),
                    "posX=", xmin.toFixed(3), xmax.toFixed(3),
                    "posY=", ymin.toFixed(3), ymax.toFixed(3),
                    "posZ=", zmin.toFixed(3), zmax.toFixed(3),
                    "hasSkin=", !!(target.skeleton),
                    "parent=", target.parent && target.parent.name,
                    uvAttr && uvAttr.normalized ? "uvWasNorm=1" : "uvWasNorm=0");
            }
        } catch (e) { console.warn("[export][uv]", e); }
        const rawGroups = (geo.groups && geo.groups.length > 0)
            ? geo.groups
            : [{ start: 0, count: fullIndex.length, materialIndex: 0 }];
        // アウトライン専用スロットを除いた materialIndex にリマップ
        const groups = rawGroups.map(g => {
            const oldMi = (g.materialIndex != null) ? (g.materialIndex | 0) : 0;
            let newMi = (oldMi >= 0 && oldMi < remap.length) ? remap[oldMi] : 0;
            if (newMi < 0) newMi = 0;
            return { start: g.start, count: g.count, materialIndex: newMi };
        });

        // materialIndex ごとに1 primitive（分断 group を合体）。
        // アウトライン除外後に matList が1つなら groups を無視して単一 primitive。
        if (matList.length <= 1) {
            const primitive = {};
            primitive.attributes = attributes;
            primitive.name = target.name;
            const array = new fullIndex.constructor(fullIndex.length);
            for (let i = 0; i < fullIndex.length; i++) array[i] = (fullIndex[i] | 0) + offset;
            primitive.indices = addAccessor(
                state, array, 'SCALAR',
                (target.name || 'mesh') + '_index', false
            );
            primitive.material = await makeMaterialFromThree(state, matList[0], target.renderOrder);
            primitive.mode = 4;
            if (morph) {
                primitive.extras = { targetNames: morph.targetNames };
                primitive.targets = morph.targets;
            }
            mesh.primitives.push(primitive);
        } else {
            const byMat = coalesceGroupsByMaterial(groups, fullIndex);
            for (let pi = 0; pi < byMat.length; pi++) {
                const { materialIndex, indices } = byMat[pi];
                if (!indices.length) continue;
                const array = new fullIndex.constructor(indices.length);
                for (let i = 0; i < indices.length; i++) array[i] = (indices[i] | 0) + offset;

                const primitive = {};
                primitive.attributes = attributes;
                primitive.name = byMat.length > 1
                    ? (target.name + '_g' + pi)
                    : target.name;
                primitive.indices = addAccessor(
                    state, array, 'SCALAR',
                    (target.name || 'mesh') + '_g' + pi + '_index', false
                );
                const mat = matList[materialIndex] || matList[0];
                primitive.material = await makeMaterialFromThree(state, mat, target.renderOrder);
                primitive.mode = 4;
                if (morph) {
                    primitive.extras = { targetNames: morph.targetNames };
                    primitive.targets = morph.targets;
                }
                mesh.primitives.push(primitive);
            }
        }
        offset += vertCount;
    }
    const index = state.meshes.length;
    state.meshes.push(mesh);
    state.meshMap.set(targets[0], index);
    return index;
    } finally {
        geoRestore.forEach(({ t, g }) => { try { t.geometry = g; } catch (e) {} });
    }
}

export function makeSkin(state, targets) {
    if (!targets[0].skeleton) return null;
    const skin = {};
    skin.name = targets[0].name;
    skin.joints = targets[0].skeleton.bones.map(bone => state.nodeMap.get(bone));
    // Warn if any joint is missing (would collapse the mesh in most loaders)
    if (skin.joints.some(j => j == null)) {
        console.warn("[export] makeSkin: some bones not in nodeMap for", skin.name,
            "nullCount=", skin.joints.filter(j => j == null).length);
    }
    const matrices = [];
    for (const boneInverse of targets[0].skeleton.boneInverses) {
        const array = boneInverse.toArray().slice();
        if (state.flipAxis) {
            for (let i = 0; i < array.length; i += 16) {
                // Translation
                array[i + 12] = -array[i + 12];
                array[i + 14] = -array[i + 14];
                // Rotation
                array[i + 1] = -array[i + 1];
                array[i + 4] = -array[i + 4];
                array[i + 6] = -array[i + 6];
                array[i + 9] = -array[i + 9];
            }
        }
        matrices.push(...array);
    }
    const array = new Float32Array(matrices);
    skin.inverseBindMatrices = addAccessor(state, array, 'MAT4', skin.name + "_inverse", false, false);
    //skin.extensions = {};
    //skin.extras = {};

    const index = state.skins.length;
    state.skins.push(skin);
    return index;
}

/**
 * three-vrm が描画用に足すアウトライン専用マテリアルか。
 * 本体マテリアルと別スロットで material[] に載るが、ファイル上は同一 MToon の
 * outline パラメータとして書くべきで、別 primitive / 別 material にすると
 * 再ロード時にメッシュ数・マテリアル数が増える（例: 7→12）。
 */
