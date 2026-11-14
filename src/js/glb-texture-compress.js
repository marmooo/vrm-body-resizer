/**
 * GLB/VRM 内の image を WebP / JPEG / PNG で再エンコードし、BIN を詰め直す。
 * bufferView 参照の画像のみ対象（uri / KTX2 はスキップ）。
 */
import { parseGlb } from "./body-vrm-export.js";

function packGlb(json, binBytes) {
  const jsonText = JSON.stringify(json);
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPadding;
  const bin = binBytes instanceof Uint8Array ? binBytes : new Uint8Array(binBytes || 0);
  const binPadding = bin.byteLength ? (4 - (bin.byteLength % 4)) % 4 : 0;
  const binChunkLen = bin.byteLength + binPadding;
  const totalLen = 12 + 8 + jsonChunkLen + (bin.byteLength ? 8 + binChunkLen : 0);
  const out = new ArrayBuffer(totalLen);
  const dv = new DataView(out);
  const ua = new Uint8Array(out);
  let o = 0;
  dv.setUint32(o, 0x46546c67, true); o += 4;
  dv.setUint32(o, 2, true); o += 4;
  dv.setUint32(o, totalLen, true); o += 4;
  dv.setUint32(o, jsonChunkLen, true); o += 4;
  dv.setUint32(o, 0x4e4f534a, true); o += 4;
  ua.set(jsonBytes, o); o += jsonBytes.length;
  for (let i = 0; i < jsonPadding; i++) ua[o++] = 0x20;
  if (bin.byteLength) {
    dv.setUint32(o, binChunkLen, true); o += 4;
    dv.setUint32(o, 0x004e4942, true); o += 4;
    ua.set(bin, o); o += bin.byteLength;
    for (let i = 0; i < binPadding; i++) ua[o++] = 0;
  }
  return out;
}

function encodeCanvas(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    // webp 非対応ブラウザ向けフォールバック
    const tryMime = mime;
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error("toBlob failed: " + tryMime));
        blob.arrayBuffer().then((ab) => resolve({ bytes: new Uint8Array(ab), mime: blob.type || tryMime }), reject);
      },
      tryMime,
      quality,
    );
  });
}

/**
 * @returns {Promise<{ buffer: ArrayBuffer, stats: object }>}
 */
export async function compressGlbTextures(buffer, opts = {}) {
  const textureScale = opts.textureScale ?? 1;
  const mode = opts.textureCompressMode || "whenNeeded";
  const format = opts.textureFormat || "webp";
  const quality = opts.textureQuality ?? 0.92;
  const debugFast = !!opts.debugFast;
  const verbose = !!opts.verbose;

  const needScale = textureScale < 0.999;
  const needAlways = mode === "always";

  if (!debugFast && !needScale && !needAlways) {
    return { buffer, stats: { skipped: true, reason: "no compress needed" } };
  }

  const { json, bin } = parseGlb(buffer);
  if (!json.images?.length) {
    return { buffer, stats: { skipped: true, reason: "no images" } };
  }
  if (!bin) {
    return { buffer, stats: { skipped: true, reason: "no bin" } };
  }

  const binArr = new Uint8Array(bin);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  /** @type {Map<number, Uint8Array>} bufferViewIndex -> new bytes */
  const bvReplacement = new Map();
  /** @type {Map<number, string>} imageIndex -> mime */
  const imgMime = new Map();

  let encoded = 0;
  let skipped = 0;
  let savedBytes = 0;
  let beforeBytes = 0;
  let afterBytes = 0;

  for (let i = 0; i < json.images.length; i++) {
    const img = json.images[i];
    if (img.uri && img.bufferView == null) {
      skipped++;
      if (verbose) console.warn("[tex] skip uri image", i);
      continue;
    }
    if (img.bufferView == null) {
      skipped++;
      continue;
    }
    const bv = json.bufferViews?.[img.bufferView];
    if (!bv) {
      skipped++;
      continue;
    }

    const srcMime = (img.mimeType || "").toLowerCase();
    if (srcMime.includes("ktx") || srcMime.includes("basis")) {
      skipped++;
      if (verbose) console.warn("[tex] skip basis/ktx", i);
      continue;
    }

    const start = bv.byteOffset || 0;
    const len = bv.byteLength || 0;
    const srcBytes = binArr.subarray(start, start + len);
    beforeBytes += srcBytes.byteLength;

    if (debugFast) {
      const c = document.createElement("canvas");
      c.width = 1;
      c.height = 1;
      const x = c.getContext("2d");
      x.fillStyle = "#fff";
      x.fillRect(0, 0, 1, 1);
      const { bytes, mime } = await encodeCanvas(c, "image/png", 1);
      bvReplacement.set(img.bufferView, bytes);
      imgMime.set(i, mime);
      afterBytes += bytes.byteLength;
      savedBytes += srcBytes.byteLength - bytes.byteLength;
      encoded++;
      continue;
    }

    let bitmap;
    try {
      const blob = new Blob([srcBytes], {
        type: srcMime || "image/png",
      });
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      skipped++;
      if (verbose) console.warn("[tex] decode fail", i, e);
      afterBytes += srcBytes.byteLength;
      continue;
    }

    const w = Math.max(1, Math.round(bitmap.width * textureScale));
    const h = Math.max(1, Math.round(bitmap.height * textureScale));
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    try {
      bitmap.close();
    } catch (_) {}

    let hasAlpha = false;
    try {
      const sampleW = Math.min(w, 48);
      const sampleH = Math.min(h, 48);
      const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
      for (let p = 3; p < data.length; p += 16) {
        if (data[p] < 250) {
          hasAlpha = true;
          break;
        }
      }
    } catch (_) {
      hasAlpha = true;
    }

    let outMime;
    if (format === "webp") {
      outMime = "image/webp";
    } else {
      outMime = hasAlpha ? "image/png" : "image/jpeg";
    }

    let result;
    try {
      result = await encodeCanvas(canvas, outMime, quality);
      // Safari 等で webp が image/png にフォールバックすることがある
      if (format === "webp" && result.mime && !result.mime.includes("webp")) {
        if (verbose) console.warn("[tex] webp unsupported, got", result.mime, "image", i);
      }
    } catch (e) {
      // webp 失敗時は png/jpeg へ
      try {
        outMime = hasAlpha ? "image/png" : "image/jpeg";
        result = await encodeCanvas(canvas, outMime, quality);
      } catch (e2) {
        skipped++;
        if (verbose) console.warn("[tex] encode fail", i, e2);
        afterBytes += srcBytes.byteLength;
        continue;
      }
    }

    const outBytes = result.bytes;
    // 解像度を下げている、または常に圧縮、または確実に小さくなった場合のみ採用
    const accept =
      needScale ||
      debugFast ||
      outBytes.byteLength < srcBytes.byteLength * 0.98;

    if (!accept) {
      skipped++;
      afterBytes += srcBytes.byteLength;
      if (verbose) {
        console.info(
          `[tex] #${i} keep original (${outBytes.byteLength} >= ${srcBytes.byteLength})`,
        );
      }
      continue;
    }

    bvReplacement.set(img.bufferView, outBytes);
    imgMime.set(i, result.mime || outMime);
    afterBytes += outBytes.byteLength;
    savedBytes += srcBytes.byteLength - outBytes.byteLength;
    encoded++;
    if (verbose) {
      console.info(
        `[tex] #${i} ${srcBytes.byteLength} → ${outBytes.byteLength} (${result.mime || outMime}) ${w}x${h}`,
      );
    }
  }

  if (!bvReplacement.size) {
    return {
      buffer,
      stats: {
        encoded: 0,
        skipped,
        savedBytes: 0,
        beforeBytes,
        afterBytes: beforeBytes,
        reason: "no replacements",
      },
    };
  }

  // MIME 更新
  for (const [idx, mime] of imgMime.entries()) {
    if (json.images[idx]) json.images[idx].mimeType = mime;
  }

  // BIN を bufferView 順に詰め直す
  const newParts = [];
  const newOffsets = new Map();
  let pos = 0;
  const viewCount = json.bufferViews?.length || 0;
  for (let bi = 0; bi < viewCount; bi++) {
    const bv = json.bufferViews[bi];
    if (!bv) continue;
    let bytes;
    if (bvReplacement.has(bi)) {
      bytes = bvReplacement.get(bi);
    } else {
      const s = bv.byteOffset || 0;
      const l = bv.byteLength || 0;
      bytes = binArr.subarray(s, s + l);
    }
    if (pos % 4 !== 0) pos += 4 - (pos % 4);
    newOffsets.set(bi, { offset: pos, length: bytes.byteLength });
    newParts.push({ offset: pos, bytes });
    pos += bytes.byteLength;
  }
  if (pos % 4 !== 0) pos += 4 - (pos % 4);

  const newBin = new Uint8Array(pos);
  for (const part of newParts) {
    newBin.set(part.bytes, part.offset);
  }
  for (let bi = 0; bi < viewCount; bi++) {
    const bv = json.bufferViews[bi];
    const info = newOffsets.get(bi);
    if (!bv || !info) continue;
    bv.byteOffset = info.offset;
    bv.byteLength = info.length;
  }
  if (json.buffers?.[0]) {
    json.buffers[0].byteLength = newBin.byteLength;
  }

  const outBuffer = packGlb(json, newBin);
  const stats = {
    encoded,
    skipped,
    savedBytes,
    beforeBytes,
    afterBytes,
    outSize: outBuffer.byteLength,
    inSize: buffer.byteLength,
  };
  if (verbose) console.info("[tex] done", stats);
  return { buffer: outBuffer, stats };
}
