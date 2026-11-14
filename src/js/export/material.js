/**
 * Morpholith export — MToon / materialProperties / three material → glTF.
 */
import * as THREE from "three";
import {
    addImage, addTexture, textureImageSource, bakeWhiteAlphaCanvas
} from "./texture.js";
import { addSampler } from "./core.js";
import { exportLog } from "./log.js";
import { lookupSeededMaterial, normalizeMaterialName } from "./seed-assets.js";

export async function makeMToon(state, main, renderOrder) {
    const mToon = { specVersion: "1.0" };

    if (main.depthWrite) {
        mToon.transparentWithZWrite = true;
        if (renderOrder != 0) mToon.renderQueueOffsetNumber = renderOrder;
    } else {
        if (renderOrder != 19) mToon.renderQueueOffsetNumber = renderOrder - 19;
    }
    // Resolve shade colour / texture via public props OR uniforms.
    // three-vrm MToonMaterial stores both; after temporary live mutations the
    // public prop can desync from uniforms — prefer whichever still holds a
    // real value so hair underside (shadeMultiplyTexture) survives export.
    const readShadeColor = (mat)=>{
        try{
            if(mat.shadeColorFactor && mat.shadeColorFactor.isColor) return mat.shadeColorFactor;
        }catch(e){}
        try{
            if(mat.uniforms && mat.uniforms.shadeColorFactor
                && mat.uniforms.shadeColorFactor.value
                && mat.uniforms.shadeColorFactor.value.isColor)
                return mat.uniforms.shadeColorFactor.value;
        }catch(e){}
        return null;
    };
    const readShadeMulTex = (mat)=>{
        try{
            if(mat.shadeMultiplyTexture) return mat.shadeMultiplyTexture;
        }catch(e){}
        try{
            if(mat.uniforms && mat.uniforms.shadeMultiplyTexture
                && mat.uniforms.shadeMultiplyTexture.value)
                return mat.uniforms.shadeMultiplyTexture.value;
        }catch(e){}
        return null;
    };
    if (main.userData && typeof main.userData._solidHex === "string") {
        try {
            const sc = new THREE.Color().set(main.userData._solidHex);
            mToon.shadeColorFactor = [sc.r, sc.g, sc.b];
        } catch (e) {
            mToon.shadeColorFactor = main.color && main.color.isColor
                ? [main.color.r, main.color.g, main.color.b]
                : [0, 0, 0];
        }
    } else {
        const shadeCol = readShadeColor(main);
        if (shadeCol) {
            // Preserve the loaded / live shade colour as-is, including pure black.
            // Previously we rewrote pure-black → lit colour to "rescue" desyncs
            // after live edits, but that also rewrote intentional black
            // shadeColorFactor (common when shadeMultiplyTexture carries the
            // colour). Result: load → immediate save changed hair underside.
            // Desync protection is handled by the early MToon snapshot/restore
            // in app.js instead; do not mutate the value here.
            mToon.shadeColorFactor = [shadeCol.r, shadeCol.g, shadeCol.b];
        } else if (main.color && main.color.isColor) {
            // MeshToonMaterial 等の単色塗りつぶしは shade チャンネルを持たない。
            // 黒 [0,0,0] だと影部分が潰れるため lit と同色にする。
            mToon.shadeColorFactor = [main.color.r, main.color.g, main.color.b];
        } else {
            mToon.shadeColorFactor = [1, 1, 1];
        }
    }
    const shadeMul = (!(main.userData && main.userData._isSolidNailMat))
        ? readShadeMulTex(main) : null;
    if (shadeMul) {
        // Always true PNG (not lossless webp): hair underside is very sensitive
        // to any shadeMultiplyTexture recompression.
        const t = await addTexture(state, shadeMul, true);
        if (t && t.index != null) mToon.shadeMultiplyTexture = t;
    }
    if (/hair|kami|髪/i.test(main.name || "")) {
        try {
            console.warn("[export][hair-mtoon]", main.name,
                "shadeColor=", mToon.shadeColorFactor,
                "hasShadeMul=", !!shadeMul,
                "shadingShift=", main.shadingShiftFactor,
                "shadingToony=", main.shadingToonyFactor,
                "side=", main.side);
        } catch (e) {}
    }
    if (main.shadingShiftFactor != 0)
        mToon.shadingShiftFactor = main.shadingShiftFactor;
    if (main.shadingShiftTexture) {
        const t = await addTexture(state, main.shadingShiftTexture);
        if (t && t.index != null) mToon.shadingShiftTexture = t;
    }
    if (main.shadingToonyFactor != 0.9)
        mToon.shadingToonyFactor = main.shadingToonyFactor;
    if (main.giEqualizationFactor != 0.9)
        mToon.giEqualizationFactor = main.giEqualizationFactor;

    if (main.matcapFactor && main.matcapFactor.getHex() != 16777215)
        mToon.matcapFactor = [main.matcapFactor.r, main.matcapFactor.g, main.matcapFactor.b];
    if (main.matcapTexture) {
        const t = await addTexture(state, main.matcapTexture);
        if (t && t.index != null) mToon.matcapTexture = t;
    }

    if (main.parametricRimColorFactor && main.parametricRimColorFactor.getHex() != 0)
        mToon.parametricRimColorFactor = [main.parametricRimColorFactor.r, main.parametricRimColorFactor.g, main.parametricRimColorFactor.b];
    if (main.rimMultiplyTexture) {
        const t = await addTexture(state, main.rimMultiplyTexture);
        if (t && t.index != null) mToon.rimMultiplyTexture = t;
    }
    if (main.rimLightingMixFactor != 1)
        mToon.rimLightingMixFactor = main.rimLightingMixFactor;
    if (main.parametricRimFresnelPowerFactor != 5)
        mToon.parametricRimFresnelPowerFactor = main.parametricRimFresnelPowerFactor;
    if (main.parametricRimLiftFactor != 0)
        mToon.parametricRimLiftFactor = main.parametricRimLiftFactor;

    if (main.outlineWidthMode != 'none')
        mToon.outlineWidthMode = main.outlineWidthMode;
    if (main.outlineWidthFactor != 0)
        mToon.outlineWidthFactor = main.outlineWidthFactor;
    if (main.outlineWidthMultiplyTexture) {
        const t = await addTexture(state, main.outlineWidthMultiplyTexture);
        if (t && t.index != null) mToon.outlineWidthMultiplyTexture = t;
    }

    if (main.outlineColorFactor && main.outlineColorFactor.getHex() != 0)
        mToon.outlineColorFactor = [main.outlineColorFactor.r, main.outlineColorFactor.g, main.outlineColorFactor.b];
    if (main.outlineLightingMixFactor != 1)
        mToon.outlineLightingMixFactor = main.outlineLightingMixFactor;

    if (main.uvAnimationMaskTexture) {
        const t = await addTexture(state, main.uvAnimationMaskTexture);
        if (t && t.index != null) mToon.uvAnimationMaskTexture = t;
    }
    if (main.uvAnimationScrollXSpeedFactor != 0)
        mToon.uvAnimationScrollXSpeedFactor = main.uvAnimationScrollXSpeedFactor;
    if (main.uvAnimationScrollYSpeedFactor != 0)
        mToon.uvAnimationScrollYSpeedFactor = main.uvAnimationScrollYSpeedFactor;
    if (main.uvAnimationRotationSpeedFactor != 0)
        mToon.uvAnimationRotationSpeedFactor = main.uvAnimationRotationSpeedFactor;

    if (!state.extensionsUsed.includes('VRMC_materials_mtoon')) state.extensionsUsed.push('VRMC_materials_mtoon');

    const index = state.materials.length - 1;
    state.materials[index].extensions.VRMC_materials_mtoon = mToon;
}

export function gamma(color, alpha = null) {
    // Accept THREE.Color or plain {r,g,b} (solid-fill path passes plain objects)
    let c3;
    if (color && typeof color.clone === "function" && typeof color.convertLinearToSRGB === "function") {
        c3 = color.clone().convertLinearToSRGB();
    } else {
        const r = (color && color.r != null) ? color.r : 1;
        const g = (color && color.g != null) ? color.g : 1;
        const b = (color && color.b != null) ? color.b : 1;
        c3 = new THREE.Color(r, g, b);
        if (typeof c3.convertLinearToSRGB === "function") c3.convertLinearToSRGB();
    }
    const c = [c3.r, c3.g, c3.b];
    if (alpha != null) c.push(alpha);
    return c;
}

export async function makeMaterialProperties(state, main, renderOrder) {
    // --- Fast path: unedited VRM0 material → clone original materialProperties ---
    // Remap only texture indices to the newly exported texture table.
    // This is the only reliable way to keep hair underside identical on load→save
    // (three-vrm's live shade params / keywords do not round-trip to Unity MToon).
    try {
      const orgMap = state.org && state.org.userData
        && state.org.userData._originalVrm0MaterialProperties;
      const list = state.org && state.org.userData
        && state.org.userData._originalVrm0MaterialPropertiesList;
      const rawName = main.name || "";
      const matName = rawName
        .replace(/\s*\(Instance\)\s*$/i, "")
        .replace(/\s*\(Outline\)\s*$/i, "")
        .trim();
      let orig = orgMap && (orgMap[matName] || orgMap[rawName]);
      if (!orig && orgMap) {
        const keys = Object.keys(orgMap).filter(k => !k.startsWith("__idx_"));
        const hit = keys.find(k =>
          k === matName || (matName && k && (matName.endsWith(k) || k.endsWith(matName)
            || matName.includes(k) || k.includes(matName)))
        );
        if (hit) orig = orgMap[hit];
      }
      if (!orig && list && list.length && state.materials && state.materials.length) {
        const idx = state.materials.length - 1;
        if (list[idx]) orig = list[idx];
      }
      // Skip fast-path for solid-fill / edited materials
      // filter (nail etc.) も live の color/shade を反映させるため isEdited にする
      const ud = main.userData || {};
      const isEdited = !!(ud._isSolidNailMat || ud._compColorMode === "solid"
        || ud._compColorMode === "filter"
        || ud._solidHex || ud._solidPreserveAlpha || ud._skinTintApplied);
      if (orig && orig.shader && !isEdited) {
        const properties = JSON.parse(JSON.stringify(orig));
        // Keep export name (may have Instance/Outline suffix stripped already)
        if (matName) properties.name = matName;

        // 旧ファイルの texture index は新しい textures[] と一致しない。
        // 残すと textures[i] が undefined → GLTFLoader KHR_texture_basisu が
        // "Cannot read properties of undefined (reading 'extensions')" で落ちる。
        // いったん全スロットを捨て、ライブテクスチャから再登録したものだけ書く。
        const prevVec = properties.vectorProperties || {};
        properties.textureProperties = {};
        if (!properties.vectorProperties) properties.vectorProperties = {};

        // Rebuild texture slots from live three.js textures (passthrough bytes)
        const texSlots = {
          _MainTex: () => main.map || null,
          _ShadeTexture: () => {
            try { if (main.shadeMultiplyTexture) return main.shadeMultiplyTexture; } catch (e) {}
            try {
              if (main.uniforms && main.uniforms.shadeMultiplyTexture)
                return main.uniforms.shadeMultiplyTexture.value;
            } catch (e) {}
            return null;
          },
          _BumpMap: () => main.normalMap || null,
          _EmissionMap: () => main.emissiveMap || null,
          _SphereAdd: () => main.matcapTexture || null,
          _RimTexture: () => main.rimMultiplyTexture || null,
          _OutlineWidthTexture: () => main.outlineWidthMultiplyTexture || null,
          _UvAnimMaskTexture: () => main.uvAnimationMaskTexture || null,
        };
        for (const slot of Object.keys(texSlots)) {
          // Only remap slots that existed in the original (preserve intentional absence)
          if (orig.textureProperties && orig.textureProperties[slot] == null
              && slot !== "_MainTex" && slot !== "_ShadeTexture") {
            // 元に無かったスロットの UV ベクトルも落とす
            if (properties.vectorProperties[slot]) delete properties.vectorProperties[slot];
            continue;
          }
          const tex = texSlots[slot]();
          if (!tex) {
            // ライブに無い → スロット自体を書かない（旧 index は絶対に残さない）
            if (properties.vectorProperties[slot]) delete properties.vectorProperties[slot];
            continue;
          }
          const forcePng = (slot === "_ShadeTexture" || slot === "_MainTex");
          const res = await addTexture(state, tex, forcePng);
          if (res && res.index != null) {
            properties.textureProperties[slot] = res.index;
            if (tex.offset && tex.repeat) {
              properties.vectorProperties[slot] = [
                tex.offset.x, tex.offset.y, tex.repeat.x, tex.repeat.y
              ];
            } else if (prevVec[slot]) {
              properties.vectorProperties[slot] = prevVec[slot];
            } else {
              properties.vectorProperties[slot] = [0, 0, 1, 1];
            }
          } else {
            if (properties.vectorProperties[slot]) delete properties.vectorProperties[slot];
          }
        }

        const index = state.materials.length - 1;
        if (!state.extensions.VRM.materialProperties) state.extensions.VRM.materialProperties = [];
        state.extensions.VRM.materialProperties[index] = properties;

        let renderType = (properties.tagMap && properties.tagMap.RenderType) || "Opaque";
        state.materialQueue.push({
          renderType,
          properties,
          renderOrder: renderOrder || 0
        });

        if (/hair|kami|髪|HAIR/i.test(main.name || "")) {
          try {
            exportLog(state, "verbose", "[export][vrm0-fastpath]", main.name,
              "_ShadeShift=", properties.floatProperties && properties.floatProperties._ShadeShift,
              "_ShadeToony=", properties.floatProperties && properties.floatProperties._ShadeToony,
              "_ShadeColor=", properties.vectorProperties && properties.vectorProperties._ShadeColor,
              "shadeTex=", properties.textureProperties && properties.textureProperties._ShadeTexture,
              "mainTex=", properties.textureProperties && properties.textureProperties._MainTex);
          } catch (e) {}
        }
        return; // done — exact original props + remapped textures
      }
    } catch (e) {
      console.warn("[export] VRM0 original materialProperties fast-path failed", e);
    }

    const properties = { name: main.name, shader: "VRM/MToon", renderQueue: 2450 };

    const floatProperties = properties.floatProperties = {};
    const vectorProperties = properties.vectorProperties = {};
    const textureProperties = properties.textureProperties = {};
    const keywordMap = properties.keywordMap = {};
    const tagMap = properties.tagMap = {};

    let renderType = '';

    async function addTexture2(texture, dist) {
        const res = await addTexture(state, texture);
        if (!res || res.index == null) {
            console.warn("[export] addTexture2 skipped (no image)", dist, texture && texture.name);
            return;
        }
        textureProperties[dist] = res.index;
        vectorProperties[dist] = texture.offset && texture.repeat
            ? [texture.offset.x, texture.offset.y, texture.repeat.x, texture.repeat.y]
            : [0, 0, 1, 1];
    }

    // Prefer public alphaTest; some materials only expose internal _alphaTest
    const matAlphaTest = (typeof main.alphaTest === "number" && main.alphaTest > 0)
        ? main.alphaTest
        : ((typeof main._alphaTest === "number") ? main._alphaTest : 0);
    if (main.transparent == false && matAlphaTest == 0) {
        // OPAQUE
        tagMap.RenderType = 'Opaque';
        renderType = 'Opaque';
        keywordMap._ALPHABLEND_ON = false;
        keywordMap._ALPHATEST_ON = false;
    }
    if (main.transparent == false && matAlphaTest != 0) {
        // MASK
        tagMap.RenderType = 'TransparentCutout';
        renderType = 'TransparentCutout';
        keywordMap._ALPHATEST_ON = true;
        floatProperties._BlendMode = 1;
        floatProperties._Cutoff = matAlphaTest;
    }
    if (main.transparent == true) {
        // BLEND
        tagMap.RenderType = 'Transparent';
        keywordMap._ALPHABLEND_ON = true;
        floatProperties._BlendMode = 2;
        floatProperties._SrcBlend = 5;
        floatProperties._DstBlend = 10;
        floatProperties._ZWrite = main.depthWrite ? 1 : 0;
        if (main.depthWrite) {
            renderType = 'TransparentWithZWrite';
        } else {
            renderType = 'Transparent';
        }
        floatProperties._Cutoff = main.alphaTest;
    }

    if (main.side === 2) {
        //DoubleSide
        floatProperties._CullMode = 0;
    } else if (main.side === 0) {
        //Front
        floatProperties._CullMode = 2;
    } else {
        //Back
        floatProperties._CullMode = 1;
    }

    {
        // Always prefer _solidHex for solid fills so colour survives even when
        // the loader ignores the albedo texture RGB.
        let cForColor = main.color;
        if (main.userData && typeof main.userData._solidHex === "string") {
            try { cForColor = new THREE.Color().set(main.userData._solidHex); } catch (e) {}
        }
        if (cForColor) vectorProperties._Color = gamma(cForColor, main.opacity);
    }
    // Solid fills with cutout still need _MainTex (colour+A or white+A).
    // Prefer the bake — original map may be KTX2/compressed and not drawable.
    const solidSkipMap = !!(main.userData && main.userData._isSolidNailMat
        && !main.userData._solidPreserveAlpha && !main.userData._solidBakedMap);
    if (!solidSkipMap) {
        const mapForExport = (main.userData && main.userData._solidBakedMap)
            || main.map
            || null;
        if (mapForExport && textureImageSource(mapForExport)) {
            try {
                await addTexture2(mapForExport, '_MainTex');
            } catch (e) {
                exportLog(state, "verbose", "[export] skip undrawable _MainTex", main.name, e && e.message);
            }
        }
    }

    if (main.emissive) vectorProperties._EmissionColor = gamma(main.emissive, 1);
    if (main.emissiveMap) await addTexture2(main.emissiveMap, '_EmissionMap');

    if (main.normalScale) floatProperties._BumpScale = main.normalScale.x;
    if (main.normalMap) {
        await addTexture2(main.normalMap, '_BumpMap');
        keywordMap._NORMALMAP = true;
    }

    vectorProperties._ShadeColor = [0, 0, 0, 1];
    if (main.userData && typeof main.userData._solidHex === "string") {
        try {
            vectorProperties._ShadeColor = gamma(new THREE.Color().set(main.userData._solidHex), main.opacity);
        } catch (e) {
            const sc0 = (main.shadeColorFactor && main.shadeColorFactor.isColor) ? main.shadeColorFactor
                : (main.uniforms && main.uniforms.shadeColorFactor && main.uniforms.shadeColorFactor.value);
            if (sc0) vectorProperties._ShadeColor = gamma(sc0, main.opacity);
        }
    } else {
        const sc0 = (main.shadeColorFactor && main.shadeColorFactor.isColor) ? main.shadeColorFactor
            : (main.uniforms && main.uniforms.shadeColorFactor && main.uniforms.shadeColorFactor.value
                && main.uniforms.shadeColorFactor.value.isColor
                ? main.uniforms.shadeColorFactor.value : null);
        if (sc0) {
            vectorProperties._ShadeColor = gamma(sc0, main.opacity);
        } else if (main.color) {
            // MeshToon / solid without shade channel: match lit colour
            vectorProperties._ShadeColor = gamma(main.color, main.opacity);
        }
    }
    {
        let shadeMul0 = null;
        try{ shadeMul0 = main.shadeMultiplyTexture; }catch(e){}
        if(!shadeMul0){
            try{
                if(main.uniforms && main.uniforms.shadeMultiplyTexture)
                    shadeMul0 = main.uniforms.shadeMultiplyTexture.value;
            }catch(e){}
        }
        if (shadeMul0 && !(main.userData && main.userData._isSolidNailMat)) {
            // Always lossless (PNG preferred) + write UV transform like _MainTex.
            // Missing UV was a source of underside colour / sampling drift on
            // models that share non-identity transforms with the lit map.
            const res = await addTexture(state, shadeMul0, true);
            if (res && res.index != null) {
                textureProperties._ShadeTexture = res.index;
                vectorProperties._ShadeTexture = shadeMul0.offset && shadeMul0.repeat
                    ? [shadeMul0.offset.x, shadeMul0.offset.y, shadeMul0.repeat.x, shadeMul0.repeat.y]
                    : [0, 0, 1, 1];
            }
        }
    }

    // Prefer original VRM0 materialProperties for shade boundary params.
    // three-vrm's shadingShiftFactor/shadingToonyFactor are in the shader's
    // internal space; writing them back as Unity VRM0 _ShadeShift/_ShadeToony
    // changes hair underside colour in other viewers even when textures are
    // bit-exact. Source props (captured on load) give a true round-trip.
    let usedOriginalShade = false;
    let matchedOrigName = null;
    try {
      const orgMap = state.org && state.org.userData
        && state.org.userData._originalVrm0MaterialProperties;
      const list = state.org && state.org.userData
        && state.org.userData._originalVrm0MaterialPropertiesList;
      const rawName = main.name || "";
      const matName = rawName
        .replace(/\s*\(Instance\)\s*$/i, "")
        .replace(/\s*\(Outline\)\s*$/i, "")
        .trim();
      let orig = orgMap && (orgMap[matName] || orgMap[rawName]);
      if (!orig && orgMap) {
        const keys = Object.keys(orgMap).filter(k => !k.startsWith("__idx_"));
        const hit = keys.find(k =>
          k === matName || (matName && k && (matName.endsWith(k) || k.endsWith(matName)
            || matName.includes(k) || k.includes(matName)))
        );
        if (hit) { orig = orgMap[hit]; matchedOrigName = hit; }
      }
      if (!orig && list && list.length && state.materials && state.materials.length) {
        const idx = state.materials.length - 1;
        if (list[idx]) {
          orig = list[idx];
          matchedOrigName = "(byIndex " + idx + ")";
        }
      }
      if (orig && orig.floatProperties) {
        const fp = orig.floatProperties;
        if (fp._ShadeShift != null) {
          floatProperties._ShadeShift = fp._ShadeShift;
          usedOriginalShade = true;
        }
        if (fp._ShadeToony != null) {
          floatProperties._ShadeToony = fp._ShadeToony;
          usedOriginalShade = true;
        }
        if (orig.vectorProperties && orig.vectorProperties._ShadeColor) {
          vectorProperties._ShadeColor = orig.vectorProperties._ShadeColor.slice();
          usedOriginalShade = true;
        }
        if (orig.vectorProperties && orig.vectorProperties._Color) {
          vectorProperties._Color = orig.vectorProperties._Color.slice();
          usedOriginalShade = true;
        }
        if (!matchedOrigName) matchedOrigName = matName;
      }
    } catch (e) {}
    if (!usedOriginalShade) {
      const shadingToonyFactor = (main.shadingToonyFactor != null) ? main.shadingToonyFactor : 0.9;
      const shadingShiftFactor = (main.shadingShiftFactor != null) ? main.shadingShiftFactor : 0.0;
      floatProperties._ShadeShift = shadingShiftFactor;
      floatProperties._ShadeToony = shadingToonyFactor;
    }
    if (/hair|kami|髪|HAIR|Face|Skin/i.test(main.name || "")) {
        try {
            const orgMap = state.org && state.org.userData
              && state.org.userData._originalVrm0MaterialProperties;
            const keys = orgMap ? Object.keys(orgMap).filter(k => !k.startsWith("__idx_")) : [];
            exportLog(state, "verbose", "[export][vrm0-shade]", main.name,
                "_ShadeShift=", floatProperties._ShadeShift,
                "_ShadeToony=", floatProperties._ShadeToony,
                "_ShadeColor=", vectorProperties._ShadeColor,
                "fromOriginal=", usedOriginalShade,
                "matched=", matchedOrigName,
                "availKeys=", keys.slice(0, 12));
        } catch (e) {}
    }

    if (main.giEqualizationFactor != 0.9) floatProperties._IndirectLightIntensity = main.giEqualizationFactor;

    //if (main.matcapFactor && main.matcapFactor.getHex() != 16777215)
    //    vectorProperties._SphereAddColor = gamma(main.matcapFactor);
    if (main.matcapTexture)
        await addTexture2(main.matcapTexture, '_SphereAdd');

    if (main.rimLightingMixFactor != 1)
        floatProperties._RimLightingMix = main.rimLightingMixFactor;
    if (main.rimMultiplyTexture)
        textureProperties._RimTexture = (await addTexture(state, main.rimMultiplyTexture)).index;
    if (main.parametricRimColorFactor && main.parametricRimColorFactor.getHex() != 0)
        vectorProperties._RimColor = gamma(main.parametricRimColorFactor, 1);
    if (main.parametricRimFresnelPowerFactor != 5)
        floatProperties._RimFresnelPower = main.parametricRimFresnelPowerFactor;
    if (main.parametricRimLiftFactor != 0)
        floatProperties._RimLift = main.parametricRimLiftFactor;

    switch (main.outlineWidthMode) {
        case 'worldCoordinates':
            keywordMap.MTOON_OUTLINE_WIDTH_WORLD = true;
            break;
        case 'screenCoordinates':
            keywordMap.MTOON_OUTLINE_WIDTH_SCREEN = true;
            break;
    }
    floatProperties._OutlineWidthMode = { none: 0, worldCoordinates: 1, screenCoordinates: 2 }[main.outlineWidthMode];
    if (main.outlineWidthFactor != 0)
        floatProperties._OutlineWidth = main.outlineWidthFactor * 100;
    if (main.outlineWidthMultiplyTexture)
        await addTexture2(main.outlineWidthMultiplyTexture, '_OutlineWidthTexture');

    if (main.outlineColorFactor && main.outlineColorFactor.getHex() != 0)
        vectorProperties._OutlineColor = gamma(main.outlineColorFactor, 1);
    // three-vrm's VRM1 MToonMaterial has no discrete outlineColorMode; VRM1.0
    // replaced Unity MToon's FixedColor(0)/MixedLighting(1) switch with a
    // continuous outlineLightingMixFactor (0 = fixed color .. 1 = fully lit).
    // The legacy Unity "VRM/MToon" shader still needs the discrete
    // _OutlineColorMode set, or it silently ignores _OutlineLightingMix and
    // always renders FixedColor. Derive it so the two stay consistent.
    const outlineLightingMix = typeof main.outlineLightingMixFactor === "number"
        ? main.outlineLightingMixFactor : 1;
    floatProperties._OutlineColorMode = outlineLightingMix > 0 ? 1 : 0; // 0=FixedColor, 1=MixedLighting
    if (outlineLightingMix != 1)
        floatProperties._OutlineLightingMix = outlineLightingMix;

    if (main.uvAnimationMaskTexture)
        await addTexture2(main.uvAnimationMaskTexture, '_UvAnimMaskTexture');
    if (main.uvAnimationScrollXSpeedFactor != 0)
        floatProperties._UvAnimScrollX = main.uvAnimationScrollXSpeedFactor;
    if (main.uvAnimationScrollYSpeedFactor != 0)
        floatProperties._UvAnimScrollY = main.uvAnimationScrollYSpeedFactor;
    if (main.uvAnimationRotationSpeedFactor != 0)
        floatProperties._UvAnimRotation = main.uvAnimationRotationSpeedFactor;

    const index = state.materials.length - 1;
    if (!state.extensions.VRM.materialProperties) state.extensions.VRM.materialProperties = [];
    state.extensions.VRM.materialProperties[index] = properties;

    state.materialQueue.push({ renderType, properties, renderOrder });
}

/**
 * Export a single THREE material. Used by makeMaterial and by multi-material
 * group splitting (estimate-side component tint uses material arrays + groups).
 * @param {object} state
 * @param {THREE.Material} main
 * @param {number} [renderOrder]
 */

/**
 * Write a cloned material without overwriting seeded slots.
 * Seeded indices [0, _seededMaterialCount) are frozen (status §33 D).
 * Returns the material index to use on primitives.
 */
function commitMaterialClone(state, seedIdx, clone, propsClone, logTag, main, allowInPlaceOnOwnSeed) {
    const frozenUntil = state._seededMaterialCount | 0;
    // Edited material updating ITS OWN seed slot may in-place (filterTint).
    // Never in-place when it would touch a different frozen material.
    const mustAppend = (seedIdx == null)
        || ((seedIdx < frozenUntil) && !allowInPlaceOnOwnSeed);
    if (mustAppend) {
        const baseName = clone.name || (main && main.name) || "mat";
        if (!/__morpholith/i.test(baseName)) {
            clone.name = String(baseName).replace(/\s*\(Instance\)\s*$/i, "") + "__morpholith";
        }
        if (propsClone) {
            propsClone = JSON.parse(JSON.stringify(propsClone));
            propsClone.name = clone.name;
        }
        const newIdx = state.materials.length;
        state.materials.push(clone);
        if (state.metaVersion == 0 && state.extensions && state.extensions.VRM) {
            if (!Array.isArray(state.extensions.VRM.materialProperties)) {
                state.extensions.VRM.materialProperties = [];
            }
            const propsList = state.extensions.VRM.materialProperties;
            while (propsList.length < newIdx) propsList.push(null);
            if (propsClone) {
                propsList[newIdx] = propsClone;
            } else if (seedIdx != null && propsList[seedIdx]) {
                const p = JSON.parse(JSON.stringify(propsList[seedIdx]));
                p.name = clone.name;
                propsList[newIdx] = p;
            }
        }
        exportLog(state, "warn", "[export][mat]", logTag, "APPEND",
            (main && main.name) || "(unnamed)", "from", seedIdx, "→", newIdx);
        return newIdx;
    }
    state.materials[seedIdx] = clone;
    if (propsClone && state.metaVersion == 0 && state.extensions && state.extensions.VRM
        && Array.isArray(state.extensions.VRM.materialProperties)) {
        state.extensions.VRM.materialProperties[seedIdx] = propsClone;
    }
    exportLog(state, "warn", "[export][mat]", logTag, "in-place",
        (main && main.name) || "(unnamed)", "idx", seedIdx);
    return seedIdx;
}

export async function makeMaterialFromThree(state, main, renderOrder) {
    if (!main) return 0;
    // Reuse already-exported materials (shared body/clothes mats) — avoids
    // duplicate material entries; textures are already de-duped by imageMap.
    if (state.materialMap.has(main)) {
        return state.materialMap.get(main);
    }

    // Hybrid: unedited material present in original GLB → reuse seeded entry
    try {
        // Solid blocks canReuseSeededMaterial — still need the seed slot to APPEND-clone.
        let seededIdx = lookupSeededMaterial(state, main);
        if (seededIdx == null && state._seededMaterialByName) {
            try {
                const k = normalizeMaterialName(main.name || "");
                if (k && state._seededMaterialByName.has(k))
                    seededIdx = state._seededMaterialByName.get(k);
            } catch (eName) {}
        }
        if (seededIdx != null) {
            const ud = main.userData || {};
            const nmSeed = main.name || "";
            const isEyeSeed = /eye|iris|highlight|pupil|瞳|目/i.test(nmSeed);
            const mapLip0 = main.map;
            const shadeLip0 = main.shadeMultiplyTexture
                || (main.uniforms && main.uniforms.shadeMultiplyTexture
                    && main.uniforms.shadeMultiplyTexture.value);
            const hasLip0 = !isEyeSeed && !!(ud._lipColorOn
                || (mapLip0 && mapLip0.userData && mapLip0.userData._isLipBake)
                || (shadeLip0 && shadeLip0.userData && shadeLip0.userData._isLipBake));
            const skipLip = !!(state.exportOptions && (state.exportOptions.skipInternalLipPatch
                || state.exportOptions.skipLipExport));
            const wantsLipHere = hasLip0 && !skipLip;
            // Tint APPEND only when user actually edited skin (avoids extra mats on body-only)
            const skinUser = !!(state.exportOptions && state.exportOptions.skinFilterUserEdited);
            const wantsTint = !!(skinUser && ud._skinTintApplied && ud._compColorMode !== "solid"
                && !ud._skinSolidBackup);
            // Solid fill: seed-clone + white map + color factors (full rebuild left OOB tex).
            const wantsSolid = !isEyeSeed && !!(
                ud._compColorMode === "solid" || ud._skinSolidBackup
                || (typeof ud._solidHex === "string" && ud._solidHex.length > 0)
                || ud._isSolidNailMat
            );

            // Eyes: keep SEEDED frozen (original GLB material + atlas + blendMode).
            // v6: no Cutout force, no isolate — shared FaceMouth atlas + original
            // Transparent (2) matches pristine and avoids pure-black on reload.
            if (isEyeSeed) {
                state.materialMap.set(main, seededIdx);
                exportLog(state, "warn", "[export][mat] SEEDED frozen (eye, no-cutout)",
                    nmSeed, "→", seededIdx);
                return seededIdx;
            }

            // Lip / filterTint / solid: APPEND a clone so eye seeded slots stay untouched.
            if (wantsLipHere || wantsTint || wantsSolid) {
                try {
                    const base = state.materials[seededIdx];
                    const clone = JSON.parse(JSON.stringify(base));
                    let logTag = "SEEDED";
                    let propsClone = null;
                    if (state.metaVersion == 0 && state.extensions.VRM
                        && Array.isArray(state.extensions.VRM.materialProperties)
                        && state.extensions.VRM.materialProperties[seededIdx]) {
                        propsClone = JSON.parse(JSON.stringify(
                            state.extensions.VRM.materialProperties[seededIdx]));
                    }

                    if (wantsTint) {
                        logTag += "+filterTint";
                        // Prefer UI hex → sRGB (same as glb-material-patch F1 path).
                        // Live filter sets shade = same hex; do not use linear .r/.g/.b.
                        const a = (main.opacity != null) ? main.opacity : 1;
                        let fac = null;
                        const hex = (ud && typeof ud._skinFilterHex === "string")
                            ? ud._skinFilterHex : null;
                        if (hex && /^#?[0-9a-fA-F]{6}$/.test(hex)) {
                            const h = hex.replace(/^#/, "");
                            fac = [
                                parseInt(h.slice(0, 2), 16) / 255,
                                parseInt(h.slice(2, 4), 16) / 255,
                                parseInt(h.slice(4, 6), 16) / 255,
                                a
                            ];
                        } else if (main.color) {
                            fac = gamma(main.color, a);
                        }
                        if (fac) {
                            if (!clone.pbrMetallicRoughness) clone.pbrMetallicRoughness = {};
                            clone.pbrMetallicRoughness.baseColorFactor = fac.slice();
                            if (clone.extensions && clone.extensions.VRMC_materials_mtoon) {
                                clone.extensions.VRMC_materials_mtoon.shadeColorFactor =
                                    [fac[0], fac[1], fac[2]];
                            }
                            if (propsClone) {
                                if (!propsClone.vectorProperties) propsClone.vectorProperties = {};
                                propsClone.vectorProperties._Color = fac.slice();
                                propsClone.vectorProperties._ShadeColor =
                                    [fac[0], fac[1], fac[2], 1];
                            }
                        }
                    }

                    if (wantsSolid) {
                        logTag += "+solidFill";
                        const a = (main.opacity != null) ? main.opacity : 1;
                        let fac = null;
                        const shex = (ud && typeof ud._solidHex === "string") ? ud._solidHex : null;
                        if (shex && /^#?[0-9a-fA-F]{6}$/.test(shex)) {
                            const h = shex.replace(/^#/, "");
                            fac = [
                                parseInt(h.slice(0, 2), 16) / 255,
                                parseInt(h.slice(2, 4), 16) / 255,
                                parseInt(h.slice(4, 6), 16) / 255,
                                a
                            ];
                        } else if (main.color) {
                            fac = gamma(main.color, a);
                        }
                        if (fac) {
                            if (!clone.pbrMetallicRoughness) clone.pbrMetallicRoughness = {};
                            clone.pbrMetallicRoughness.baseColorFactor = fac.slice();
                            // Live solid uses shade ≈ lit × 0.65
                            const sh = [fac[0] * 0.65, fac[1] * 0.65, fac[2] * 0.65];
                            if (clone.extensions && clone.extensions.VRMC_materials_mtoon) {
                                clone.extensions.VRMC_materials_mtoon.shadeColorFactor = sh.slice();
                            }
                            if (propsClone) {
                                if (!propsClone.vectorProperties) propsClone.vectorProperties = {};
                                propsClone.vectorProperties._Color = fac.slice();
                                propsClone.vectorProperties._ShadeColor = [sh[0], sh[1], sh[2], 1];
                            }
                        }
                        // Prefer live 1×1 white map from skin solid; fall back to any map.
                        const whiteSrc = main.map || main.userData && main.userData._solidWhiteTex;
                        if (whiteSrc) {
                            try {
                                const texRes = await addTexture(state, whiteSrc, true);
                                if (texRes && texRes.index != null) {
                                    if (!clone.pbrMetallicRoughness) clone.pbrMetallicRoughness = {};
                                    clone.pbrMetallicRoughness.baseColorTexture =
                                        { index: texRes.index };
                                    if (clone.extensions && clone.extensions.VRMC_materials_mtoon) {
                                        clone.extensions.VRMC_materials_mtoon.shadeMultiplyTexture =
                                            { index: texRes.index };
                                    }
                                    if (propsClone) {
                                        if (!propsClone.textureProperties)
                                            propsClone.textureProperties = {};
                                        propsClone.textureProperties._MainTex = texRes.index;
                                        propsClone.textureProperties._ShadeTexture = texRes.index;
                                    }
                                }
                            } catch (eTex) {
                                console.warn("[export][mat] solid white tex failed", eTex);
                            }
                        }
                    }

                    if (wantsLipHere) {
                        logTag += "+lipTex";
                        const lipTex = mapLip0 || shadeLip0;
                        if (lipTex) {
                            const texRes = await addTexture(state, lipTex, true);
                            if (texRes && texRes.index != null) {
                                if (!clone.pbrMetallicRoughness) clone.pbrMetallicRoughness = {};
                                clone.pbrMetallicRoughness.baseColorTexture =
                                    { index: texRes.index };
                                if (clone.extensions && clone.extensions.VRMC_materials_mtoon) {
                                    clone.extensions.VRMC_materials_mtoon.shadeMultiplyTexture =
                                        { index: texRes.index };
                                }
                                if (propsClone) {
                                    if (!propsClone.textureProperties)
                                        propsClone.textureProperties = {};
                                    propsClone.textureProperties._MainTex = texRes.index;
                                    propsClone.textureProperties._ShadeTexture = texRes.index;
                                    if (!propsClone.vectorProperties)
                                        propsClone.vectorProperties = {};
                                    if (lipTex.offset && lipTex.repeat) {
                                        const uv = [lipTex.offset.x, lipTex.offset.y,
                                            lipTex.repeat.x, lipTex.repeat.y];
                                        propsClone.vectorProperties._MainTex = uv;
                                        propsClone.vectorProperties._ShadeTexture = uv;
                                    }
                                }
                            }
                        }
                    }

                    // Always APPEND — never mutate seeded slots in-place
                    const outIdx = commitMaterialClone(
                        state, seededIdx, clone, propsClone, logTag, main, false);
                    state.materialMap.set(main, outIdx);
                    return outIdx;
                } catch (eEdit) {
                    console.warn("[export][mat] seeded edit (tint/lip) failed", eEdit);
                }
            }
            // Isolation: unedited materials stay byte-identical to original GLB.
            state.materialMap.set(main, seededIdx);
            exportLog(state, "warn", "[export][mat] SEEDED frozen",
                main.name || "(unnamed)", "→", seededIdx);
            return seededIdx;
        }
        const nm0 = main.name || "";
        if (/eye|pupil|iris|瞳|目/i.test(nm0)) {
            exportLog(state, "warn", "[export][mat] eye-like NOT seeded (rebuild)", nm0);
        }

        // Lip: clone seeded mat + swap only map/shade textures (avoid full rebuild).
        // Never treat eye materials as lip targets (black-eye regression).
        const udLip = main.userData || {};
        const mapLip = main.map;
        const shadeLip = main.shadeMultiplyTexture
            || (main.uniforms && main.uniforms.shadeMultiplyTexture
                && main.uniforms.shadeMultiplyTexture.value);
        const nmLip = main.name || "";
        const isEyeMat = /eye|iris|highlight|pupil|瞳|目/i.test(nmLip);
        const isLipMat = !isEyeMat && !!(udLip._lipColorOn
            || (mapLip && mapLip.userData && mapLip.userData._isLipBake)
            || (shadeLip && shadeLip.userData && shadeLip.userData._isLipBake));
        if (isLipMat && state._seededMaterialByName) {
            const key = normalizeMaterialName(main.name || "");
            const seedIdx = key && state._seededMaterialByName.has(key)
                ? state._seededMaterialByName.get(key) : null;
            if (seedIdx != null && state.materials[seedIdx]) {
                const base = state.materials[seedIdx];
                const clone = JSON.parse(JSON.stringify(base));
                const lipTex = mapLip || shadeLip;
                if (lipTex) {
                    const texRes = await addTexture(state, lipTex, true);
                    if (texRes && texRes.index != null) {
                        if (!clone.pbrMetallicRoughness) clone.pbrMetallicRoughness = {};
                        clone.pbrMetallicRoughness.baseColorTexture = { index: texRes.index };
                        if (clone.extensions && clone.extensions.VRMC_materials_mtoon) {
                            clone.extensions.VRMC_materials_mtoon.shadeMultiplyTexture = { index: texRes.index };
                        }
                        // Prefer app-level glb-texture-patch; if we still get here,
                        // never overwrite seeded slots.
                        if (state.exportOptions && (state.exportOptions.skipInternalLipPatch
                                || state.exportOptions.skipLipExport)) {
                            exportLog(state, "warn", "[export][mat] lipTex skipped (skipInternalLipPatch)");
                            state.materialMap.set(main, seedIdx);
                            return seedIdx;
                        }
                        let propsClone = null;
                        if (state.metaVersion == 0 && state.extensions.VRM
                            && Array.isArray(state.extensions.VRM.materialProperties)
                            && state.extensions.VRM.materialProperties[seedIdx]) {
                            propsClone = JSON.parse(JSON.stringify(
                                state.extensions.VRM.materialProperties[seedIdx]));
                            if (!propsClone.textureProperties) propsClone.textureProperties = {};
                            propsClone.textureProperties._MainTex = texRes.index;
                            propsClone.textureProperties._ShadeTexture = texRes.index;
                            if (!propsClone.vectorProperties) propsClone.vectorProperties = {};
                            if (lipTex.offset && lipTex.repeat) {
                                const uv = [lipTex.offset.x, lipTex.offset.y,
                                    lipTex.repeat.x, lipTex.repeat.y];
                                propsClone.vectorProperties._MainTex = uv;
                                propsClone.vectorProperties._ShadeTexture = uv;
                            }
                        }
                        const outIdx = commitMaterialClone(
                            state, seedIdx, clone, propsClone, "SEEDED+lipTex", main);
                        state.materialMap.set(main, outIdx);
                        exportLog(state, "warn", "[export][mat] SEEDED+lipTex",
                            main.name || "(unnamed)", "idx", outIdx, "tex", texRes.index);
                        return outIdx;
                    }
                }
            }
        }
    } catch (e) {}

    try {
        const nm = main.name || "";
        if (/hair|kami|髪|HAIR/i.test(nm) || main.shadeMultiplyTexture
            || (main.uniforms && main.uniforms.shadeMultiplyTexture && main.uniforms.shadeMultiplyTexture.value)) {
            let sc = null;
            try {
                if (main.shadeColorFactor && main.shadeColorFactor.isColor) sc = [main.shadeColorFactor.r, main.shadeColorFactor.g, main.shadeColorFactor.b];
                else if (main.uniforms && main.uniforms.shadeColorFactor && main.uniforms.shadeColorFactor.value)
                    sc = [main.uniforms.shadeColorFactor.value.r, main.uniforms.shadeColorFactor.value.g, main.uniforms.shadeColorFactor.value.b];
            } catch (e) {}
            exportLog(state, "verbose", "[export][mat]", nm,
                "type=", main.type || main.constructor && main.constructor.name,
                "side=", main.side,
                "shadeColor=", sc,
                "hasShadeMul=", !!(main.shadeMultiplyTexture || (main.uniforms && main.uniforms.shadeMultiplyTexture && main.uniforms.shadeMultiplyTexture.value)),
                "hasMap=", !!main.map,
                "metaVersion=", state.metaVersion);
        }
    } catch (e) {}

    const material = {};
    if (main.name) material.name = main.name;
    material.extensions = {};
    material.extensions.KHR_materials_unlit = {};

    // Base color / alpha maps need PNG when the material uses transparency or cutout.
    const alphaTestVal = (main.alphaTest != null) ? main.alphaTest
        : ((main._alphaTest != null) ? main._alphaTest : 0);
    const needsAlpha = !!(
        main.transparent === true ||
        alphaTestVal > 0 ||
        main.alphaMap
    );

    const PBR = {};
    material.pbrMetallicRoughness = PBR;
    const ud = main.userData || {};
    // Solid fill: explicit flags, or materials created by applyWholeMeshSolid /
    // makeSolidColorMaterial (_solidHex is always set on those).
    const isSolidFill = !!(
        ud._isSolidNailMat ||
        ud._isLipSolidMat ||
        ud._compColorMode === "solid" ||
        ud._skinSolidBackup ||
        (typeof ud._solidHex === "string" && ud._solidHex.length > 0) ||
        (main.isMeshBasicMaterial && ud._solidPreserveAlpha)
    );
    // Solid fill colour: prefer _solidHex, then material.color, then shadeColorFactor
    let col = new THREE.Color(1, 1, 1);
    if (typeof ud._solidHex === "string") {
        try { col.set(ud._solidHex); } catch (e) { /* white */ }
    } else if (main.color && typeof main.color.r === "number") {
        col.setRGB(main.color.r, main.color.g, main.color.b);
    } else if (main.shadeColorFactor) {
        try {
            const s = main.shadeColorFactor;
            if (s.isColor) col.copy(s);
            else if (s.r != null) col.setRGB(s.r, s.g, s.b);
        } catch (e) { /* keep */ }
    }
    const opacity = (main.opacity != null) ? main.opacity : 1;
    PBR.baseColorFactor = [col.r, col.g, col.b, opacity];
    PBR.metallicFactor = 0;
    PBR.roughnessFactor = 0.9;

    // Keep cutout whenever solid fill has any mask source (flag, bake, or map).
    // つめ (_isSolidNailMat / _extractedSolid) はメッシュ形状で切り抜き済みなので
    // 体アトラス由来の map を追従させない（再エンコードでファイル肥大化の主因）。
    // 肌タブ塗りつぶし (_skinSolidBackup) は map を 1×1 白に差し替えているだけなので
    // cutout 扱いにしない（MASK/UnlitCutout にすると再ロードで肌が消える）。
    const nailPureSolid = !!(ud._isSolidNailMat || ud._extractedSolid)
        && !ud._solidPreserveAlpha;
    const skinSolidOpaque = !!(ud._skinSolidBackup
        || (ud._skinTintApplied && ud._compColorMode === "solid"));
    const solidKeepAlpha = !!(isSolidFill && !nailPureSolid && !skinSolidOpaque && (
        ud._solidPreserveAlpha ||
        ud._solidBakedMap ||
        // main.map alone is NOT enough: skin solid leaves a 1×1 white map
        ud._solidSrcMap ||
        ud._solidSrcAlphaMap ||
        main.alphaMap
    ));
    if (isSolidFill) {
        try {
            exportLog(state, "verbose", "[export] solid fill material", main.name || "(unnamed)",
                "keepAlpha=", solidKeepAlpha,
                "alphaTest=", alphaTestVal,
                "hasMap=", !!(main.map || ud._solidBakedMap),
                "hex=", ud._solidHex);
        } catch (e) {}
    }
    // Hoisted so VRM0 materialProperties can read UV / coloured bake from the
    // same source used above (previously block-scoped → ReferenceError on export).
    let solidAlphaSrcForBake = null;
    let solidUvSrcTex = null;
    let solidBakedCanvas = null;
    // Solid fills: no albedo pattern textures — but keep map/alphaMap when the
    // original material used cutout/blend transparency (brows, lashes, etc.).
    if (!isSolidFill) {
        if (main.map) {
            const t = await addTexture(state, main.map, needsAlpha);
            if (t && t.index != null) PBR.baseColorTexture = t;
        }
        if (main.emissiveMap) {
            const t = await addTexture(state, main.emissiveMap, false);
            if (t && t.index != null) material.emissiveTexture = t;
        }
        if (main.emissive) {
            if (state.metaVersion == 0) {
                material.emissiveFactor = gamma(main.emissive);
            } else {
                material.emissiveFactor = main.emissive.toArray();
            }
        }
        if (main.normalMap) {
            const t = await addTexture(state, main.normalMap, false);
            if (t && t.index != null) material.normalTexture = t;
        }
        if (main.occlusionTexture) {
            const t = await addTexture(state, main.occlusionTexture, false);
            if (t && t.index != null) {
                material.occlusionTexture = t;
                material.occlusionTexture.strength = 1;
            }
        }
    } else if (solidKeepAlpha) {
        // Texture = white RGB + cutout A. Colour = baseColorFactor (_solidHex).
        const srcMap = (main.userData && main.userData._solidSrcMap) || null;
        const srcAlphaMap = (main.userData && main.userData._solidSrcAlphaMap) || null;
        const alphaSrcTex =
            srcMap
            || srcAlphaMap
            || main.alphaMap
            || main.map
            || null;
        solidAlphaSrcForBake = alphaSrcTex;
        if (solidAlphaSrcForBake && solidAlphaSrcForBake.userData && solidAlphaSrcForBake.userData._isSolidAlphaBake) {
            solidAlphaSrcForBake = srcMap || srcAlphaMap || null;
        }
        // Texture = solid colour RGB + cutout A.
        // Colour is embedded in the texture so loaders that ignore / default
        // baseColorFactor and _Color still show the fill (common with MToon
        // cutout paths). Factors are forced to white so MToon multiply
        // (_MainTex * _Color) does not double-tint.
        let embedCol = { r: col.r, g: col.g, b: col.b };
        if (typeof ud._solidHex === "string" && /^#?[0-9a-fA-F]{6}$/.test(ud._solidHex)) {
            const h = ud._solidHex.replace("#", "");
            embedCol = {
                r: parseInt(h.slice(0, 2), 16) / 255,
                g: parseInt(h.slice(2, 4), 16) / 255,
                b: parseInt(h.slice(4, 6), 16) / 255
            };
        }
        const rr = Math.max(0, Math.min(255, Math.round(embedCol.r * 255)));
        const gg = Math.max(0, Math.min(255, Math.round(embedCol.g * 255)));
        const bb = Math.max(0, Math.min(255, Math.round(embedCol.b * 255)));
        solidBakedCanvas = null;
        let bakeFrom = "none";
        const srcImg = textureImageSource(solidAlphaSrcForBake);

        // 1) Prefer runtime white+A bake (correct mask including luminance).
        //    Re-colour RGB to the solid tint; keep alpha mask as-is.
        const runtimeBake = main.userData && main.userData._solidBakedMap;
        if (runtimeBake && runtimeBake.userData && runtimeBake.userData._isSolidAlphaBake) {
            const rbImg = textureImageSource(runtimeBake);
            if (rbImg) {
                try {
                    const w = rbImg.width || rbImg.videoWidth || 0;
                    const h = rbImg.height || rbImg.videoHeight || 0;
                    if (w && h) {
                        const c = document.createElement("canvas");
                        c.width = w; c.height = h;
                        const ctx = c.getContext("2d", { willReadFrequently: true });
                        ctx.drawImage(rbImg, 0, 0, w, h);
                        const imgData = ctx.getImageData(0, 0, w, h);
                        const d = imgData.data;
                        let keptA = 0;
                        // Binary alpha: opaque solid colour or fully transparent.
                        // Soft alpha + failed alphaTest was showing black fringes.
                        const aThresh = 128;
                        for (let i = 0; i < d.length; i += 4) {
                            const a = d[i + 3];
                            if (a >= aThresh) {
                                keptA++;
                                d[i] = rr; d[i + 1] = gg; d[i + 2] = bb;
                                d[i + 3] = 255;
                            } else {
                                d[i] = 0; d[i + 1] = 0; d[i + 2] = 0;
                                d[i + 3] = 0;
                            }
                        }
                        ctx.putImageData(imgData, 0, 0);
                        solidBakedCanvas = c;
                        bakeFrom = "runtimeBake";
                        exportLog(state, "verbose", "[export] colour+A from runtime bake, opaquePx~", keptA, "size=", w, "x", h,
                            "mode=", runtimeBake.userData._solidAlphaMode || "?",
                            "rgb=", [rr, gg, bb]);
                    }
                } catch (e) {
                    exportLog(state, "verbose", "[export] copy runtime bake failed", e);
                }
            }
        }

        // 2) Fallback: bake white+A from original src with proper channel detection
        if (!solidBakedCanvas && srcImg) {
            let channel = "alpha";
            const fromAlphaMap = !!(solidAlphaSrcForBake && (
                solidAlphaSrcForBake === srcAlphaMap ||
                solidAlphaSrcForBake === main.alphaMap ||
                (solidAlphaSrcForBake.userData && solidAlphaSrcForBake.userData._solidAlphaMode === "alphaMapR")
            ));
            if (fromAlphaMap) {
                channel = "red";
            } else {
                // Probe alpha variance — flat A on opaque atlas → luminance mask
                // (brows/lashes painted in RGB only).
                try {
                    const probeW = Math.min(64, srcImg.width || srcImg.videoWidth || 0);
                    const probeH = Math.min(64, srcImg.height || srcImg.videoHeight || 0);
                    if (probeW && probeH) {
                        const pc = document.createElement("canvas");
                        pc.width = probeW; pc.height = probeH;
                        const pctx = pc.getContext("2d", { willReadFrequently: true });
                        if (pctx) {
                            pctx.drawImage(srcImg, 0, 0, probeW, probeH);
                            const pd = pctx.getImageData(0, 0, probeW, probeH).data;
                            let minA = 255, maxA = 0;
                            for (let i = 0; i < pd.length; i += 16) {
                                const a = pd[i + 3];
                                if (a < minA) minA = a;
                                if (a > maxA) maxA = a;
                            }
                            if ((maxA - minA) <= 40) channel = "luminance";
                        }
                    }
                } catch (e) { /* keep alpha */ }
            }
            solidBakedCanvas = bakeWhiteAlphaCanvas(srcImg, channel, embedCol);
            if (solidBakedCanvas) bakeFrom = "src:" + channel;
        }

        // Colour in BOTH texture RGB and factors.
        // Some loaders ignore factors (need tex colour); others ignore tex RGB for
        // cutout MToon (need factor colour). Same tint in both ensures visibility.
        // MToon multiply may slightly darken (colour²) but remains clearly tinted.
        solidUvSrcTex = solidAlphaSrcForBake || main.map || null;
        PBR.baseColorFactor = [embedCol.r, embedCol.g, embedCol.b, opacity != null ? opacity : 1];
        ud._solidColorInTexture = true;
        try {
            console.warn("[export] solid texRGB+factor=", [embedCol.r, embedCol.g, embedCol.b].map(v => +Number(v).toFixed(3)),
                "hasBake=", !!solidBakedCanvas, "from=", bakeFrom, "colorInTex=", true);
        } catch (e) {}
        if (solidBakedCanvas) {
            const bakeKey = { _solidBake: true, canvas: solidBakedCanvas };
            let imageIndex = state.imageMap.findIndex((v) => v && v._solidBake && v.canvas === solidBakedCanvas);
            if (imageIndex < 0) {
                imageIndex = await addImage(state, solidBakedCanvas, (main.name || "solid") + "_cutout", false, true);
                state.imageMap[imageIndex] = bakeKey;
            }
            const texDef = {
                name: (main.name || "solid") + "_cutout",
                sampler: addSampler(state, solidAlphaSrcForBake || { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729 }),
                source: imageIndex,
            };
            const texKey = "solidAlpha|" + imageIndex;
            let texIndex;
            if (state.textureMap.has(texKey)) {
                texIndex = state.textureMap.get(texKey);
            } else {
                texIndex = state.textures.length;
                state.textures.push(texDef);
                state.textureMap.set(texKey, texIndex);
            }
            PBR.baseColorTexture = { index: texIndex };
            {
                // 通常の addTexture() は非等倍の offset/repeat を KHR_texture_transform として
                // 付与するが、この焼き込み済みキャンバスの経路はそれを素通りしていた。
                // 元テクスチャが UV変換を使っていた場合に備え、同じ規則を適用する。
                if (solidUvSrcTex && solidUvSrcTex.offset && solidUvSrcTex.repeat &&
                    (solidUvSrcTex.offset.x !== 0 || solidUvSrcTex.offset.y !== 0 || solidUvSrcTex.repeat.x !== 1 || solidUvSrcTex.repeat.y !== 1)) {
                    PBR.baseColorTexture.extensions = {
                        KHR_texture_transform: {
                            offset: [solidUvSrcTex.offset.x, solidUvSrcTex.offset.y],
                            scale: [solidUvSrcTex.repeat.x, solidUvSrcTex.repeat.y]
                        }
                    };
                }
            }
        } else if (alphaSrcTex) {
            const t = await addTexture(state, alphaSrcTex, true);
            if (t) PBR.baseColorTexture = t;
        }
    } else if (isSolidFill) {
        // Solid without alpha — pure colour, no texture
        PBR.baseColorFactor = [col.r, col.g, col.b, opacity];
    }

    // Solid+alpha: use MASK (TransparentCutout). Binary alpha bake already makes
    // A either 0 or 255, so alphaTest/cutoff discards cleanly with no black
    // fringes. Full BLEND made these parts appear "transparent" in viewers
    // (and in non-MToon shading modes) even though VRoid/Studio expect cutout
    // for brows/lashes/hair ornaments. Other cutouts stay MASK.
    const effectiveAlphaTest = (alphaTestVal > 0) ? alphaTestVal : (solidKeepAlpha ? 0.5 : 0);
    if (main.transparent == true && !solidKeepAlpha && !isSolidFill) {
        material.alphaMode = 'BLEND';
    } else if (effectiveAlphaTest > 0 || solidKeepAlpha) {
        material.alphaMode = 'MASK';
        material.alphaCutoff = effectiveAlphaTest > 0 ? effectiveAlphaTest : 0.5;
    } else {
        material.alphaMode = 'OPAQUE';
    }
    if (main.side == 2)
        material.doubleSided = true;

    const index = state.materials.length;
    state.materials.push(material);
    state.materialMap.set(main, index);

    if (isSolidFill && solidKeepAlpha) {
        // Solid cutout: use UnlitCutout (not MToon). MToon was ignoring the solid tint
        // on round-trip even when _MainTex and _Color both carried the colour;
        // non-MToon materials already showed the tint correctly. Emit a simple
        // cutout unlit so shape (MASK) + colour both survive reload.
        // Binary alpha bake + MASK/cutoff matches VRoid Studio expectation
        // (TransparentCutout, not full Transparent).
        let solidRgb = [col.r, col.g, col.b];
        if (typeof ud._solidHex === "string" && /^#?[0-9a-fA-F]{6}$/.test(ud._solidHex)) {
            const h = ud._solidHex.replace("#", "");
            solidRgb = [
                parseInt(h.slice(0, 2), 16) / 255,
                parseInt(h.slice(2, 4), 16) / 255,
                parseInt(h.slice(4, 6), 16) / 255
            ];
        }
        // Ensure PBR baseColorFactor has the tint (unlit path)
        PBR.baseColorFactor = [solidRgb[0], solidRgb[1], solidRgb[2], opacity != null ? opacity : 1];
        // Keep KHR_materials_unlit (already set at top of makeMaterialFromThree)
        // Do NOT call makeMToon / makeMaterialProperties — those force MToon.
        if (state.metaVersion == 0) {
            // UnlitCutout + MASK: binary alpha + cutoff discards A=0 cleanly.
            // Prefer this over UnlitTransparent so VRoid/Studio and other
            // viewers treat the part as cutout (not soft-transparent).
            const colorVec = [solidRgb[0], solidRgb[1], solidRgb[2], opacity != null ? opacity : 1];
            const cutoff = effectiveAlphaTest > 0 ? effectiveAlphaTest : 0.5;
            const properties = {
                name: main.name || "SolidFill",
                shader: "VRM/UnlitCutout",
                renderQueue: 2450,
                floatProperties: {
                    _CullMode: main.side === 2 ? 0 : 2,
                    _BlendMode: 1,
                    _Cutoff: cutoff,
                    _ZWrite: 1
                },
                vectorProperties: {
                    _Color: colorVec
                },
                textureProperties: {},
                keywordMap: { _ALPHATEST_ON: true },
                tagMap: { RenderType: "TransparentCutout" }
            };
            if (PBR.baseColorTexture && PBR.baseColorTexture.index != null) {
                properties.textureProperties._MainTex = PBR.baseColorTexture.index;
                const uvSrcTex = solidUvSrcTex || solidAlphaSrcForBake || null;
                properties.vectorProperties._MainTex = (uvSrcTex && uvSrcTex.offset && uvSrcTex.repeat)
                    ? [uvSrcTex.offset.x, uvSrcTex.offset.y, uvSrcTex.repeat.x, uvSrcTex.repeat.y]
                    : [0, 0, 1, 1];
            }
            if (!state.extensions.VRM.materialProperties) state.extensions.VRM.materialProperties = [];
            state.extensions.VRM.materialProperties[index] = properties;
            state.materialQueue.push({
                renderType: "TransparentCutout",
                properties,
                renderOrder: renderOrder || 0
            });
            try {
                exportLog(state, "verbose", "[export] VRM0 solid UnlitCutout _Color=", colorVec.map(v => +Number(v).toFixed(3)),
                    "cutoff=", cutoff,
                    "mainTexIdx=", properties.textureProperties._MainTex);
            } catch (e) {}
        } else if (state.metaVersion == 1) {
            try {
                exportLog(state, "verbose", "[export] VRM1 solid unlit MASK factor=", solidRgb.map(v => +Number(v).toFixed(3)),
                    "hasTex=", !!(PBR.baseColorTexture && PBR.baseColorTexture.index != null));
            } catch (e) {}
        }
        try {
            exportLog(state, "verbose", "[export] solid+cutout done", main.name,
                "alphaMode=", material.alphaMode,
                "hasTex=", !!(PBR.baseColorTexture && PBR.baseColorTexture.index != null),
                "shader=UnlitCutout",
                "type=", main.type || (main.constructor && main.constructor.name));
        } catch (e) {}
    } else if (isSolidFill) {
        // Pure solid colour, no cutout
        if (state.metaVersion == 1) {
            const mToon = {
                specVersion: "1.0",
                shadeColorFactor: [col.r, col.g, col.b],
                shadingToonyFactor: 0.9,
                shadingShiftFactor: 0.0,
                giEqualizationFactor: 0.9,
                outlineWidthMode: "none",
                outlineWidthFactor: 0
            };
            if (!state.extensionsUsed.includes('VRMC_materials_mtoon'))
                state.extensionsUsed.push('VRMC_materials_mtoon');
            state.materials[index].extensions.VRMC_materials_mtoon = mToon;
        } else if (state.metaVersion == 0) {
            const colorVec = gamma(col, opacity);
            const properties = {
                name: main.name || "SolidFill",
                shader: "VRM/MToon",
                renderQueue: 2000,
                floatProperties: {
                    _CullMode: main.side === 2 ? 0 : 2,
                    _ShadeShift: -0.5,
                    _ShadeToony: 0.9,
                    _BlendMode: 0,
                    _Cutoff: 0,
                    _OutlineWidth: 0
                },
                vectorProperties: { _Color: colorVec, _ShadeColor: colorVec },
                textureProperties: {},
                keywordMap: {},
                tagMap: { RenderType: "Opaque" }
            };
            if (!state.extensions.VRM.materialProperties) state.extensions.VRM.materialProperties = [];
            state.extensions.VRM.materialProperties[index] = properties;
            state.materialQueue.push({
                renderType: "Opaque",
                properties,
                renderOrder: renderOrder || 0
            });
        }
        try {
            exportLog(state, "verbose", "[export] pure solid done", main.name, "alphaMode=", material.alphaMode);
        } catch (e) {}
    } else {
        if (state.metaVersion == 1) await makeMToon(state, main, renderOrder);
        if (state.metaVersion == 0) await makeMaterialProperties(state, main, renderOrder);
    }

    return index;
}

export async function makeMaterial(state, primitive) {
    // Default: first material (outline slot is ignored for the base primitive).
    // Multi-material meshes with geometry.groups are handled in makeMesh2 /
    // makeMesh by calling makeMaterialFromThree per group.
    const main = Array.isArray(primitive.material) ? primitive.material[0] : primitive.material;
    return makeMaterialFromThree(state, main, primitive.renderOrder);
}

/**
 * geometry.groups を materialIndex ごとにまとめ、各 material の index 配列を返す。
 * つめ塗りつぶしで group が細かく分断されていると primitive が数千になり
 * 再ロードが遅くなるため、エクスポート時に必ず合体する。
 * @returns {{ materialIndex: number, indices: number[] }[]}
 */
