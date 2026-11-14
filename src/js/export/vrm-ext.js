/**
 * Morpholith export — VRM0 / VRM1 extension blocks (humanoid, expressions, spring, meta…).
 */
import * as THREE from "three";
import { addImage, addTexture } from "./texture.js";

export function makeConstraint(state) {
    if (!state.org.nodeConstraintManager) return;
    state.extensionsUsed.push('VRMC_node_constraint');
    const constraints = state.org.nodeConstraintManager._constraints;
    for (const constraint of constraints) {
        const node = state.nodes[state.nodeMap.get(constraint.destination)];
        const source = state.nodeMap.get(constraint.source);
        const target = {};
        node.extensions = { VRMC_node_constraint: { specVersion: "1.0", constraint: target } };
        if (constraint._v3AimAxis) {
            target.aim = {
                aimAxis: constraint._aimAxis,
                source,
                weight: constraint.weight
            };
            continue;
        }
        if (constraint._v3RollAxis) {
            target.roll = {
                rollAxis: constraint._rollAxis,
                source,
                weight: constraint.weight
            };
            continue;
        }
        target.rotation = {
            source,
            weight: constraint.weight
        }
    }
}

export function makeSpringBone(state) {
    const springBoneManager = state.org.springBoneManager;
    if (!springBoneManager) return;

    const colliders = [];
    const colliderMap = new Map();

    function flipVec3Arr(arr) {
        if (!arr || arr.length < 3 || !state.flipAxis) return arr;
        return [-arr[0], arr[1], -arr[2]];
    }
    function makeCollider(collider) {
        const node = state.nodeMap.get(collider.parent);
        const shape = {};
        if (collider.shape.type == 'sphere') {
            const sphere = {};
            if (collider.shape.offset != undefined) sphere.offset = flipVec3Arr(collider.shape.offset.toArray());
            if (collider.shape.radius != undefined) sphere.radius = collider.shape.radius;
            if (collider.shape.inside != undefined) sphere.inside = collider.shape.inside;
            shape.sphere = sphere;
        }
        if (collider.shape.type == 'capsule') {
            const capsule = {};
            if (collider.shape.offset != undefined) capsule.offset = flipVec3Arr(collider.shape.offset.toArray());
            if (collider.shape.radius != undefined) capsule.radius = collider.shape.radius;
            if (collider.shape.tail != undefined) capsule.tail = flipVec3Arr(collider.shape.tail.toArray());
            if (collider.shape.inside != undefined) capsule.inside = collider.shape.inside;
            shape.capsule = capsule;
        }
        if (collider.shape.type == 'plane') {
            const plane = {};
            if (collider.shape.offset != undefined) plane.offset = flipVec3Arr(collider.shape.offset.toArray());
            if (collider.shape.normal != undefined) plane.normal = flipVec3Arr(collider.shape.normal.toArray());
            shape.plane = plane;
        }
        const index = colliders.length;
        colliders.push({ node, shape });
        return index;
    }

    const colliderGroups = [];
    springBoneManager.colliderGroups.forEach(group => {
        const name = group.name;
        const colliders = [];
        for (const collider of group.colliders) {
            if (!colliderMap.has(collider)) {
                const index = makeCollider(collider);
                colliderMap.set(collider, index);
                colliders.push(index);
            } else {
                const index = colliderMap.get(collider);
                colliders.push(index);
            }
        }
        //const colliders = group.colliders.map(v => springBoneManager.colliders.indexOf(v));
        colliderGroups.push({ name, colliders });
    });

    const jointMap = new Map();
    springBoneManager.joints.forEach(joint => jointMap.set(joint.bone, joint));

    const springs = [];
    state.springBoneRoots.forEach((joint) => {
        const spring = { name: joint.bone.name };
        spring.center = state.nodeMap.get(joint.center);
        spring.colliderGroups = joint.colliderGroups.map(v => springBoneManager.colliderGroups.indexOf(v));;
        const joints = [];
        let lastJoint;
        let j = joint;
        while (j) {
            const joint = { node: state.nodeMap.get(j.bone) };
            if (j.settings.dragForce) joint.dragForce = j.settings.dragForce;
            if (j.settings.gravityDir) {
                const g = j.settings.gravityDir.toArray();
                joint.gravityDir = state.flipAxis ? [-g[0], g[1], -g[2]] : g;
            }
            if (j.settings.gravityPower) joint.gravityPower = j.settings.gravityPower;
            if (j.settings.hitRadius) joint.hitRadius = j.settings.hitRadius;
            if (j.settings.stiffness) joint.stiffness = j.settings.stiffness;
            joints.push(joint);
            lastJoint = j;
            j = jointMap.get(j.child);
        }
        joints.push({ node: state.nodeMap.get(lastJoint.child) });
        spring.joints = joints;
        springs.push(spring);
    });

    state.extensions.VRMC_springBone = { specVersion: "1.0", colliderGroups, colliders, springs };
    if (!state.extensionsUsed.includes('VRMC_springBone')) state.extensionsUsed.push('VRMC_springBone');
}

export function makeSecondaryAnimation(state) {
    const springBoneManager = state.org.springBoneManager;
    if (!springBoneManager) return;

    const newColliderGroups = [];
    const colliderGroupMap = new Map();
    const boneGroupMap = new Map();
    state.springBoneRoots.forEach((joint) => {
        const boneGroup = {};
        boneGroup.center = state.nodeMap.get(joint._center);
        boneGroup.dragForce = joint.settings.dragForce;
        boneGroup.gravityDir = { ...joint.settings.gravityDir };
        boneGroup.gravityDir.x = -boneGroup.gravityDir.x;
        boneGroup.gravityDir.z = -boneGroup.gravityDir.z;
        boneGroup.gravityPower = joint.settings.gravityPower;
        boneGroup.hitRadius = joint.settings.hitRadius;
        boneGroup.stiffiness = joint.settings.stiffness;
        boneGroup.colliderGroups = [];

        const colliderMap = new Map();
        joint.colliderGroups.forEach(colliderGroup => {
            colliderGroup.colliders.forEach(collider => {
                const key = collider.parent;
                if (!colliderMap.has(key)) colliderMap.set(key, []);
                colliderMap.get(key).push(collider);
            });
        });
        colliderMap.forEach((colliderRef, bone) => {
            const node = state.nodeMap.get(bone);
            const colliders = [];
            colliderRef.forEach(collider => {
                const offset = collider.shape.offset;
                const radius = collider.shape.radius;
                const newColider = { offset, radius };
                colliders.push(newColider);
            });
            const colliderGroup = { node, colliders };
            const key = JSON.stringify(colliderGroup);
            if (!colliderGroupMap.has(key)) {
                colliderGroupMap.set(key, newColliderGroups.length);
                newColliderGroups.push(colliderGroup);
            }
            boneGroup.colliderGroups.push(colliderGroupMap.get(key));
        });
        const key = JSON.stringify(boneGroup);
        if (!boneGroupMap.has(key)) boneGroupMap.set(key, []);
        boneGroupMap.get(key).push(state.nodeMap.get(joint.bone));
    });

    const colliderGroups = [];
    newColliderGroups.forEach(colliderGroup => {
        colliderGroup.colliders.forEach(collider => {
            collider.offset = { ...collider.offset };
            collider.offset.x = -collider.offset.x;
        });
        colliderGroups.push(colliderGroup);
    })

    const boneGroups = [];
    boneGroupMap.forEach((bones, key) => {
        const boneGroup = JSON.parse(key);
        boneGroup.bones = bones;
        boneGroups.push(boneGroup)
    });

    state.extensions.VRM.secondaryAnimation = { boneGroups, colliderGroups };
    return;
}

export function makeExpressions(state) {
    const VRM1_PRESETS = new Set([
        'happy', 'angry', 'sad', 'relaxed', 'surprised',
        'aa', 'ih', 'ou', 'ee', 'oh',
        'blink', 'blinkLeft', 'blinkRight',
        'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral'
    ]);
    const expressionMap = state.org.expressionManager._expressionMap;
    const expressions = { preset: {}, custom: {} };
    for (const name in expressionMap) {
        const morphTargetBinds = [];
        const materialColorBinds = [];
        const textureTransformBinds = [];
        const nodeCheck = {};
        for (const bind of expressionMap[name].binds) {
            if (bind.primitives) {
                //for (const primitive of bind.primitives) {
                    const node = state.nodeMap.get(bind.primitives[0].parent);
                        const index = bind.index;
                        const weight = bind.weight;
                        morphTargetBinds.push({ index, node, weight });
                //}
            }
            if (bind.material && !bind.material.isOutline) {
                const material = state.materialMap.get(bind.material);
                if (bind.offset && bind.scale) {
                    const scale = bind.scale.toArray();
                    const offset = bind.offset.toArray();
                    textureTransformBinds.push({ material, scale, offset });
                }
                if (bind.type && bind.targetValue) {
                    const type = bind.type;
                    const targetValue = bind.targetValue.toArray();
                    targetValue.push(bind.targetAlpha);
                    materialColorBinds.push({ material, type, targetValue });
                }
            }
            if(name == 'Extra') console.log(name, morphTargetBinds);
        }
        const expression = {
            isBinary: expressionMap[name].isBinary,
            //morphTargetBinds: morphTargetBinds,
            overrideBlink: expressionMap[name].overrideBlink,
            overrideLookAt: expressionMap[name].overrideLookAt,
            overrideMouth: expressionMap[name].overrideMouth
        };
        if (morphTargetBinds.length > 0) expression.morphTargetBinds = morphTargetBinds;
        if (textureTransformBinds.length > 0) expression.textureTransformBinds = textureTransformBinds;
        if (materialColorBinds.length > 0) expression.materialColorBinds = materialColorBinds;

        if (VRM1_PRESETS.has(name)) {
            expressions.preset[name] = expression;
        }else{
            expressions.custom[name] = expression;
        }
    }
    state.extensions.VRMC_vrm.expressions = expressions;
}

export function makeFirstPerson(state) {
    const meshAnnotations = state.org.firstPerson.meshAnnotations;

    function type2Flag(type) {
        if (type === "firstPersonOnly") {
            return "FirstPersonOnly";
        } else if (type === "thirdPersonOnly") {
            return "ThirdPersonOnly";
        } else if (type === "both") {
            return "Both";
        } else {
            return "Auto";
        }
    }

    const newMeshAnnotations = [];
    if (state.metaVersion == 0) {
        for (const item of Object.values(meshAnnotations)) {
            newMeshAnnotations.push({ mesh: state.primitiveMap.get(item.meshes[0]), firstPersonFlag: type2Flag(item.type) });
        }
    } else {
        const newMeshAnnotations = [];
        for (const item of Object.values(meshAnnotations)) {
            newMeshAnnotations.push({ node: state.primitiveMap.get(item.meshes[0]), type: item.type });
        }
    }
    if (!state.extensions.VRMC_vrm.firstPerson) state.extensions.VRMC_vrm.firstPerson = {};
    if (newMeshAnnotations.length > 0) state.extensions.VRMC_vrm.firstPerson.meshAnnotations = newMeshAnnotations;
}

export function makeHumanoid(state) {
    const bones = {}
    const orgBones = state.org.humanoid.humanBones;
    for (const bone in state.org.humanoid.humanBones) {
        const node = state.nodeMap.get(orgBones[bone].node);
        if (node != undefined) bones[bone] = { node };
    }
    state.extensions.VRMC_vrm.humanoid = { humanBones: bones };
}

export function makeHumanoid0(state) {
    const humanoid = {
        armStretch: 0.05,
        feetSpacing: 0,
        hasTranslationDoF: false,
        humanBones: [],
        legStretch: 0.05,
        lowerArmTwist: 0.5,
        lowerLegTwist: 0.5,
        upperArmTwist: 0.5,
        upperLegTwist: 0.5
    };
    const bones = state.org.humanoid._rawHumanBones.humanBones;
    const list = {
        leftThumbMetacarpal: 'leftThumbProximal',
        leftThumbProximal: 'leftThumbIntermediate',
        rightThumbMetacarpal: 'rightThumbProximal',
        rightThumbProximal: 'rightThumbIntermediate',
    };
    for (const boneName in bones) {
        const node = state.nodeMap.get(bones[boneName].node);
        const bone = list[boneName] ? list[boneName] : boneName;
        if (node != undefined) humanoid.humanBones.push({ bone, node, useDefaultValues: true });
    }
    state.extensions.VRM.humanoid = humanoid;
}

export function makeLookAt(state) {
    const orgLookAt = state.org.lookAt;
    if (state.metaVersion == 0) {
        if (!state.extensions.VRM.firstPerson) state.extensions.VRM.firstPerson = {};
        const lookAt = state.extensions.VRM.firstPerson;

        lookAt.firstPersonBone = state.extensions.VRM.humanoid.humanBones.find(v => v.bone == 'head').node;
        lookAt.firstPersonBoneOffset = orgLookAt.offsetFromHeadBone;
        lookAt.firstPersonBoneOffset.x = -lookAt.firstPersonBoneOffset.x;
        lookAt.firstPersonBoneOffset.z = -lookAt.firstPersonBoneOffset.z;

        if (orgLookAt.applier.humanoid) lookAt.lookAtTypeName = 'Bone';
        if (orgLookAt.applier.expressions) lookAt.lookAtTypeName = 'BlendShape';

        function degreeMap(rangeMap) {
            const xRange = rangeMap.inputMaxValue;
            const yRange = rangeMap.outputScale;
            const curve = [0, 0, 0, 1, 1, 1, 1, 0];
            const degreemap = { xRange, yRange, curve };
            return degreemap;
        }
        lookAt.lookAtHorizontalInner = degreeMap(orgLookAt.applier.rangeMapHorizontalInner);
        lookAt.lookAtHorizontalOuter = degreeMap(orgLookAt.applier.rangeMapHorizontalOuter);
        lookAt.lookAtVerticalDown = degreeMap(orgLookAt.applier.rangeMapVerticalDown);
        lookAt.lookAtVerticalUp = degreeMap(orgLookAt.applier.rangeMapVerticalUp);

        //state.extensions.VRM.firstPerson = lookAt;
    } else {
        const lookAt = {};
        const off = orgLookAt.offsetFromHeadBone.toArray();
        // VRM0→VRM1: same (-x, y, -z) as node/mesh conversion
        if (state.flipAxis) {
            off[0] = -off[0];
            off[2] = -off[2];
        }
        lookAt.offsetFromHeadBone = off;

        lookAt.rangeMapHorizontalInner = orgLookAt.applier.rangeMapHorizontalInner;
        lookAt.rangeMapHorizontalOuter = orgLookAt.applier.rangeMapHorizontalOuter;
        lookAt.rangeMapVerticalDown = orgLookAt.applier.rangeMapVerticalDown;
        lookAt.rangeMapVerticalUp = orgLookAt.applier.rangeMapVerticalUp;

        if (orgLookAt.applier.humanoid) lookAt.type = 'bone';
        if (orgLookAt.applier.expressions) lookAt.type = 'expression';

        state.extensions.VRMC_vrm.lookAt = lookAt;
    }
}

export async function makeMeta1(state) {
    const meta = {};
    const orgMeta = state.org.meta;
    for (const key of [
        'name',
        'authors',
        'copyrightInformation',
        'references',
        'thirdPartyLicenses',
        'licenseUrl',
        'avatarPermission',
        'allowExcessivelyViolentUsage',
        'allowExcessivelySexualUsage',
        'commercialUsage',
        'allowPoliticalOrReligiousUsage',
        'allowAntisocialOrHateUsage',
        'creditNotation',
        'allowRedistribution',
        'modification',
        'version',
        'contactInformation',
        'otherLicenseUrl'
    ]) if (orgMeta[key] !== undefined) meta[key] = orgMeta[key];
    if (meta.licenseUrl == undefined || meta.licenseUrl == '') meta.licenseUrl = "https://vrm.dev/licenses/1.0/";
    if (orgMeta.thumbnailImage !== undefined && orgMeta.thumbnailImage !== null) {
        meta.thumbnailImage = await addImage(state, orgMeta.thumbnailImage, 'Thumbnail', false);
    }
    state.extensions.VRMC_vrm.meta = meta;
}

export async function makeMeta0(state) {
    const meta = state.org.meta;
    const newMeta = {};

    if (meta.name) newMeta.title = meta.name;
    if (meta.version) newMeta.version = meta.version;

    if (meta.authors) newMeta.author = meta.authors.join(', ');
    if (meta.contactInformation) newMeta.contactInformation = meta.contactInformation;
    if (meta.references) {
        newMeta.reference = meta.references.join(', ');
    } else {
        newMeta.reference = '';
    }

    if (meta.thumbnailImage !== undefined && meta.thumbnailImage !== null) {
        const texture = new THREE.Texture(meta.thumbnailImage);
        texture.name = 'Thumbnail';
        texture.flipY = false;
        const res = await addTexture(state, texture);
        if (res && res.index != null) newMeta.texture = res.index;
    }

    switch (meta.avatarPermission) {
        case 'everyone': newMeta.allowedUserName = "Everyone"; break;
        case 'onlySeparatelyLicensedPerson': newMeta.allowedUserName = "ExplicitlyLicensedPerson"; break;
        case 'onlyAuthor':
        default: newMeta.allowedUserName = "OnlyAuthor";
    }
    if (meta.allowExcessivelyViolentUsage == true) {
        newMeta.violentUssageName = 'Allow';
    } else {
        newMeta.violentUssageName = 'Disallow';
    }
    if (meta.allowExcessivelySexualUsage == true) {
        newMeta.sexualUssageName = 'Allow';
    } else {
        newMeta.sexualUssageName = 'Disallow';
    }
    switch (meta.commercialUsage) {
        case 'corporation': newMeta.commercialUssageName = "Allow"; break;
        case 'personalProfit':
        case 'personalNonProfit':
        default: newMeta.commercialUssageName = "Disallow";
    }

    newMeta.otherPermissionUrl = '';
    newMeta.licenseName = '';
    const l = {};
    if (meta.allowRedistribution) l.d = true;
    if (meta.modification == 'allowModificationRedistribution') l.m = true;
    if (meta.commercialUsage == 'corporation') l.c = true;
    if (meta.creditNotation == 'unnecessary') l.n = true;

    newMeta.licenseName = 'Redistribution_Prohibited';
    if (l.d) newMeta.licenseName = 'CC_BY_NC_ND';
    if (l.d && l.c) newMeta.licenseName = 'CC_BY_ND';
    if (l.d && l.m) newMeta.licenseName = 'CC_BY_NC_SA';
    if (l.d && l.m && l.c) newMeta.licenseName = 'CC_BY_SA';
    if (l.d && l.m && l.n) newMeta.licenseName = 'CC_BY_NC';
    if (l.d && l.m && l.c && l.n) newMeta.licenseName = 'CC_BY';
    if (l.d && l.m && l.c && l.n) newMeta.licenseName = 'CC0';

    newMeta.otherLicenseUrl = meta.otherLicenseUrl ?? '';
    state.extensions.VRM.meta = newMeta;
}

export function makeBlendShapeMaster(state) {
    const presetNames = {
        neutral: ['Neutral', 'neutral'],
        aa: ['A', 'a'],
        ee: ['E', 'e'],
        ih: ['I', 'i'],
        oh: ['O', 'o'],
        ou: ['U', 'u'],
        blink: ['Blink', 'blink'],
        happy: ['Joy', 'joy'],
        angry: ['Angry', 'angry'],
        sad: ['Sorrow', 'sorrow'],
        relaxed: ['Fun', 'fun'],
        lookUp: ['LookUp', 'lookup'],
        lookDown: ['LookDown', 'lookdown'],
        lookLeft: ['LookLeft', 'lookleft'],
        lookRight: ['LookRight', 'lookright'],
        blinkLeft: ['Blink_L', 'blink_l'],
        blinkRight: ['Blink_R', 'blink_r'],
        surprised: ['Surprised', 'unknown']
    };
    const propertyNames = {
        color: '_Color',
        emissionColor: '_EmissionColor',
        shadeColor: '_ShadeColor',
        rimColor: '_RimColor',
        outlineColor: '_OutlineColor'
    };

    const expressions = state.org.expressionManager._expressions;
    const blendShapeGroups = [];
    expressions.forEach(expression => {
        const presetName = presetNames[expression.expressionName];
        let blendShapeGroup = {};
        if (presetName) {
            blendShapeGroup = { name: presetName[0], presetName: presetName[1] };
        } else {
            blendShapeGroup = { name: expression.expressionName, presetName: 'unknown' };
        }
        blendShapeGroup.isBinary = expression.isBinary;
        blendShapeGroup.binds = [];
        blendShapeGroup.materialValues = [];
        for (const bind of expression.binds) {
            if (bind.primitives) {
                const mesh = state.meshMap.get(bind.primitives[0]);
                const index = bind.index;
                const weight = bind.weight * 100;
                blendShapeGroup.binds.push({ mesh, index, weight });
            }
            if (bind.material && !bind.material.isOutline) {
                const materialName = bind.material.name;
                const propertyName = propertyNames[bind.type];
                const targetValue = bind.targetValue.toArray();
                targetValue.push(bind.targetAlpha ?? 1.0);
                blendShapeGroup.materialValues.push({ materialName, propertyName, targetValue });
            }
        }
        blendShapeGroups.push(blendShapeGroup);
    });
    state.extensions.VRM.blendShapeMaster = { blendShapeGroups };
}

export async function makeVRM(state) {
    const skipSpring = !!(state.exportOptions && state.exportOptions.skipSpringBones);
    if (state.metaVersion == 1) {
        if (!state.extensionsUsed.includes('VRMC_vrm')) state.extensionsUsed.push('VRMC_vrm');
        makeExpressions(state);
        makeFirstPerson(state);
        makeHumanoid(state);
        makeLookAt(state);
        await makeMeta1(state);
        if (!skipSpring) makeSpringBone(state);
        makeConstraint(state);
    } else {
        if (!state.extensionsUsed.includes('VRM')) state.extensionsUsed.push('VRM');
        await makeMeta0(state);
        makeHumanoid0(state);
        makeBlendShapeMaster(state);
        state.extensions.VRM.exporterVersion = "VRMExporterByRingo0.0";
        makeLookAt(state);
        makeFirstPerson(state);
        if (!skipSpring) makeSecondaryAnimation(state);
    }
}
