/**
 * body-vrm-export.js
 * 元 VRM の humanoid ノード scale を、現在の VRM シーン上の raw bone scale で上書きして保存。
 * （ビューア上の体型と一致させる）
 */

export function parseGlb(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("GLB ではありません");
  if (view.getUint32(4, true) !== 2) throw new Error("GLB version 2 のみ対応");
  let offset = 12;
  let json = null;
  let bin = null;
  while (offset < buffer.byteLength) {
    const chunkLen = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkData = buffer.slice(offset + 8, offset + 8 + chunkLen);
    if (chunkType === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(chunkData));
    } else if (chunkType === 0x004e4942) {
      bin = chunkData;
    }
    offset += 8 + chunkLen;
  }
  if (!json) throw new Error("GLB に JSON チャンクがありません");
  return { json, bin };
}

function findHumanoidBoneNodeIndices(json) {
  const map = new Map();
  const exts = json.extensions || {};
  const vrmc = exts.VRMC_vrm;
  if (vrmc?.humanoid?.humanBones) {
    for (const [name, info] of Object.entries(vrmc.humanoid.humanBones)) {
      if (info && typeof info.node === "number") map.set(name, info.node);
    }
  }
  const vrm0 = exts.VRM;
  if (vrm0?.humanoid?.humanBones) {
    for (const bone of vrm0.humanoid.humanBones) {
      if (bone && typeof bone.node === "number" && bone.bone) {
        map.set(bone.bone, bone.node);
      }
    }
  }
  return map;
}

function packGlb(json, bin) {
  const jsonText = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPadding;
  const binBytes = bin ? new Uint8Array(bin) : new Uint8Array(0);
  const binPadding = binBytes.length ? (4 - (binBytes.length % 4)) % 4 : 0;
  const binChunkLen = binBytes.length + binPadding;
  const totalLen = 12 + 8 + jsonChunkLen + (binBytes.length ? 8 + binChunkLen : 0);
  const out = new ArrayBuffer(totalLen);
  const outView = new DataView(out);
  const outArr = new Uint8Array(out);
  let o = 0;
  outView.setUint32(o, 0x46546c67, true); o += 4;
  outView.setUint32(o, 2, true); o += 4;
  outView.setUint32(o, totalLen, true); o += 4;
  outView.setUint32(o, jsonChunkLen, true); o += 4;
  outView.setUint32(o, 0x4e4f534a, true); o += 4;
  outArr.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < jsonPadding; i++) outArr[o++] = 0x20;
  if (binBytes.length) {
    outView.setUint32(o, binChunkLen, true); o += 4;
    outView.setUint32(o, 0x004e4942, true); o += 4;
    outArr.set(binBytes, o); o += binBytes.length;
    for (let i = 0; i < binPadding; i++) outArr[o++] = 0;
  }
  return out;
}

/**
 * @param {ArrayBuffer} originalBuffer
 * @param {object} vrm three-vrm VRM instance (scales already applied)
 * @param {{
 *   height?: number,
 *   build?: number,
 *   scaleMap?: Map<string, number[]>,
 *   rotMap?: Map<string, number[]>,
 * }} rootParams
 *   scaleMap: boneName -> [sx,sy,sz]
 *   rotMap:   boneName -> [qx,qy,qz,qw]  (rest pose + spine curve etc.)
 */
export function exportBodyShapedVrm(originalBuffer, vrm, rootParams = {}) {
  const { json, bin } = parseGlb(originalBuffer);
  const nodes = json.nodes || [];
  const boneMap = findHumanoidBoneNodeIndices(json);

  const height = rootParams.height ?? 1;
  const build = rootParams.build ?? 1;
  if (json.scenes?.[0]?.nodes?.[0] != null) {
    const rootIdx = json.scenes[0].nodes[0];
    const root = nodes[rootIdx];
    if (root) {
      const prev = root.scale || [1, 1, 1];
      root.scale = [prev[0] * build, prev[1] * height, prev[2] * build];
    }
  }

  const scaleMap = rootParams.scaleMap;
  const rotMap = rootParams.rotMap;
  const humanoid = vrm?.humanoid;
  if (scaleMap || rotMap || humanoid) {
    for (const [boneName, nodeIdx] of boneMap.entries()) {
      const node = nodes[nodeIdx];
      if (!node) continue;

      // --- scale ---
      let sx, sy, sz;
      let haveScale = false;
      if (scaleMap && scaleMap.has(boneName)) {
        const s = scaleMap.get(boneName);
        sx = s[0]; sy = s[1]; sz = s[2];
        haveScale = true;
      } else if (humanoid) {
        let src = null;
        try { src = humanoid.getRawBoneNode?.(boneName); } catch (_) {}
        if (!src) {
          try { src = humanoid.humanBones?.[boneName]?.node; } catch (_) {}
        }
        if (src?.scale) {
          sx = src.scale.x; sy = src.scale.y; sz = src.scale.z;
          haveScale = true;
        }
      }
      if (haveScale) {
        if (Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6 || Math.abs(sz - 1) > 1e-6) {
          node.scale = [sx, sy, sz];
        } else if (node.scale) {
          delete node.scale;
        }
      }

      // --- rotation (spine curve baked into rest) ---
      // glTF node.rotation is [x, y, z, w] quaternion.
      if (rotMap && rotMap.has(boneName)) {
        const q = rotMap.get(boneName);
        const [qx, qy, qz, qw] = q;
        if (
          Math.abs(qx) > 1e-6 ||
          Math.abs(qy) > 1e-6 ||
          Math.abs(qz) > 1e-6 ||
          Math.abs(qw - 1) > 1e-6
        ) {
          node.rotation = [qx, qy, qz, qw];
        }
      }
    }
  }

  return packGlb(json, bin);
}

export async function toArrayBuffer(fileOrBuffer) {
  if (fileOrBuffer instanceof ArrayBuffer) return fileOrBuffer;
  if (ArrayBuffer.isView(fileOrBuffer)) {
    return fileOrBuffer.buffer.slice(
      fileOrBuffer.byteOffset,
      fileOrBuffer.byteOffset + fileOrBuffer.byteLength,
    );
  }
  if (typeof fileOrBuffer?.arrayBuffer === "function") {
    return await fileOrBuffer.arrayBuffer();
  }
  throw new Error("ArrayBuffer に変換できません");
}
