/**
 * Morpholith export — export state init + bufferView / accessor / sampler helpers.
 */
import * as THREE from "three";
import { align4, ComponentType, ItemSize } from "./constants.js";

export function init(state) {
    state.accessors = [];
    state.asset = {
        version: "2.0",
        generator: "VRMExporterByRingo"
    };
    state.bufferViews = [];
    state.buffers = [];
    state.extensions = {};
    state.extensions.VRMC_vrm = { specVersion: '1.0' };
    state.extensions.VRM = { specVersion: '0.0' };
    state.extensionsUsed = ["KHR_texture_transform", "KHR_materials_unlit"];
    state.images = [];
    state.materials = [];
    state.meshes = [];
    state.nodes = [];
    state.samplers = [];
    state.scene = 0;
    state.scenes = [{ nodes: [] }];
    state.skins = [];
    state.textures = []
    state.offset = 0;

    state.nodeMap = new Map();
    state.textureMap = new Map();
    state.samplerMap = new Map();
    state.imageMap = [];
    state.makeMeshQueues = [];
    state.primitiveMap = new Map();
    state.meshMap = new Map();
    state.materialMap = new Map();
    state.accessorMap = new Map();
    state.materialQueue = [];

    state.translationZero = new THREE.Vector3();
    state.quaternionZero = new THREE.Quaternion();
    state.scaleOne = new THREE.Vector3(1, 1, 1);
}

export function addBufferView(state, data, name = '', target = null) {
    const bufferView = {};
    bufferView.buffer = 0;
    bufferView.byteLength = data.byteLength;
    bufferView.byteOffset = state.offset;
    if (target == 'ARRAY_BUFFER') bufferView.target = 34963;
    if (target == 'ELEMENT_ARRAY_BUFFER') bufferView.target = 34962;
    bufferView.name = name;

    const index = state.bufferViews.length;
    state.bufferViews.push(bufferView);
    state.buffers.push(data);
    state.offset += align4(data.byteLength);

    return index;
}

/**
 * @param {object} [precomputedMinMax] optional { min: number[], max: number[] }
 *        When provided with maxMin=true, skips the O(n) vertex scan (e.g. from
 *        THREE.BufferGeometry.boundingBox after bake).
 */
export function addAccessor(state, array, dataType, name = '', maxMin = false, normalized = false, precomputedMinMax = null) {
    if (state.accessorMap.has(array)) return state.accessorMap.get(array);
    const accessor = { name };
    accessor.componentType = ComponentType[array.constructor.name];
    accessor.bufferView = addBufferView(state, array, name);
    accessor.byteOffset = 0;
    const itemSize = ItemSize[dataType];
    accessor.count = array.length / itemSize;
    accessor.type = dataType;
    accessor.normalized = normalized;

    if (maxMin) {
        if (precomputedMinMax && Array.isArray(precomputedMinMax.min) && Array.isArray(precomputedMinMax.max)
            && precomputedMinMax.min.length === itemSize && precomputedMinMax.max.length === itemSize) {
            accessor.min = precomputedMinMax.min.slice();
            accessor.max = precomputedMinMax.max.slice();
        } else {
            const min = new Array(itemSize);
            const max = new Array(itemSize);
            min.fill(Infinity);
            max.fill(-Infinity);
            for (let i = 0; i < accessor.count; i++) {
                const index = itemSize * i;
                for (let j = 0; j < itemSize; j++) {
                    if (array[index + j] < min[j]) min[j] = array[index + j];
                    if (array[index + j] > max[j]) max[j] = array[index + j];
                }
            }
            accessor.max = max;
            accessor.min = min;
        }
    }

    const index = state.accessors.length;
    state.accessors.push(accessor);
    state.accessorMap.set(array, index);
    return index;
}

const MAG_FILTER = {
    [THREE.NearestFilter]: 9728, // NEAREST
    [THREE.LinearFilter]: 9729   // LINEAR
};
const MIN_FILTER = {
    [THREE.NearestFilter]: 9728,
    [THREE.LinearFilter]: 9729,
    [THREE.NearestMipmapNearestFilter]: 9984,
    [THREE.LinearMipmapNearestFilter]: 9985,
    [THREE.NearestMipmapLinearFilter]: 9986,
    [THREE.LinearMipmapLinearFilter]: 9987
};
const WRAP = {
    [THREE.ClampToEdgeWrapping]: 33071,
    [THREE.MirroredRepeatWrapping]: 33648,
    [THREE.RepeatWrapping]: 10497
};

export function addSampler(state, target) {
    const sampler = {
        magFilter: MAG_FILTER[target.magFilter] ?? 9729,
        minFilter: MIN_FILTER[target.minFilter] ?? 9987,
        wrapS: WRAP[target.wrapS] ?? 10497,
        wrapT: WRAP[target.wrapT] ?? 10497
        //extensions: {},
        //extras: {}
    };
    const key = `${sampler.magFilter}_${sampler.minFilter}_${sampler.wrapS}_${sampler.wrapT}`;
    if (state.samplerMap.has(key)) return state.samplerMap.get(key);

    const index = state.samplers.length;
    state.samplers.push(sampler);
    state.samplerMap.set(key, index);
    return index;
}
