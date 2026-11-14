/**
 * Morpholith export — image / texture encoding, passthrough, dedupe.
 */
import { DEFAULT_EXPORT_OPTIONS } from "./options.js";
import { addBufferView, addSampler } from "./core.js";
import { lookupSeededImage } from "./seed-assets.js";
import { exportLog } from "./log.js";

export function isDrawableImageSource(img) {
    if (!img) return false;
    if (typeof HTMLCanvasElement !== "undefined" && img instanceof HTMLCanvasElement) return true;
    if (typeof OffscreenCanvas !== "undefined" && img instanceof OffscreenCanvas) return true;
    if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return !!(img.complete && img.naturalWidth);
    if (typeof HTMLVideoElement !== "undefined" && img instanceof HTMLVideoElement) return img.videoWidth > 0;
    if (typeof ImageBitmap !== "undefined" && img instanceof ImageBitmap) return img.width > 0;
    if (typeof ImageData !== "undefined" && img instanceof ImageData) return true;
    // Plain {width,height,data} DataTexture payload — not drawable via drawImage
    return false;
}

/** Convert DataTexture-like {data,width,height} into a canvas. */
export function dataTexToCanvas(img) {
    if (!img || !img.data || !img.width || !img.height) return null;
    try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const data = img.data;
        let clamped;
        if (data instanceof Uint8ClampedArray) clamped = data;
        else if (data instanceof Uint8Array) clamped = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
        else return null;
        // Expect RGBA; if RGB only, expand
        const expected = img.width * img.height * 4;
        if (clamped.length < expected) return null;
        const imageData = new ImageData(clamped.length === expected ? clamped : new Uint8ClampedArray(clamped.buffer, clamped.byteOffset, expected), img.width, img.height);
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    } catch (e) {
        return null;
    }
}

export function imageBitmapToEncoded(imageBitmap, mimeType, quality, flipY, textureScale) {
    return new Promise((resolve, reject) => {
        let src = imageBitmap;
        if (!isDrawableImageSource(src)) {
            const asCanvas = dataTexToCanvas(src);
            if (asCanvas) src = asCanvas;
            else {
                reject(new Error("imageBitmapToEncoded: not a drawable image source"));
                return;
            }
        }
        const scale = Math.max(0.05, Math.min(1, textureScale == null ? 1 : textureScale));
        let w = Math.max(1, Math.round((src.width || src.videoWidth || 1) * scale));
        let h = Math.max(1, Math.round((src.height || src.videoHeight || 1) * scale));
        // Keep dimensions even (some GPU paths prefer it)
        if (w > 1 && (w % 2)) w -= 1;
        if (h > 1 && (h % 2)) h -= 1;
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext("2d");
        if (flipY) {
            ctx.translate(0, canvas.height);
            ctx.scale(1, -1);
        }
        // JPEG has no alpha — fill white behind so transparent edges don't go black
        if (mimeType === "image/jpeg") {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        try {
            ctx.drawImage(src, 0, 0, w, h);
        } catch (e) {
            reject(e);
            return;
        }

        const q = (typeof quality === "number" && isFinite(quality)) ? quality : 0.92;
        // PNG ignores quality; JPEG / WebP use it. WebP quality 1.0 ≈ near-lossless.
        const tryTypes = [mimeType];
        if (mimeType === "image/webp") {
            // Fallback chain if browser lacks WebP encode
            tryTypes.push("image/png");
        }
        const attempt = (idx) => {
            if (idx >= tryTypes.length) {
                reject(new Error("canvas.toBlob failed for " + mimeType));
                return;
            }
            const type = tryTypes[idx];
            const args = (type === "image/jpeg" || type === "image/webp") ? [type, q] : [type];
            if (type === "image/jpeg") {
                // ensure white underlay if we switched to jpeg mid-way
                try {
                    const img = ctx.getImageData(0, 0, w, h);
                    // no-op; underlay already applied when mime was jpeg at start
                } catch (e) {}
            }
            canvas.toBlob(async (blob) => {
                if (!blob) { attempt(idx + 1); return; }
                // Stash actual mime on the ArrayBuffer for addImage to read
                const buf = await blob.arrayBuffer();
                buf.__exportMime = blob.type || type;
                resolve(buf);
            }, ...args);
        };
        attempt(0);
    });
}

/**
 * Decide mime + quality from export options.
 * @param {object} opts
 * @param {boolean} forceLossless  cutout / solid bake / shade maps that must stay exact
 * @param {boolean} [preferAlpha]  known alpha map
 */
export function resolveImageEncodePlan(opts, forceLossless, preferAlpha) {
    const mode = opts.textureCompressMode || "whenNeeded";
    const format = opts.textureFormat || "webp";
    const quality = (opts.textureQuality != null)
        ? opts.textureQuality
        : (opts.jpegQuality != null ? opts.jpegQuality : 0.92);
    const scale = opts.textureScale != null ? opts.textureScale : 1;
    const needsResize = scale < 0.999;
    // Canvas 再エンコード時は常に有損品質を使う。
    // 以前は whenNeeded + 非リサイズで quality:1.0（lossless WebP）になり、
    // パススルー失敗時に数倍のサイズ・極端な遅さになっていた。
    // 元バイトがあるときは tryPassthrough でそのまま返す（色ズレなし）。
    if (forceLossless) {
        return { mimeType: "image/png", quality: undefined, preferPassthrough: true };
    }
    if (format === "webp") {
        return {
            mimeType: "image/webp",
            quality: Math.min(0.95, Math.max(0.5, quality)),
            preferPassthrough: (mode === "whenNeeded" && !needsResize)
        };
    }
    // png-jpeg
    if (preferAlpha) {
        return { mimeType: "image/png", quality: undefined, preferPassthrough: mode === "whenNeeded" && !needsResize };
    }
    return {
        mimeType: "image/jpeg",
        quality: Math.min(0.95, Math.max(0.5, quality)),
        preferPassthrough: (mode === "whenNeeded" && !needsResize)
    };
}

export function textureImageSource(tex) {
    if (!tex) return null;
    let img = null;
    if (tex.source && tex.source.data) img = tex.source.data;
    else if (tex.image) img = tex.image;
    if (!img) return null;
    if (isDrawableImageSource(img)) return img;
    // DataTexture payload → canvas
    const c = dataTexToCanvas(img);
    if (c) return c;
    return null;
}

/**
 * Build a canvas: RGB = solid colour (or white), A = cutout mask from src image.
 * @param {CanvasImageSource} srcImage
 * @param {"alpha"|"red"|"luminance"} [channel="alpha"]
 *   "alpha"     = image A channel (true cutout maps)
 *   "red"       = image R channel (three.js alphaMap convention)
 *   "luminance" = invert luminance (dark ink on opaque atlas → high A)
 *                 — required for brows/lashes painted only in RGB on a face atlas.
 * Colour is baked into RGB so loaders that ignore baseColorFactor / _Color still
 * show the fill; omit rgbColor for pure white+A.
 */
export function bakeWhiteAlphaCanvas(srcImage, channel, rgbColor) {
    if (!srcImage) return null;
    let w = srcImage.width || srcImage.videoWidth || 0;
    let h = srcImage.height || srcImage.videoHeight || 0;
    if (!w || !h) return null;
    // Cap solid-cutout texture size to avoid multi-MB exports when the source
    // atlas is 2K/4K. Nail / brow solid fills only need a coarse mask for shape.
    const MAX_SOLID = 512;
    if (w > MAX_SOLID || h > MAX_SOLID) {
        const scale = MAX_SOLID / Math.max(w, h);
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
    }
    const mode = (channel === "red" || channel === "luminance") ? channel : "alpha";
    // Optional solid RGB (0-255). When set, colour lives in the texture so
    // loaders that ignore baseColorFactor / _Color still show the fill.
    let rr = 255, gg = 255, bb = 255;
    if (rgbColor) {
        rr = Math.max(0, Math.min(255, Math.round((rgbColor.r != null ? rgbColor.r : 1) * 255)));
        gg = Math.max(0, Math.min(255, Math.round((rgbColor.g != null ? rgbColor.g : 1) * 255)));
        bb = Math.max(0, Math.min(255, Math.round((rgbColor.b != null ? rgbColor.b : 1) * 255)));
    }
    try {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.drawImage(srcImage, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const d = imgData.data;
        for (let i = 0; i < d.length; i += 4) {
            let a;
            if (mode === "red") {
                a = d[i];
            } else if (mode === "luminance") {
                // Match estimate/editors-color.js bakeSolidColorAlphaTexture
                const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                const inv = 255 - lum;
                a = Math.max(d[i + 3] < 250 ? d[i + 3] : 0, inv);
                if (lum > 245 && d[i + 3] > 250) a = 0;
            } else {
                a = d[i + 3];
            }
            // Binary alpha: solid colour or fully transparent (no black fringe)
            if (a >= 128) {
                d[i] = rr; d[i + 1] = gg; d[i + 2] = bb; d[i + 3] = 255;
            } else {
                d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0;
            }
        }
        ctx.putImageData(imgData, 0, 0);
        return canvas;
    } catch (e) {
        return null;
    }
}

/**
 * Try to recover original encoded image bytes so we can skip canvas re-encode.
 * Canvas drawImage + toBlob shifts colours (esp. hair shade / albedo).
 */
export function bufferFromUserData(ud) {
    if (!ud || !ud.buffer) return null;
    try {
        const b = ud.buffer;
        const buf = b instanceof ArrayBuffer ? b.slice(0)
            : (b.buffer ? b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + b.byteLength) : null);
        if (buf && buf.byteLength > 32) {
            buf.__exportMime = ud.mimeType || "image/png";
            return buf;
        }
    } catch (e) {}
    return null;
}

export function bufferFromSourceRegistry(textureObj, exportOptions) {
    if (!textureObj || !exportOptions) return null;
    try {
        const imgs = exportOptions.sourceImages;
        if (!imgs || !imgs.length) return null;
        let idx = null;
        if (textureObj.userData && textureObj.userData._srcImageIndex != null) {
            idx = textureObj.userData._srcImageIndex | 0;
        } else if (exportOptions.sourceTextureImageIndex
            && typeof exportOptions.sourceTextureImageIndex.get === "function"
            && textureObj.uuid) {
            const v = exportOptions.sourceTextureImageIndex.get(textureObj.uuid);
            if (v != null) idx = v | 0;
        }
        if (idx == null || idx < 0 || idx >= imgs.length) return null;
        const entry = imgs[idx];
        if (!entry || !entry.buffer || entry.buffer.byteLength < 32) return null;
        const b = entry.buffer;
        const buf = b instanceof ArrayBuffer ? b.slice(0)
            : (b.buffer ? b.buffer.slice(b.byteOffset || 0, (b.byteOffset || 0) + b.byteLength) : null);
        if (!buf || buf.byteLength < 32) return null;
        buf.__exportMime = entry.mimeType || "image/png";
        // 次回 dedupe 用に index を Texture に書き戻す
        try {
            if (!textureObj.userData) textureObj.userData = {};
            textureObj.userData._srcImageIndex = idx;
            textureObj.userData.buffer = entry.buffer;
            textureObj.userData.mimeType = entry.mimeType || "image/png";
        } catch (e) {}
        return buf;
    } catch (e) {
        return null;
    }
}

export async function tryPassthroughImageBytes(target, flipY, texScale, textureObj, exportOptions) {
    if (flipY) return null;
    if (texScale != null && texScale < 0.999) return null;
    if (!target && !textureObj) return null;

    // Skip registry when caller marked force re-encode (wrong _srcImageIndex cases)
    const forceRe = !!(textureObj && textureObj.userData && textureObj.userData._forceReencode);
    // 1) 読み込み時レジストリ（最優先）
    if (!forceRe) {
    try {
        const fromReg = bufferFromSourceRegistry(textureObj, exportOptions);
        if (fromReg) return fromReg;
    } catch (e) {}
    }

    // 2) Texture / image userData に直接付いたバッファ
    if (!forceRe) {
    try {
        const fromTex = bufferFromUserData(textureObj && textureObj.userData);
        if (fromTex) return fromTex;
    } catch (e) {}
    try {
        const fromImg = bufferFromUserData(target && target.userData);
        if (fromImg) return fromImg;
    } catch (e) {}
    }
    if (!forceRe) {
    try {
        if (target && target.source && target.source.data && target.source.data.userData) {
            const fromSrc = bufferFromUserData(target.source.data.userData);
            if (fromSrc) return fromSrc;
        }
    } catch (e) {}
    }

    // 3) HTMLImageElement の blob:/data: URL (live decoded image — OK even with forceRe)
    try {
        const srcUrl = (target && (target.src || target.currentSrc)) || null;
        if (typeof srcUrl === "string" && (srcUrl.startsWith("blob:") || srcUrl.startsWith("data:"))) {
            const res = await fetch(srcUrl);
            if (res.ok) {
                const buf = await res.arrayBuffer();
                const ct = res.headers.get("content-type") || "";
                let mime = ct.split(";")[0].trim();
                if (!mime || mime === "application/octet-stream") {
                    const u8 = new Uint8Array(buf);
                    if (u8[0] === 0x89 && u8[1] === 0x50) mime = "image/png";
                    else if (u8[0] === 0xff && u8[1] === 0xd8) mime = "image/jpeg";
                    else if (u8[0] === 0x52 && u8[1] === 0x49) mime = "image/webp";
                    else mime = "image/png";
                }
                if (buf.byteLength > 32) {
                    buf.__exportMime = mime;
                    return buf;
                }
            }
        }
    } catch (e) {}
    return null;
}

/**
 * True if this texture was generated/edited in the app (must re-encode).
 * Unmodified source textures should passthrough original glTF bytes.
 */
export function isGeneratedOrEditedTexture(textureObj, imgSrc) {
    try {
        const ud = (textureObj && textureObj.userData) || {};
        if (ud._isLipBake || ud._isSolidAlphaBake || ud._solidAlphaMode) return true;
        if (ud._exportDirty || ud._forceReencode) return true;
    } catch (e) {}
    try {
        const iud = (imgSrc && imgSrc.userData) || {};
        if (iud._isLipBake || iud._isSolidAlphaBake || iud._exportDirty) return true;
    } catch (e) {}
    try {
        if (typeof HTMLCanvasElement !== "undefined" && imgSrc instanceof HTMLCanvasElement) {
            if (!bufferFromUserData(imgSrc.userData)
                && !(textureObj && bufferFromUserData(textureObj.userData)))
                return true;
        }
        if (typeof OffscreenCanvas !== "undefined" && imgSrc instanceof OffscreenCanvas) {
            if (!bufferFromUserData(imgSrc.userData)
                && !(textureObj && bufferFromUserData(textureObj.userData)))
                return true;
        }
    } catch (e) {}
    return false;
}

/**
 * Peek original encoded bytes for size comparison (ignores scale / flipY gates).
 * Used so re-encode can fall back when the result is larger than the source.
 */
export function peekOriginalImageBytes(textureObj, target, exportOptions) {
    try {
        const fromReg = bufferFromSourceRegistry(textureObj, exportOptions);
        if (fromReg && fromReg.byteLength > 32) return fromReg;
    } catch (e) {}
    try {
        const fromTex = bufferFromUserData(textureObj && textureObj.userData);
        if (fromTex && fromTex.byteLength > 32) return fromTex;
    } catch (e) {}
    try {
        const fromImg = bufferFromUserData(target && target.userData);
        if (fromImg && fromImg.byteLength > 32) return fromImg;
    } catch (e) {}
    try {
        if (target && target.source && target.source.data && target.source.data.userData) {
            const fromSrc = bufferFromUserData(target.source.data.userData);
            if (fromSrc && fromSrc.byteLength > 32) return fromSrc;
        }
    } catch (e) {}
    return null;
}

/**
 * Prefer re-encoded bytes only when they are strictly smaller than the original.
 * Generated/edited textures and flipY rewrites always keep the re-encode
 * (orientation / app-baked content must not be replaced by stale source bytes).
 *
 * @returns {{ encoded: ArrayBuffer, mimeType: string, via: string, keptOriginal: boolean, origLen?: number, newLen?: number }}
 */
export function preferSmallerImageBytes(encoded, mimeType, via, textureObj, target, opts, generated, flipY) {
    if (!encoded || generated || flipY) {
        return { encoded, mimeType, via, keptOriginal: false };
    }
    let orig = null;
    try {
        orig = peekOriginalImageBytes(textureObj, target, opts);
    } catch (e) {
        orig = null;
    }
    if (!orig || !(orig.byteLength > 32)) {
        return { encoded, mimeType, via, keptOriginal: false };
    }
    const newLen = encoded.byteLength | 0;
    const origLen = orig.byteLength | 0;
    if (newLen < origLen) {
        return { encoded, mimeType, via, keptOriginal: false };
    }
    // Re-encode did not shrink — keep original bytes (avoids "light" export growing).
    return {
        encoded: orig,
        mimeType: orig.__exportMime || mimeType,
        via: "keep-original-smaller",
        keptOriginal: true,
        origLen,
        newLen
    };
}

export function bufferFingerprint(buf) {
    if (!buf || buf.byteLength < 32) return null;
    try {
        const len = buf.byteLength | 0;
        let u8;
        if (buf instanceof ArrayBuffer) u8 = new Uint8Array(buf);
        else if (buf.buffer) u8 = new Uint8Array(buf.buffer, buf.byteOffset || 0, buf.byteLength);
        else return null;
        let h = len;
        const head = Math.min(64, u8.length);
        for (let i = 0; i < head; i++) h = ((h * 33) ^ u8[i]) | 0;
        if (u8.length > 128) {
            const mid = (u8.length >>> 1) - 16;
            for (let i = 0; i < 32; i++) h = ((h * 33) ^ u8[mid + i]) | 0;
            for (let i = u8.length - 64; i < u8.length; i++) h = ((h * 33) ^ u8[i]) | 0;
        }
        return "buf:" + len + ":" + (h >>> 0);
    } catch (e) {
        return null;
    }
}

/** 同一画像を指すキーをすべて列挙（src: と buf: の食い違いを防ぐ） */
export function imageDedupeKeys(textureObj, target, encoded, exportOptions) {
    const keys = [];
    const push = (k) => { if (k && keys.indexOf(k) < 0) keys.push(k); };
    try {
        if (textureObj && textureObj.userData && textureObj.userData._srcImageIndex != null)
            push("src:" + (textureObj.userData._srcImageIndex | 0));
    } catch (e) {}
    try {
        if (target && target.userData && target.userData._srcImageIndex != null)
            push("src:" + (target.userData._srcImageIndex | 0));
    } catch (e) {}
    try {
        if (textureObj && textureObj.uuid && exportOptions
            && exportOptions.sourceTextureImageIndex
            && typeof exportOptions.sourceTextureImageIndex.get === "function") {
            const v = exportOptions.sourceTextureImageIndex.get(textureObj.uuid);
            if (v != null) push("src:" + (v | 0));
        }
    } catch (e) {}
    try {
        const buf = encoded
            || (textureObj && textureObj.userData && textureObj.userData.buffer)
            || (target && target.userData && target.userData.buffer);
        push(bufferFingerprint(buf));
    } catch (e) {}
    return keys;
}

export function lookupImageDedupe(state, keys) {
    if (!state.imageKeyMap || !keys || !keys.length) return null;
    for (let i = 0; i < keys.length; i++) {
        if (state.imageKeyMap.has(keys[i]))
            return { index: state.imageKeyMap.get(keys[i]), key: keys[i] };
    }
    return null;
}

export function registerImageDedupe(state, keys, index) {
    if (!state.imageKeyMap) state.imageKeyMap = new Map();
    if (!keys) return;
    for (let i = 0; i < keys.length; i++) {
        if (keys[i]) state.imageKeyMap.set(keys[i], index);
    }
}

/** 1×1 opaque white PNG (68 bytes). Used by skipTextures / debugFast. */
const TINY_WHITE_PNG = Uint8Array.from(atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
), c => c.charCodeAt(0));

export async function addImage(state, target, name = '', flipY, forcePng = false, textureObj = null) {
    const imageIndex = state.imageMap.findIndex((v) => v == target);
    if (imageIndex >= 0) return imageIndex;

    if (!state.imageKeyMap) state.imageKeyMap = new Map();
    const opts = state.exportOptions || DEFAULT_EXPORT_OPTIONS;

    // Debug: every texture becomes the same 1×1 white PNG (no encode / passthrough work).
    if (opts.skipTextures) {
        if (state._tinyWhiteImageIndex != null) {
            state.imageMap.push(target);
            return state._tinyWhiteImageIndex;
        }
        const index = state.images.length;
        state.images.push({
            name: name || "debug-1x1",
            mimeType: "image/png",
            bufferView: addBufferView(state, TINY_WHITE_PNG, name || "debug-1x1")
        });
        state.imageMap.push(target);
        state._tinyWhiteImageIndex = index;
        return index;
    }

    // Hybrid: images pre-copied from original GLB — O(1) by _srcImageIndex.
    // Skip when forceReencode: live drawable may differ from stamped _srcImageIndex
    // (VRoid eye mats often share face-atlas index while Texture.image is iris/highlight).
    const forceReImg = !!(textureObj && textureObj.userData && textureObj.userData._forceReencode);
    if (!forceReImg) {
        try {
            const seeded = lookupSeededImage(state, textureObj, target);
            if (seeded != null) {
                state.imageMap.push(target);
                try {
                    exportLog(state, "verbose", "[export] addImage SEEDED", name || "(unnamed)", "→", seeded);
                } catch (e) {}
                return seeded;
            }
        } catch (e) {}

        try {
            const earlyKeys = imageDedupeKeys(textureObj, target, null, opts);
            const hit = lookupImageDedupe(state, earlyKeys);
            if (hit) {
                registerImageDedupe(state, earlyKeys, hit.index);
                try {
                    exportLog(state, "verbose", "[export] addImage DEDUPE", name || "(unnamed)", "key=", hit.key, "→", hit.index);
                } catch (e) {}
                return hit.index;
            }
        } catch (e) {}
    } else {
        try {
            exportLog(state, "warn", "[export] addImage forceReencode (skip seed/dedupe)", name || "(unnamed)");
        } catch (e) {}
    }

    const plan = resolveImageEncodePlan(opts, !!forcePng, !!forcePng);
    let mimeType = plan.mimeType;
    let quality = plan.quality;
    const texScale = opts.textureScale != null ? opts.textureScale : 1;
    const needsResize = texScale != null && texScale < 0.999;
    let encoded = null;
    let via = "canvas";

    const generated = isGeneratedOrEditedTexture(textureObj, target);
    const mode = opts.textureCompressMode || "whenNeeded";
    // whenNeeded: 未編集はパススルーのみ。always: すべて再エンコード。
    const allowPassthrough = (mode !== "always") && !generated && !flipY && !needsResize;

    if (allowPassthrough) {
        try {
            encoded = await tryPassthroughImageBytes(target, flipY, texScale, textureObj, opts);
            if (encoded && encoded.__exportMime) {
                mimeType = encoded.__exportMime;
                via = "passthrough";
            } else {
                encoded = null;
            }
        } catch (e) {
            encoded = null;
        }
    }

    // パススルー後: buf: 指紋でも src: でもヒットすれば再利用
    if (encoded) {
        try {
            const keys2 = imageDedupeKeys(textureObj, target, encoded, opts);
            const hit2 = lookupImageDedupe(state, keys2);
            if (hit2) {
                registerImageDedupe(state, keys2, hit2.index);
                try {
                    exportLog(state, "verbose", "[export] addImage DEDUPE after passthrough", name || "(unnamed)",
                        "key=", hit2.key, "→", hit2.index);
                } catch (e) {}
                return hit2.index;
            }
        } catch (e) {}
    }

    if (!encoded) {
        try {
            let outMime = mimeType;
            let q = quality;
            if (forcePng || plan.mimeType === "image/png") {
                outMime = "image/png";
                q = undefined;
            } else {
                q = (q == null || q >= 0.999) ? 0.88 : q;
            }
            encoded = await imageBitmapToEncoded(target, outMime, q, flipY, texScale);
            if (encoded && encoded.__exportMime) outMime = encoded.__exportMime;
            mimeType = outMime;
            quality = q;
            via = "canvas";
        } catch (e) {
            console.warn("[export] encode failed, fallback WebP", name, e && e.message);
            mimeType = "image/webp";
            quality = 0.85;
            encoded = await imageBitmapToEncoded(target, mimeType, quality, flipY, texScale);
            if (encoded && encoded.__exportMime) mimeType = encoded.__exportMime;
            via = "canvas-fallback";
        }

        // 常に圧縮 / 再エンコード: 元より小さくなったときだけ採用。膨らんだら元バイトを維持。
        // （軽量プリセットで PNG 化して元より重くなる事故を防ぐ）
        try {
            const pick = preferSmallerImageBytes(
                encoded, mimeType, via, textureObj, target, opts, generated, flipY
            );
            encoded = pick.encoded;
            mimeType = pick.mimeType;
            via = pick.via;
            if (pick.keptOriginal) {
                try {
                    exportLog(state, "warn", "[export] addImage keep-original-smaller",
                        name || "(unnamed)",
                        "reencode=", pick.newLen, "≥ original=", pick.origLen,
                        "mode=", mode);
                } catch (e) {}
            }
        } catch (e) {}

        // 採用結果を userData にキャッシュ（次回 dedupe / passthrough 用）
        try {
            if (encoded) {
                if (textureObj) {
                    if (!textureObj.userData) textureObj.userData = {};
                    textureObj.userData.buffer = encoded;
                    textureObj.userData.mimeType = mimeType;
                    delete textureObj.userData._exportDirty;
                }
                if (target && typeof target === "object") {
                    if (!target.userData) target.userData = {};
                    target.userData.buffer = encoded;
                    target.userData.mimeType = mimeType;
                }
            }
        } catch (e) {}
    }

    // エンコード後の最終 dedupe（canvas 経路で同内容が出た場合）
    try {
        const keys3 = imageDedupeKeys(textureObj, target, encoded, opts);
        const hit3 = lookupImageDedupe(state, keys3);
        if (hit3) {
            registerImageDedupe(state, keys3, hit3.index);
            try {
                exportLog(state, "verbose", "[export] addImage DEDUPE after encode", name || "(unnamed)",
                    "key=", hit3.key, "→", hit3.index);
            } catch (e) {}
            return hit3.index;
        }
    } catch (e) {}

    const image = {
        bufferView: addBufferView(state, new Uint8Array(encoded), 'Image: ' + name),
        mimeType: mimeType,
        name: name,
    };
    const index = state.images.length;
    state.images.push(image);
    state.imageMap.push(target);
    try {
        const keys = imageDedupeKeys(textureObj, target, encoded, opts);
        registerImageDedupe(state, keys, index);
        // レジストリ index も必ず紐付け
        if (textureObj && textureObj.userData && textureObj.userData._srcImageIndex != null)
            state.imageKeyMap.set("src:" + (textureObj.userData._srcImageIndex | 0), index);
    } catch (e) {}
    try {
        exportLog(state, "verbose", "[export] addImage", name || "(unnamed)", "mime=", mimeType,
            "via=", via, "q=", quality, "bytes~", encoded && encoded.byteLength,
            generated ? "generated" : "source",
            "keys=", (imageDedupeKeys(textureObj, target, encoded, opts) || []).join(","));
    } catch (e) {}
    return index;
}

export async function addTexture(state, target, forcePng = false) {
    // 唇色ベイク済みテクスチャは WebP 等の非可逆圧縮で口まわりに蚊状の雑音が出やすい。
    // map / shadeMultiply で圧縮率が食い違うとさらに目立つため、常に可逆 (PNG) にする。
    // Also: never DEDUPE lip bake by original _srcImageIndex (would replace the
    // atlas entry and make every material that shared that index use the lip
    // bake — eyes/face highlights vanish or pick up lip paint).
    try{
        if(target && target.userData && target.userData._isLipBake){
            forcePng = true;
            try{ delete target.userData._srcImageIndex; }catch(e){}
            try{ delete target.userData._pendingSrcIdx; }catch(e){}
        }
    }catch(e){}

    function textureResult(texIndex) {
        const resHit = { index: texIndex };
        if (target.offset && target.repeat
            && (target.offset.x != 0 || target.offset.y != 0
                || target.repeat.x != 1 || target.repeat.y != 1)) {
            resHit.extensions = {
                KHR_texture_transform: {
                    offset: [target.offset.x, target.offset.y],
                    scale: [target.repeat.x, target.repeat.y]
                }
            };
        }
        return resHit;
    }

    // 同一 Texture オブジェクトは 1 エントリにまとめる
    try{
        if(!state._textureObjMap) state._textureObjMap = new Map();
        if(target && target.uuid && state._textureObjMap.has(target.uuid)){
            return textureResult(state._textureObjMap.get(target.uuid));
        }
    }catch(e){}

    // 同一ソース画像 index の Texture も 1 エントリにまとめる（VRM0/VRM1 二重登録対策）
    try{
        if(!state._textureSrcIndexMap) state._textureSrcIndexMap = new Map();
        let srcIdx = null;
        if (target && target.userData && target.userData._srcImageIndex != null)
            srcIdx = target.userData._srcImageIndex | 0;
        else if (state.exportOptions && state.exportOptions.sourceTextureImageIndex
            && target && target.uuid) {
            const v = state.exportOptions.sourceTextureImageIndex.get(target.uuid);
            if (v != null) srcIdx = v | 0;
        }
        const forceRe2 = !!(target && target.userData && target.userData._forceReencode);
        if (!forceRe2 && srcIdx != null && state._textureSrcIndexMap.has(srcIdx)) {
            const cached = state._textureSrcIndexMap.get(srcIdx);
            if (target && target.uuid && state._textureObjMap)
                state._textureObjMap.set(target.uuid, cached);
            try {
                exportLog(state, "verbose", "[export] addTexture DEDUPE srcImage=", srcIdx, "→ tex", cached);
            } catch (e) {}
            return textureResult(cached);
        }
        // 後で登録するため srcIdx を保持 — forceReencode 時は付けない
        // （付け直すと addImage の seed 経路や後続 DEDUPE が誤る）
        if (target && !forceRe2) {
            if (!target.userData) target.userData = {};
            if (srcIdx != null) target.userData._srcImageIndex = srcIdx;
            target.userData._pendingSrcIdx = srcIdx;
        }
    }catch(e){}

    const imgSrc = textureImageSource(target);
    if (!imgSrc) {
        console.warn("[export] texture has no drawable image source", target && target.name, target && target.type);
        return null;
    }

    // 同一 image source（canvas / ImageBitmap 等）も 1 エントリにまとめる。
    // Texture オブジェクトが別でも中身の canvas が同じなら二重エンコードを避ける。
    // 唇色ベイクで map / shade が別 Texture インスタンスになっているケースの主対策。
    try{
        if(!state._textureImgSrcMap) state._textureImgSrcMap = new Map();
        if(imgSrc && state._textureImgSrcMap.has(imgSrc)){
            const cached = state._textureImgSrcMap.get(imgSrc);
            try{
                if(target && target.uuid && state._textureObjMap)
                    state._textureObjMap.set(target.uuid, cached);
            }catch(e){}
            const resHit = { index: cached };
            if (target.offset && target.repeat
                && (target.offset.x != 0 || target.offset.y != 0
                    || target.repeat.x != 1 || target.repeat.y != 1)) {
                resHit.extensions = {
                    KHR_texture_transform: {
                        offset: [target.offset.x, target.offset.y],
                        scale: [target.repeat.x, target.repeat.y]
                    }
                };
            }
            return resHit;
        }
    }catch(e){}

    const texture = {
        name: target.name,
        sampler: addSampler(state, target),
        source: await addImage(state, imgSrc, target.name, target.flipY, forcePng, target),
    };

    const res = {};
    const key = JSON.stringify(texture);
    if (state.textureMap.has(key)) {
        res.index = state.textureMap.get(key);
    } else {
        const index = state.textures.length;
        state.textures.push(texture);
        state.textureMap.set(key, index);
        res.index = index;
    }
    try{
        if(target && target.uuid && state._textureObjMap){
            state._textureObjMap.set(target.uuid, res.index);
        }
        if(imgSrc && state._textureImgSrcMap){
            state._textureImgSrcMap.set(imgSrc, res.index);
        }
        // ソース画像 index → texture index（VRM0/VRM1 共有）
        // forceReencode の結果は元 srcImage に紐づけない（face atlas と目テクスチャの混同防止）
        const forceReEnd = !!(target && target.userData && target.userData._forceReencode);
        if (!forceReEnd) {
            if (!state._textureSrcIndexMap) state._textureSrcIndexMap = new Map();
            let srcIdx = (target && target.userData && target.userData._srcImageIndex != null)
                ? (target.userData._srcImageIndex | 0) : null;
            if (srcIdx == null && target && target.userData && target.userData._pendingSrcIdx != null)
                srcIdx = target.userData._pendingSrcIdx | 0;
            if (srcIdx != null) state._textureSrcIndexMap.set(srcIdx, res.index);
        }
    }catch(e){}

    if (target.offset.x != 0 || target.offset.y != 0 || target.repeat.x != 1 || target.repeat.y != 1) {
        res.extensions = {
            KHR_texture_transform: {
                offset: [target.offset.x, target.offset.y],
                scale: [target.repeat.x, target.repeat.y]
            }
        };
    }
    //res.texCoord = 0;
    //res.extra = {};

    return res;
}
