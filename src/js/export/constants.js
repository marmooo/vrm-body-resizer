/**
 * Morpholith export — glTF component type / item size constants + align helper.
 */
export const ComponentType = {
    signedByte: 5120,
    unsignedByte: 5121,
    signedShort: 5122,
    unsignedShort: 5123,
    unsignedInt: 5125,
    float: 5126,
    Int8Array: 5120,
    Uint8Array: 5121,
    Int16Array: 5122,
    Uint16Array: 5123,
    Int32Array: 5124, //May not be used
    Uint32Array: 5125,
    Float32Array: 5126,
};

export const ItemSize = {
    SCALAR: 1,
    VEC2: 2,
    VEC3: 3,
    VEC4: 4,
    MAT2: 4,
    MAT3: 9,
    MAT4: 16
};

export const ComponentFunc = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5124: Int32Array,
    5125: Uint32Array,
    5126: Float32Array,
};

export function align4(n) {
    return Math.ceil(n / 4) * 4;
}

/** Morph delta below this is treated as zero (for sparse encoding). */
export const MORPH_SPARSE_EPS = 1e-5;
