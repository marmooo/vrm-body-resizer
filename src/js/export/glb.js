/**
 * Morpholith export — pack state into a GLB ArrayBuffer.
 */
import { align4 } from "./constants.js";
import { bindBuffers } from "./conversion.js";

export function makeGlb(state) {
    state.buffer = new Uint8Array(state.offset);
    for (let i = 0; i < state.bufferViews.length; i++) {
        const src = state.buffers[i];
        // Use the typed-array view bounds (not the whole underlying ArrayBuffer)
        const bytes = (src.buffer && src.byteLength != null)
            ? new Uint8Array(src.buffer, src.byteOffset || 0, src.byteLength)
            : new Uint8Array(src);
        state.buffer.set(bytes, state.bufferViews[i].byteOffset);
    }

    const s = state;
    const j = {};
    j.asset = s.asset;
    j.accessors = s.accessors;
    j.bufferViews = s.bufferViews;
    // CRITICAL: byteLength must match the BIN chunk we actually write.
    // Never use state.buffer.buffer.byteLength (may be larger than the view).
    j.buffers = [{ byteLength: state.buffer.byteLength }];
    j.extensions = {};
    if (state.metaVersion == 0) {
        j.extensions.VRM = s.extensions.VRM;
    } else {
        j.extensions.VRMC_vrm = s.extensions.VRMC_vrm;
        j.extensions.VRMC_springBone = s.extensions.VRMC_springBone;
    }
    j.extensionsUsed = s.extensionsUsed;
    if (s.extensionsRequired && s.extensionsRequired.length)
        j.extensionsRequired = s.extensionsRequired;
    j.images = s.images;
    j.materials = s.materials;
    j.meshes = s.meshes;
    j.nodes = s.nodes;
    j.samplers = s.samplers;
    j.scene = s.scene;
    j.scenes = s.scenes;
    j.skins = s.skins;
    j.textures = s.textures;

    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(JSON.stringify(j));

    const jsonBuffer = new Uint8Array(align4(jsonBytes.length));
    jsonBuffer.set(jsonBytes);
    jsonBuffer.fill(0x20, jsonBytes.length);
    // Pass precise ArrayBuffers — not .buffer of a possibly-larger underlying AB.
    // Using the raw .buffer was a candidate cause of texture/BIN misalignment
    // after hybrid-seed (black eyes / missing skin when reloaded).
    const jsonChunkData = jsonBuffer.buffer.slice(
        jsonBuffer.byteOffset,
        jsonBuffer.byteOffset + jsonBuffer.byteLength
    );
    const binChunkData = state.buffer.buffer.slice(
        state.buffer.byteOffset,
        state.buffer.byteOffset + state.buffer.byteLength
    );
    const glb = bindBuffers({ jsonChunkData, binChunkData });
    return glb;
}
