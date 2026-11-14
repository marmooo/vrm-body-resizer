/**
 * Morpholith export — differential / patch path.
 *
 * When the loaded VRM is almost unchanged (no body-scale bake, no texture
 * recompress, no solid-fill materials), rebuild from the original GLB bytes
 * and only rewrite what is safe:
 *   - VRM1: node TRS from the live scene + drop hidden mesh nodes
 *   - VRM0: never copy live TRS (rotateVRM0 axis risk); identity or hide-only
 * Geometry / image bufferViews stay bit-identical to the source file.
 */
import { align4 } from "./constants.js";
import { splitBuffer, bindBuffers } from "./conversion.js";

/**
 * @param {ArrayBuffer} originalBuffer  raw GLB/VRM bytes from load
 * @param {THREE.Object3D} root         current VRM scene root
 * @param {object} [opts]
 * @param {string[]} [opts.hiddenMeshNames]  mesh node names to strip from scenes
 * @param {boolean} [opts.updateNodeTRS]  rewrite translation/rotation/scale
 *        (default: true for VRM1, forced false for VRM0)
 * @returns {ArrayBuffer|null} patched GLB, or null if patch is not possible
 */
export function tryPatchExport(originalBuffer, root, opts = {}) {
    if (!originalBuffer || !root) return null;

    let parts;
    try {
        parts = splitBuffer(originalBuffer);
    } catch (e) {
        console.warn("[export][patch] splitBuffer failed", e);
        return null;
    }
    if (!parts || !parts.jsonChunkData || !parts.binChunkData) return null;

    let json;
    try {
        json = JSON.parse(new TextDecoder().decode(parts.jsonChunkData));
    } catch (e) {
        console.warn("[export][patch] JSON parse failed", e);
        return null;
    }

    const hasVrm0 = !!(json.extensions && json.extensions.VRM);
    const hasVrm1 = !!(json.extensions && json.extensions.VRMC_vrm)
        || (Array.isArray(json.extensionsUsed) && json.extensionsUsed.includes("VRMC_vrm"));
    const isVrm0Only = hasVrm0 && !hasVrm1;

    // Hidden mesh names from app + currently invisible meshes still in graph
    const hidden = new Set(opts.hiddenMeshNames || []);
    try {
        root.traverse((obj) => {
            if (obj && obj.isMesh && obj.visible === false && obj.name) {
                hidden.add(obj.name);
            }
        });
    } catch (e) {}

    // --- Identity fast path: nothing to change → return original bytes ---
    if (hidden.size === 0 && opts.forceIdentity !== false) {
        // Still allow explicit TRS update request for VRM1; if caller asked for
        // TRS and is VRM1 we continue below. If VRM0 or updateNodeTRS===false,
        // identity is the correct answer for "no edits".
        const wantTRS = opts.updateNodeTRS === true && !isVrm0Only;
        if (!wantTRS) {
            console.warn("[export][patch] identity — return original buffer, bytes=",
                originalBuffer.byteLength);
            return originalBuffer.slice(0);
        }
    }

    // VRM0: only hide-meshes patch is safe (no live TRS write-back).
    const updateTRS = !isVrm0Only && opts.updateNodeTRS !== false;
    if (isVrm0Only && opts.updateNodeTRS === true) {
        console.warn("[export][patch] VRM0: TRS write-back disabled (rotateVRM0 axis risk)");
    }

    const nodes = json.nodes || [];
    if (!nodes.length) return null;

    const nameToIndices = new Map();
    nodes.forEach((n, i) => {
        if (!n || !n.name) return;
        let list = nameToIndices.get(n.name);
        if (!list) {
            list = [];
            nameToIndices.set(n.name, list);
        }
        list.push(i);
    });

    let trsUpdated = 0;
    if (updateTRS) {
        const sceneByName = new Map();
        try {
            root.updateMatrixWorld(true);
            root.traverse((obj) => {
                if (!obj || !obj.name) return;
                if (!sceneByName.has(obj.name)) sceneByName.set(obj.name, obj);
            });
        } catch (e) {
            console.warn("[export][patch] scene traverse failed", e);
            return null;
        }
        for (const [name, indices] of nameToIndices) {
            const obj = sceneByName.get(name);
            if (!obj) continue;
            for (const idx of indices) {
                const node = nodes[idx];
                if (!node) continue;
                writeNodeTRS(node, obj);
                trsUpdated++;
            }
        }
    }

    let hiddenCleared = 0;
    if (hidden.size) {
        const hideNodeIndices = new Set();
        for (const name of hidden) {
            const indices = nameToIndices.get(name);
            if (!indices) continue;
            for (const idx of indices) {
                const node = nodes[idx];
                if (!node) continue;
                if (node.mesh != null) {
                    delete node.mesh;
                    hiddenCleared++;
                }
                hideNodeIndices.add(idx);
            }
        }
        if (hideNodeIndices.size) {
            stripNodesFromScenes(json, hideNodeIndices);
        }
    }

    // If we neither updated TRS nor hid anything, still identity
    if (trsUpdated === 0 && hiddenCleared === 0) {
        console.warn("[export][patch] identity (no TRS/hide changes) — original buffer");
        return originalBuffer.slice(0);
    }

    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(JSON.stringify(json));
    const jsonChunkData = new Uint8Array(align4(jsonBytes.length));
    jsonChunkData.set(jsonBytes);
    jsonChunkData.fill(0x20, jsonBytes.length);

    const glb = bindBuffers({
        jsonChunkData: jsonChunkData.buffer,
        binChunkData: parts.binChunkData
    });

    console.warn("[export][patch] ok — vrm0=", isVrm0Only,
        "TRS updated=", trsUpdated,
        "hidden mesh cleared=", hiddenCleared,
        "glb≈", Math.round((glb && glb.byteLength || 0) / 1024), "KB",
        "(bin unchanged)");

    return glb;
}

function writeNodeTRS(node, obj) {
    const p = obj.position;
    const q = obj.quaternion;
    const s = obj.scale;

    const near0 = (v) => Math.abs(v) < 1e-7;
    const near1 = (v) => Math.abs(v - 1) < 1e-7;

    if (near0(p.x) && near0(p.y) && near0(p.z)) {
        delete node.translation;
    } else {
        node.translation = [p.x, p.y, p.z];
    }

    if (near0(q.x) && near0(q.y) && near0(q.z) && near1(q.w)) {
        delete node.rotation;
    } else {
        node.rotation = [q.x, q.y, q.z, q.w];
    }

    if (near1(s.x) && near1(s.y) && near1(s.z)) {
        delete node.scale;
    } else {
        node.scale = [s.x, s.y, s.z];
    }
}

function stripNodesFromScenes(json, hideNodeIndices) {
    const scenes = json.scenes || [];
    for (const scene of scenes) {
        if (!scene || !Array.isArray(scene.nodes)) continue;
        scene.nodes = scene.nodes.filter((i) => !hideNodeIndices.has(i));
    }
    const nodes = json.nodes || [];
    for (const node of nodes) {
        if (!node || !Array.isArray(node.children)) continue;
        node.children = node.children.filter((i) => !hideNodeIndices.has(i));
        if (node.children.length === 0) delete node.children;
    }
}

export function isPatchCandidateMeta(jsonOrNull) {
    // Both VRM0 and VRM1 can use identity / hide-only patch.
    return !!jsonOrNull;
}
