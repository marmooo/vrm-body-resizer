/**
 * Morpholith export — VRM buffer split / bind / axis-conversion helpers.
 * Used for legacy conversion paths; main export goes through VRMExport.
 */
import { ItemSize, ComponentFunc } from "./constants.js";

export function splitBuffer(vrmBuffer) {
    const view = new DataView(vrmBuffer);
    const magic = view.getUint32(0, true);
    if (magic !== 0x46546C67) return error('Not a VRM File (magic).');
    const version = view.getUint32(4, true);
    if (version !== 2) return error('VRM version must be 2.');
    const length = view.getUint32(8, true);
    if (length !== vrmBuffer.byteLength) return error('Data length mismatch.');

    const jsonChunkDataLength = view.getUint32(12, true);
    const jsonChunkType = view.getUint32(16, true);
    if (jsonChunkType !== 0x4E4F534A) return console.error('First chunk is not JSON');
    const jsonChunkData = vrmBuffer.slice(20, 20 + jsonChunkDataLength);

    const binChunkOffset = 20 + jsonChunkDataLength;
    const binChunkDataLength = view.getUint32(binChunkOffset, true);
    const binChunkType = view.getUint32(binChunkOffset + 4, true);
    if (binChunkType !== 0x004E4942) return console.error('Second chunk is not BIN');
    const binChunkData = vrmBuffer.slice(binChunkOffset + 8, binChunkOffset + 8 + binChunkDataLength);
    return { jsonChunkData, binChunkData, jsonChunkDataLength, binChunkDataLength };
}

export function bindBuffers({ jsonChunkData, binChunkData }) {
    const totalLength = 12 + 8 + jsonChunkData.byteLength + 8 + binChunkData.byteLength;
    const buffer = new ArrayBuffer(totalLength);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    let offset = 0;
    view.setUint32(offset, 0x46546C67, true); offset += 4;
    view.setUint32(offset, 2, true); offset += 4;
    view.setUint32(offset, totalLength, true); offset += 4;

    view.setUint32(offset, jsonChunkData.byteLength, true); offset += 4;
    view.setUint32(offset, 0x4E4F534A, true); offset += 4;
    uint8.set(new Uint8Array(jsonChunkData), offset); offset += jsonChunkData.byteLength;

    view.setUint32(offset, binChunkData.byteLength, true); offset += 4;
    view.setUint32(offset, 0x004E4942, true); offset += 4;
    uint8.set(new Uint8Array(binChunkData), offset);

    return buffer;
}

export async function getData({ jsonChunkData, binChunkData }) {
    const jsonText = new TextDecoder().decode(jsonChunkData);
    const json = JSON.parse(jsonText);
    const imageBitmaps = [];
    for (let i = 0; i < json.images.length; i++) {
        const image = json.images[i];
        const bufferView = json.bufferViews[image.bufferView];
        const imageBuffer = binChunkData.slice(bufferView.byteOffset, bufferView.byteOffset + bufferView.byteLength);
        const blob = new Blob([imageBuffer], { type: image.mimeType });
        imageBitmaps[i] = await createImageBitmap(blob);
    }

    const data = [];
    for (let i = 0; i < json.accessors.length; i++) {
        const accessor = json.accessors[i];
        const itemSize = ItemSize[accessor.type];
        const length = itemSize * accessor.count;
        const bufferView = json.bufferViews[accessor.bufferView];
        const ArrayType = ComponentFunc[accessor.componentType];
        let array = null;
        if (accessor.bufferView !== undefined) {
            const byteOffset = (bufferView.byteOffset || 0) + (accessor.byteOffset || 0);
            array = new ArrayType(binChunkData, byteOffset, length);
        } else {
            array = new ArrayType(length);
        }
        if (accessor.sparse) {
            const s = accessor.sparse;
            const indicesBufferView = json.bufferViews[s.indices.bufferView];
            const indicesByteOffset = (indicesBufferView.byteOffset || 0) + (s.indices.byteOffset || 0);
            const indicesArrayType = ComponentFunc[s.indices.componentType];
            const indices = new indicesArrayType(binChunkData, indicesByteOffset, s.count);

            const valuesBufferView = json.bufferViews[s.values.bufferView];
            const valuesByteOffset = (valuesBufferView.byteOffset || 0) + (s.values.byteOffset || 0);
            const valuesArrayType = ComponentFunc[accessor.componentType];
            const values = new valuesArrayType(binChunkData, valuesByteOffset, s.count * itemSize);

            for (let j = 0; j < s.count; j++) {
                for (let k = 0; k < itemSize; k++) {
                    array[itemSize * indices[j] + k] = values[itemSize * j + k];
                }
            }
        }
        data.push(array);
    }
    return { json, imageBitmaps, data };
}

export async function putData({ json, imageBitmaps, data }) {
    const newBufferViews = [];
    const arrays = [];
    let byteOffset = 0;
    for (let i = 0; i < json.images.length; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = imageBitmaps[i].width;
        canvas.height = imageBitmaps[i].height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmaps[i], 0, 0);
        const blob = await new Promise(resolve =>
            canvas.toBlob(resolve, 'image/png')
        );
        const imageBuffer = await blob.arrayBuffer();

        const byteLength = imageBuffer.byteLength;
        const byteLength4 = (byteLength + 3) & ~3;
        const bufferView = { buffer: 0, byteLength, byteOffset };
        byteOffset += byteLength4;
        json.images[i].bufferView = newBufferViews.length;
        json.images[i].mimeType = 'image/png';
        newBufferViews.push(bufferView);
        const array = new Uint8Array(byteLength4);
        array.set(new Uint8Array(imageBuffer));
        arrays.push(array);
    }
    const newAccessors = [];
    for (let i = 0; i < json.accessors.length; i++) {
        const accessor = json.accessors[i];
        const byteLength = data[i].byteLength;
        const byteLength4 = (byteLength + 3) & ~3;
        const bufferView = { buffer: 0, byteLength, byteOffset };
        byteOffset += byteLength4;
        newAccessors[i] = { type: accessor.type, count: accessor.count, componentType: accessor.componentType, byteOffset: 0 };
        newAccessors[i].bufferView = newBufferViews.length;
        if (accessor.normalized) newAccessors[i].normalized = json.accessors[i].normalized;
        if (accessor.min) newAccessors[i].min = json.accessors[i].min;
        if (accessor.max) newAccessors[i].max = json.accessors[i].max;
        newBufferViews.push(bufferView);
        const array = new Uint8Array(byteLength4);
        array.set(new Uint8Array(data[i].buffer, data[i].byteOffset, data[i].byteLength));
        arrays.push(array);
    }
    json.accessors = newAccessors;
    const binChunkData = new ArrayBuffer(byteOffset);
    const binView = new Uint8Array(binChunkData);
    for (let i = 0; i < arrays.length; i++) {
        binView.set(arrays[i], newBufferViews[i].byteOffset);
    }
    json.bufferViews = newBufferViews;
    json.buffers = [{ byteLength: binChunkData.byteLength }];
    const jsonText = JSON.stringify(json);
    const jsonBuffer = new TextEncoder().encode(jsonText);
    const byteLength = (jsonBuffer.length + 3) & ~3;
    const jsonChunkData = new Uint8Array(byteLength);
    jsonChunkData.set(jsonBuffer);
    jsonChunkData.fill(0x20, jsonBuffer.length);

    return { jsonChunkData, binChunkData };
}

function rotateGeometry({ json, data }) {
    const toInvert = new Set();
    if (json.meshes) {
        json.meshes.forEach(mesh => {
            mesh.primitives.forEach(primitive => {
                const attributes = primitive.attributes;
                if (attributes.POSITION !== undefined) toInvert.add(attributes.POSITION);
                if (attributes.NORMAL !== undefined) toInvert.add(attributes.NORMAL);
                if (primitive.targets) {
                    primitive.targets.forEach(target => {
                        if (target.POSITION !== undefined) toInvert.add(target.POSITION);
                        if (target.NORMAL !== undefined) toInvert.add(target.NORMAL);
                    });
                }
            });
        });
    }

    toInvert.forEach(index => {
        const accessor = json.accessors[index];
        //const vectors = data[accessor.bufferView];
        const vectors = data[index];
        if (accessor && vectors && accessor.type === 'VEC3') {
            for (let i = 0; i < vectors.length; i += 3) {
                vectors[i] = -vectors[i];
                vectors[i + 2] = -vectors[i + 2];
            }
        } else {
            console.warn('Accessor to invert is not VEC3 or has no data', accessor);
        }
        if (accessor.min && accessor.max) {
            const maxX = accessor.max[0];
            const maxZ = accessor.max[2];
            accessor.max[0] = -accessor.min[0];
            accessor.max[2] = -accessor.min[2];
            accessor.min[0] = -maxX;
            accessor.min[2] = -maxZ;
        }
    });
    json.skins.forEach(skin => {
        if (skin.inverseBindMatrices !== undefined) {
            const accessor = json.accessors[skin.inverseBindMatrices];
            //const matrices = data[accessor.bufferView];
            const matrices = data[skin.inverseBindMatrices];

            for (let i = 0; i < matrices.length; i += 16) {
                // Translation
                matrices[i + 12] = -matrices[i + 12];
                matrices[i + 14] = -matrices[i + 14];
                // Rotation
                matrices[i + 1] = -matrices[i + 1];
                matrices[i + 4] = -matrices[i + 4];
                matrices[i + 6] = -matrices[i + 6];
                matrices[i + 9] = -matrices[i + 9];
            }
        }
    });
}

function rotateBones({ json }) {
    json.nodes.forEach(node => {
        if (node.translation) {
            node.translation[0] = -node.translation[0]; // X
            node.translation[2] = -node.translation[2]; // Z
        }
        if (node.rotation) {
            const [x, y, z, w] = node.rotation;
            node.rotation = [-x, y, -z, w];
        }
    });
    const firstPersonBoneOffset = json.extensions.VRM.firstPerson.firstPersonBoneOffset;
    firstPersonBoneOffset.x = -firstPersonBoneOffset.x;
    firstPersonBoneOffset.z = -firstPersonBoneOffset.z;
}

function convertSpringBones({ json }) {
    const spring = json.extensions.VRM.secondaryAnimation;
    if (!spring) return;
    (spring.colliderGroups || []).forEach((group, groupIndex) => {
        const colliderIndices = [];
        group.colliders.forEach(collider => {
            collider.offset.x = -collider.offset.x ?? 0;
            collider.offset.z = -collider.offset.z ?? 0;
        });
    });
}

function extractThumbnail({ json, imageBitmaps, data }) {
    let thumbnailImage = null;
    if (json.extensions.VRM) {
        const textureIndex = json.extensions.VRM.meta.texture;
        if (textureIndex != undefined && textureIndex != null && textureIndex >= 0) {
            thumbnailImage = json.textures[textureIndex].source;
        }
    }
    if (json.extensions.VRMC_vrm) {
        thumbnailImage = json.extensions.VRMC_vrm.meta.thumbnailImage;
    }
    if (thumbnailImage != undefined && thumbnailImage != null && thumbnailImage >= 0) {
        return imageBitmaps[thumbnailImage];
    }
    return null;
}

function convertMeta(vrm) {
    if (vrm.meta.metaVersion == '1') return;

    //const meta = gltf.parser.json.extensions.VRM.meta;
    const meta = vrm.meta;
    const newMeta = { metaVersion: "1" };

    if (meta.licenseUrl) {
        newMeta.licenseUrl = meta.licenseUrl;
    } else {
        newMeta.licenseUrl = "https://vrm.dev/licenses/1.0/";
    }
    if (meta.author) newMeta.authors = [meta.author];
    if (meta.title) newMeta.name = meta.title;
    if (meta.version) newMeta.version = meta.version;

    if (meta.contactInformation) newMeta.contactInformation = meta.contactInformation;
    switch (meta.allowedUserName) {
        case "OnlyAuthor": newMeta.avatarPermission = 'onlyAuthor'; break;
        case "ExplicitlyLicensedPerson": newMeta.avatarPermission = 'onlySeparatelyLicensedPerson'; break;
        case "Everyone": newMeta.avatarPermission = 'everyone'; break;
        default: newMeta.avatarPermission = 'onlyAuthor';
    }
    newMeta.allowExcessivelyViolentUsage = meta.violentUssageName == 'Allow';
    newMeta.allowExcessivelySexualUsage = meta.sexualUssageName == 'Allow';
    if (meta.otherPermissionUrl) newMeta.otherLicenseUrl = meta.otherPermissionUrl;

    switch (meta.licenseName) {
        case "Redistribution_Prohibited": {
            newMeta.allowRedistribution = false;
            newMeta.modification = 'prohibited';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = meta.commercialUssageName == 'Allow' ? "corporation" : "personalProfit";
            break;
        }
        case "CC0": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'allowModificationRedistribution';
            newMeta.creditNotation = 'unnecessary';
            newMeta.commercialUsage = "corporation";
            break;
        }
        case "CC_BY": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'allowModificationRedistribution';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = meta.commercialUssageName == 'Allow' ? "corporation" : "personalProfit";
            break;
        }
        case "CC_BY_NC": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'allowModificationRedistribution';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = "personalNonProfit";
            break;
        }
        case "CC_BY_SA": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'allowModificationRedistribution';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = meta.commercialUssageName == 'Allow' ? "corporation" : "personalProfit";
            break;
        }
        case "CC_BY_NC_SA": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'allowModificationRedistribution';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = "personalNonProfit";
            break;
        }
        case "CC_BY_ND": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'prohibited';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = meta.commercialUssageName == 'Allow' ? "corporation" : "personalProfit";
            break;
        }
        case "CC_BY_NC_ND": {
            newMeta.allowRedistribution = true;
            newMeta.modification = 'prohibited';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = "personalNonProfit";
            break;
        }
        default: {
            newMeta.allowRedistribution = false;
            newMeta.modification = 'prohibited';
            newMeta.creditNotation = 'required';
            newMeta.commercialUsage = "personalNonProfit";
            break;
        }
    }
    newMeta.allowPoliticalOrReligiousUsage = false;
    newMeta.allowAntisocialOrHateUsage = false;
    newMeta.copyrightInformation = '';
    newMeta.thirdPartyLicenses = '';

    vrm.meta = newMeta;
}

function correctExpression({ json }) {
    const blendShapeGroups = json.extensions?.VRM?.blendShapeMaster?.blendShapeGroups;
    if (blendShapeGroups && blendShapeGroups.length > 0) {
        blendShapeGroups.forEach(shape => {
            if (shape.name == 'Surprised') {
                shape.name = 'surprised';
                shape.presetName = 'surprised'
            }
        });
    }
}

function addSpringBoneEnds(vrm) {
    vrm.springBoneManager.joints.forEach(joint => {
        if (joint.child == null) {
            const end = new THREE.Object3D();
            end.name = joint.bone.name + '_end';
            const position = joint.bone.position.clone().setLength(0.07);
            end.position.set(position.x, position.y, position.z);
            joint.bone.add(end);
            joint.child = end;
        }
    });
}

export const conversion = {
    async before(vrmBuffer) {
        const res = splitBuffer(vrmBuffer);
        const { json, imageBitmaps, data } = await getData(res);

        if (json.extensions.VRM) {
            rotateGeometry({ json, data });
            rotateBones({ json, data });
            convertSpringBones({ json });
            correctExpression({ json });
        }

        const thumbnail = extractThumbnail({ json, imageBitmaps, data });
        const buffers = await putData({ json, imageBitmaps, data })
        const buffer = bindBuffers(buffers);
        return { buffer, thumbnail };
    },
    after(vrm, thumbnail) {
        if (vrm.meta.metaVersion == '0') {
            convertMeta(vrm);
            addSpringBoneEnds(vrm);
        }
        vrm.meta.thumbnailImage = thumbnail;
        return vrm;
    }
}

