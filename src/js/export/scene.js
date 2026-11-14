/**
 * Morpholith export — scene graph walk, mesh queue, skins attachment.
 */
import { isExportExcludedHelper } from "./scene-helpers.js";
import { makeMesh2, makeSkin } from "./mesh.js";

export async function findNode(state, node) {
    if (state.org.springBoneManager.colliders.includes(node)) return null;
    if (state.metaVersion == 0 && state.springBoneEnds.has(node)) return null;
    if (isExportExcludedHelper(node)) return null;

    const nodeIndex = state.nodes.length;
    state.nodeMap.set(node, nodeIndex);

    const item = { name: node.name };
    // flipAxis: VRM0 file space → VRM1 (or VRM0 re-export legacy) uses (-x,y,-z)
    if (state.flipAxis) {
        if (!node.position.equals(state.translationZero)) item.translation = [-node.position.x, node.position.y, -node.position.z];
        if (!node.quaternion.equals(state.quaternionZero)) item.rotation = [-node.quaternion.x, node.quaternion.y, -node.quaternion.z, node.quaternion.w];
    } else {
        if (!node.position.equals(state.translationZero)) item.translation = [node.position.x, node.position.y, node.position.z];
        if (!node.quaternion.equals(state.quaternionZero)) item.rotation = [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w];
    }
    if (!node.scale.equals(state.scaleOne)) item.scale = [node.scale.x, node.scale.y, node.scale.z];
    state.nodes.push(item);

    if (node.isMesh) {
        // Single primitive
        state.makeMeshQueues.push({ item, nodes: [node] });
        state.primitiveMap.set(node, nodeIndex);
        return nodeIndex;
    }
    if (node.children && node.children.length > 0) {
        // Strip runtime helpers before deciding multi-primitive merge
        const meshChildren = node.children.filter(v => v.isMesh && !isExportExcludedHelper(v));
        const nonMeshChildren = node.children.filter(v => !v.isMesh);
        const f = nonMeshChildren.length > 0 ? 0 : -1;
        // Body_Nails など「独立メッシュ名を残したい」子は primitives 結合しない
        const hasSeparateMesh = meshChildren.some(v =>
            (v.userData && (v.userData._isBodyNailsMesh || v.userData._isBodyEyesMesh || v.userData._isBodyEyebrowsMesh)) ||
            (typeof v.name === "string" && (
                v.name === "Body_Nails" || v.name.indexOf("Body_Nails") === 0 ||
                v.name === "Body_Eyes" || v.name.indexOf("Body_Eyes") === 0 ||
                v.name === "Body_Eyebrows" || v.name.indexOf("Body_Eyebrows") === 0
            ))
        );
        // Face children (incl. eyes) combine as multi-primitive — one skin for the whole face.
        // Separating eyes into their own nodes regressed black eyes under body bake.
        if (f < 0 && meshChildren.length > 0 && !hasSeparateMesh) {
            state.makeMeshQueues.push({ item, nodes: meshChildren });
            state.primitiveMap.set(meshChildren[0], nodeIndex);
            return nodeIndex;
        }
    }
    const children = [];
    for (const child of node.children) {
        if (isExportExcludedHelper(child)) continue;
        const childNumber = await findNode(state, child);
        if (childNumber != null) children.push(childNumber);
    }
    if (children.length > 0) item.children = children;
    return nodeIndex;
}

export function findSpringBoneRoots(state) {
    state.springBoneRoots = new Map([...state.org.springBoneManager.joints].map(joint => [joint.bone, joint]));
    state.org.springBoneManager.joints.forEach(joint => state.springBoneRoots.delete(joint.child));
}

export function findSpringBoneEnds(state) {
    state.springBoneEnds = new Map([...state.org.springBoneManager.joints].map(joint => [joint.child, joint]));
    state.org.springBoneManager.joints.forEach(joint => state.springBoneEnds.delete(joint.bone));
}

export async function makeScenes(state) {
    findSpringBoneRoots(state);
    findSpringBoneEnds(state);
    for (const node of state.org.scene.children) {
        // 旧実装は break だったため、後段に追加した Body_Nails 等が書き出されなかった
        if (node.type == 'VRMExpression') continue;
        if (node.name == 'VRMHumanoidRig') continue;
        const nodeIndex = await findNode(state, node);
        if (nodeIndex != null) state.scenes[0].nodes.push(nodeIndex);
    }
    // 念のため: Body_Nails / Body_Eyes / Body_Eyebrows が nodeMap に無い場合は scene 直下相当として追加登録
    const pendingSeparate = [];
    state.org.scene.traverse(obj => {
        if (!obj || !obj.isMesh) return;
        const n = obj.name || "";
        const ud = obj.userData || {};
        const isSep = ud._isBodyNailsMesh || ud._isBodyEyesMesh || ud._isBodyEyebrowsMesh
            || n === "Body_Nails" || n.indexOf("Body_Nails") === 0
            || n === "Body_Eyes" || n.indexOf("Body_Eyes") === 0
            || n === "Body_Eyebrows" || n.indexOf("Body_Eyebrows") === 0;
        if (!isSep) return;
        if (state.nodeMap.has(obj)) return;
        pendingSeparate.push(obj);
    });
    for (const mesh of pendingSeparate) {
        const nodeIndex = await findNode(state, mesh);
        if (nodeIndex != null) state.scenes[0].nodes.push(nodeIndex);
    }

    for (const makeMeshQueue of state.makeMeshQueues) {
        const nodes = makeMeshQueue.nodes;
        const item = makeMeshQueue.item;
        item.mesh = await makeMesh2(state, nodes);
        const skinIndex = makeSkin(state, nodes);
        if (skinIndex != null) item.skin = skinIndex;
    }
    if (state.metaVersion == 0) {
        const renderTypes = ['Opaque', 'TransparentCutout', 'Transparent', 'TransparentWithZWrite'];
        const renderOffsets = [2000, 2450, 3000, 3500];
        renderTypes.forEach((renderType, index) => {
            const materials = state.materialQueue.filter(m => m.renderType === renderType);
            const sortedMaterials = materials.sort((a, b) => a.renderOrder - b.renderOrder);
            sortedMaterials.forEach((material, i) => {
                material.properties.renderQueue = renderOffsets[index] + i;
            });
        });
    }
}

