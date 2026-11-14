/**
 * Morpholith export — small scene/material helpers shared by mesh + scene.
 */

export function isOutlineOnlyMaterial(mat) {
    if (!mat) return true;
    try {
        if (mat.userData && (mat.userData._isOutline || mat.userData.isOutline)) return true;
    } catch (e) {}
    // three-vrm MToonMaterial private flag
    try {
        if (mat._isOutline === true) return true;
    } catch (e) {}
    const n = String(mat.name || "");
    if (/\(Outline\)/i.test(n)) return true;
    if (/_Outline$/i.test(n)) return true;
    return false;
}

/**
 * エクスポート用マテリアルリスト。アウトライン専用スロットを除き、
 * geometry.groups の materialIndex を新リストへリマップする。
 * @returns {{ matList: any[], remap: number[] }}
 */
export function exportMaterialList(target) {
    const raw = Array.isArray(target.material) ? target.material : [target.material];
    const matList = [];
    const remap = []; // oldIndex -> newIndex (-1 = drop / map to 0)
    for (let i = 0; i < raw.length; i++) {
        const m = raw[i];
        if (isOutlineOnlyMaterial(m)) {
            remap[i] = -1;
            continue;
        }
        remap[i] = matList.length;
        matList.push(m);
    }
    if (!matList.length && raw.length) {
        // すべてアウトライン扱いだった場合は先頭を残す
        matList.push(raw[0]);
        for (let i = 0; i < raw.length; i++) remap[i] = 0;
    }
    return { matList, remap };
}

/** Runtime-only helpers that must never be written into the VRM. */
export function isExportExcludedHelper(node) {
    if (!node) return false;
    const n = String(node.name || "");
    // Inverted-hull outline sibling created after 目穴 fill / geometry rewrite.
    // It is a full clone of the face mesh (incl. morph targets) — exporting it
    // roughly doubles face geometry + morphs and makes re-load OOM.
    if (/^__fallbackOutline/i.test(n)) return true;
    if (/_matOptOutline$/i.test(n)) return true;
    if (/^__eyeHoleFill/i.test(n)) return true;
    if (/^__lipOverlay/i.test(n)) return true;
    if (/^__mouthSocketDebug/i.test(n) || /^__eyeSocketDebug/i.test(n)) return true;
    if (node.userData && (node.userData._isRuntimeHelper || node.userData._isLipOverlay)) return true;
    if (node.userData && node.userData._matOptOutline === node) return true;
    if (node.material && node.material.name && /^__fallbackOutlineMat/i.test(String(node.material.name))) return true;
    // つめ結合で全頂点を剥がしたメッシュは visible=false のままシーンに残る。
    // 書き出すと Body_Nails と二重になり、2 回目以降のファイルが肥大化する。
    try {
        if (node.isMesh && node.visible === false) return true;
        if (node.userData && (node.userData._strippedEmpty || node.userData._exportExclude)) return true;
    } catch (e) {}
    return false;
}

