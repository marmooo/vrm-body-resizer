/**
 * body-shape.js
 * morpholith-simple の applyImportedScaling / scaleBoneLTT / scaleBoneRole を
 * そのまま移植した VRM 体型コントローラ。
 *
 * 重要 (morpholith コメントより):
 * - getNormalizedBoneNode() はプロキシで、scale がスキンに乗らない
 * - getRawBoneNode() が実際のスキン用ボーン
 * - three-vrm の humanoid.update() が raw scale を上書きするため、毎フレーム再適用する
 */
import * as THREE from "three";
import { tr } from "./i18n.js";

const FINGER_SEGMENTS = {
  Thumb: ["Metacarpal", "Proximal", "Distal"],
  Index: ["Proximal", "Intermediate", "Distal"],
  Middle: ["Proximal", "Intermediate", "Distal"],
  Ring: ["Proximal", "Intermediate", "Distal"],
  Little: ["Proximal", "Intermediate", "Distal"],
};

const FINGER_BONE_NAMES = [];
["left", "right"].forEach((side) => {
  Object.keys(FINGER_SEGMENTS).forEach((finger) => {
    FINGER_SEGMENTS[finger].forEach((seg) => {
      FINGER_BONE_NAMES.push(side + finger + seg);
    });
  });
});

const HUMANOID_ROLES = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "rightShoulder",
  "leftUpperArm",
  "rightUpperArm",
  "leftLowerArm",
  "rightLowerArm",
  "leftHand",
  "rightHand",
  "leftUpperLeg",
  "rightUpperLeg",
  "leftLowerLeg",
  "rightLowerLeg",
  "leftFoot",
  "rightFoot",
  "leftToes",
  "rightToes",
];

const SCALE_PARENT = {
  spine: "hips",
  chest: "spine",
  upperChest: "chest",
  neck: "upperChest",
  head: "neck",
  leftShoulder: "chest",
  rightShoulder: "chest",
  leftUpperArm: "leftShoulder",
  rightUpperArm: "rightShoulder",
  leftLowerArm: "leftUpperArm",
  rightLowerArm: "rightUpperArm",
  leftHand: "leftLowerArm",
  rightHand: "rightLowerArm",
  leftUpperLeg: "hips",
  rightUpperLeg: "hips",
  leftLowerLeg: "leftUpperLeg",
  rightLowerLeg: "rightUpperLeg",
  leftFoot: "leftLowerLeg",
  rightFoot: "rightLowerLeg",
  leftToes: "leftFoot",
  rightToes: "rightFoot",
};
["left", "right"].forEach((side) => {
  Object.keys(FINGER_SEGMENTS).forEach((finger) => {
    const segs = FINGER_SEGMENTS[finger];
    segs.forEach((seg, i) => {
      SCALE_PARENT[side + finger + seg] = i === 0
        ? side + "Hand"
        : side + finger + segs[i - 1];
    });
  });
});

const AXIS_CHILD_REF = {
  spine: "chest",
  chest: "neck",
  neck: "head",
  leftShoulder: "leftUpperArm",
  rightShoulder: "rightUpperArm",
  leftUpperArm: "leftLowerArm",
  rightUpperArm: "rightLowerArm",
  leftLowerArm: "leftHand",
  rightLowerArm: "rightHand",
  leftUpperLeg: "leftLowerLeg",
  rightUpperLeg: "rightLowerLeg",
  leftLowerLeg: "leftFoot",
  rightLowerLeg: "rightFoot",
  leftFoot: "leftToes",
  rightFoot: "rightToes",
  leftHand: "leftMiddleProximal",
  rightHand: "rightMiddleProximal",
};
["left", "right"].forEach((side) => {
  Object.keys(FINGER_SEGMENTS).forEach((finger) => {
    const segs = FINGER_SEGMENTS[finger];
    segs.forEach((seg, i) => {
      if (i < segs.length - 1) {
        AXIS_CHILD_REF[side + finger + seg] = side + finger + segs[i + 1];
      }
    });
  });
});

export const DEFAULTS = {
  height: 1,
  build: 1,
  bodyType: 0,
  headWidth: 1,
  headLength: 1,
  neckLength: 1,
  neckThickness: 1,
  shoulderWidth: 1,
  chestLength: 1,
  chestWidth: 1,
  chestDepth: 1,
  upperChestLength: 1,
  upperChestWidth: 1,
  upperChestDepth: 1,
  waistLength: 1,
  waistSize: 1,
  hipLength: 1,
  hipWidth: 1,
  hipDepth: 1,
  spineCurve: 0,
  upperArmLength: 1,
  upperArmThickness: 1,
  lowerArmLength: 1,
  lowerArmThickness: 1,
  handLength: 1,
  handWidth: 1,
  handThickness: 1,
  thumbLength: 1,
  thumbThickness: 1,
  indexLength: 1,
  indexThickness: 1,
  middleLength: 1,
  middleThickness: 1,
  ringLength: 1,
  ringThickness: 1,
  littleLength: 1,
  littleThickness: 1,
  upperLegLength: 1,
  upperLegThickness: 1,
  lowerLegLength: 1,
  lowerLegThickness: 1,
  footLength: 1,
  footWidth: 1,
  footHeight: 1,
  toesLength: 1,
};

export const SLIDER_META = {
  height: { min: 50, max: 200, label: "身長", section: "全体サイズ" },
  build: { min: 50, max: 200, label: "全体の厚み", section: "全体サイズ" },
  bodyType: {
    min: -100,
    max: 100,
    label: "細身〜ぽっちゃり",
    section: "体型",
    special: "bodyType",
  },
  headWidth: { min: 50, max: 200, label: "頭の横幅", section: "頭部" },
  headLength: { min: 50, max: 200, label: "頭の縦幅", section: "頭部" },
  neckLength: { min: 50, max: 200, label: "首の長さ", section: "頭部" },
  neckThickness: { min: 50, max: 200, label: "首の太さ", section: "頭部" },
  shoulderWidth: { min: 50, max: 200, label: "肩幅", section: "肩" },
  chestLength: { min: 50, max: 200, label: "胸の長さ", section: "胸" },
  chestWidth: { min: 50, max: 200, label: "胸の横幅", section: "胸" },
  chestDepth: { min: 50, max: 200, label: "胸の厚み", section: "胸" },
  upperChestLength: { min: 50, max: 200, label: "上胸の長さ", section: "上胸" },
  upperChestWidth: { min: 50, max: 200, label: "上胸の横幅", section: "上胸" },
  upperChestDepth: { min: 50, max: 200, label: "上胸の厚み", section: "上胸" },
  waistLength: { min: 50, max: 200, label: "腰の長さ", section: "腰" },
  waistSize: { min: 50, max: 200, label: "ウエスト", section: "腰" },
  hipLength: { min: 50, max: 200, label: "骨盤の高さ", section: "腰" },
  hipWidth: { min: 50, max: 200, label: "腰幅", section: "腰" },
  hipDepth: { min: 50, max: 200, label: "腰の厚み", section: "腰" },
  spineCurve: {
    min: -50,
    max: 50,
    label: "背骨のカーブ",
    section: "腰",
    special: "spineCurve",
  },
  upperArmLength: { min: 50, max: 200, label: "上腕の長さ", section: "腕" },
  upperArmThickness: { min: 50, max: 200, label: "上腕の太さ", section: "腕" },
  lowerArmLength: { min: 50, max: 200, label: "前腕の長さ", section: "腕" },
  lowerArmThickness: { min: 50, max: 200, label: "前腕の太さ", section: "腕" },
  handLength: { min: 50, max: 200, label: "手の長さ", section: "手" },
  handWidth: { min: 50, max: 200, label: "手の幅", section: "手" },
  handThickness: { min: 50, max: 200, label: "手の厚み", section: "手" },
  thumbLength: { min: 50, max: 200, label: "親指：長さ", section: "指" },
  thumbThickness: { min: 50, max: 200, label: "親指：太さ", section: "指" },
  indexLength: { min: 50, max: 200, label: "人差し指：長さ", section: "指" },
  indexThickness: { min: 50, max: 200, label: "人差し指：太さ", section: "指" },
  middleLength: { min: 50, max: 200, label: "中指：長さ", section: "指" },
  middleThickness: { min: 50, max: 200, label: "中指：太さ", section: "指" },
  ringLength: { min: 50, max: 200, label: "薬指：長さ", section: "指" },
  ringThickness: { min: 50, max: 200, label: "薬指：太さ", section: "指" },
  littleLength: { min: 50, max: 200, label: "小指：長さ", section: "指" },
  littleThickness: { min: 50, max: 200, label: "小指：太さ", section: "指" },
  upperLegLength: { min: 50, max: 200, label: "太ももの長さ", section: "脚" },
  upperLegThickness: {
    min: 50,
    max: 200,
    label: "太ももの太さ",
    section: "脚",
  },
  lowerLegLength: { min: 50, max: 200, label: "すねの長さ", section: "脚" },
  lowerLegThickness: { min: 50, max: 200, label: "すねの太さ", section: "脚" },
  footLength: { min: 50, max: 200, label: "足の長さ", section: "足" },
  footWidth: { min: 50, max: 200, label: "足の幅", section: "足" },
  footHeight: { min: 50, max: 200, label: "足の甲の厚み", section: "足" },
  toesLength: { min: 50, max: 200, label: "つま先の長さ", section: "足" },
};

export class BodyShapeController {
  /**
   * @param {() => import('@pixiv/three-vrm').VRM | null} getVrm
   */
  constructor(getVrm) {
    this._getVrm = getVrm;
    this.params = { ...DEFAULTS };
    /** @type {Record<string, THREE.Object3D|null>} */
    this._boneNodes = {};
    /** @type {Record<string, number>} */
    this._boneLengthAxis = {};
    /** @type {Record<string, {x:number,y:number,z:number}>} */
    this._cumulativeScale = {};
    /** @type {THREE.Vector3|null} */
    this._restRootScale = null;
    /**
     * 読み込み時に既に乗っていたボーン scale（エクスポート済み体型を「新しい 1x」として扱うため）。
     * key = roleName, value = THREE.Vector3
     * @type {Record<string, THREE.Vector3>}
     */
    this._baseScales = {};
    /** @type {THREE.Vector3|null} */
    this._baseRootScale = null;
    this._bound = false;
    this._active = false;
    this._foundCount = 0;
    /** 足首ボーン〜靴底のギャップ（読込時に計測） */
    this._footGroundOffset = 0.04;
    this._groundProbe = new THREE.Vector3();
    /** パラメータ変更後に接地合わせが必要 */
    this._groundDirty = false;
    /** 体型変更後に spring を reset する */
    this._springResetNeeded = false;
    /** スライダー操作後、humanoid 再適用のあとに寸法を測る */
    this._metricsDirty = false;
    /**
     * 読込時（scale=1）の胴断面。スキニング変形は geometry に乗らないため、
     * ライブは rest 半幅 × スライダー倍率から周長を再計算する。
     * @type {{
     *   bust: {a:number,b:number},
     *   waist: {a:number,b:number},
     *   hip: {a:number,b:number},
     *   height: number
     * } | null}
     */
    this._restGirth = null;
    /** @type {Record<string, THREE.Vector3>|null} bind 時のローカル位置（厚みスケールの位置ずれ補正用） */
    this._restLocalPos = null;
  }

  /**
   * モデル読込直後に呼ぶ。raw bone をキャッシュし、長さ軸を計算する。
   */
  bindModel(vrm) {
    this._boneNodes = {};
    this._boneLengthAxis = {};
    this._cumulativeScale = {};
    this._active = false;
    this._foundCount = 0;

    if (!vrm?.humanoid) {
      console.warn("[body-shape] no humanoid");
      return;
    }

    // morpholith と同様: raw bone を直接触る
    // autoUpdateHumanBones は pose-maker がポーズに使うため true のままにし、
    // update 後に本コントローラが scale を再適用する。

    const names = HUMANOID_ROLES.concat(FINGER_BONE_NAMES);
    names.forEach((name) => {
      let node = null;
      try {
        node = vrm.humanoid.getRawBoneNode(name) || null;
      } catch (_) {
        node = null;
      }
      this._boneNodes[name] = node;
    });
    this._foundCount =
      HUMANOID_ROLES.filter((r) => !!this._boneNodes[r]).length;
    console.info(
      `[body-shape] VRM bones: ${this._foundCount} / ${HUMANOID_ROLES.length}`,
    );

    // 読み込み時に既に付いている scale を「ベース（新しい 1x）」として記憶する。
    // これにより、体型変更を書き出した VRM を再読込しても形が消えない。
    this._baseScales = {};
    let nonIdentityCount = 0;
    for (const name of names) {
      const node = this._boneNodes[name];
      if (node?.scale) {
        const s = node.scale.clone();
        this._baseScales[name] = s;
        if (
          Math.abs(s.x - 1) > 1e-4 ||
          Math.abs(s.y - 1) > 1e-4 ||
          Math.abs(s.z - 1) > 1e-4
        ) {
          nonIdentityCount++;
        }
      } else {
        this._baseScales[name] = new THREE.Vector3(1, 1, 1);
      }
    }
    this._baseRootScale = vrm.scene
      ? vrm.scene.scale.clone()
      : new THREE.Vector3(1, 1, 1);
    // _restRootScale は「params=1 のときのルート scale」。ベースを尊重する。
    this._restRootScale = this._baseRootScale.clone();

    this._computeBoneLengthAxes();
    this._cacheRestLocalPositions();
    this._active = true;
    this.params = { ...DEFAULTS };
    this._restGirth = null;
    this.syncUI();
    // 足首〜ソールのギャップを rest スケールで計測（morpholith footGroundOffset）
    this._footGroundOffset = 0.04;
    try {
      if (vrm.scene) {
        vrm.scene.updateMatrixWorld(true);
        const restBox = new THREE.Box3().setFromObject(vrm.scene);
        const footNode = this._getBoneNode("leftFoot") ||
          this._getBoneNode("rightFoot");
        if (!restBox.isEmpty() && footNode) {
          footNode.getWorldPosition(this._groundProbe);
          this._footGroundOffset = Math.max(
            this._groundProbe.y - restBox.min.y,
            0.005,
          );
        }
        // scale=1 のときの胴周長を記録（以降はスライダー倍率で近似）
        this._restGirth = this._measureRestGirth(vrm);
      }
    } catch (_) {}
    this._groundDirty = true;
    this._springResetNeeded = true;
    // ベース scale を維持したまま params=1 を適用（上書きで消さない）
    this.apply();
    if (nonIdentityCount > 0) {
      console.info(
        `[body-shape] preserved ${nonIdentityCount} non-identity base scales from loaded VRM`,
      );
    }
  }

  unbindModel() {
    this._boneNodes = {};
    this._baseScales = {};
    this._baseRootScale = null;
    this._active = false;
    this._foundCount = 0;
    this._restGirth = null;
    this._restLocalPos = null;
  }

  _getBoneNode(roleKey) {
    return this._boneNodes[roleKey] || null;
  }

  _computeBoneLengthAxes() {
    this._boneLengthAxis = {};
    Object.keys(AXIS_CHILD_REF).forEach((role) => {
      const childNode = this._getBoneNode(AXIS_CHILD_REF[role]);
      if (!childNode) {
        this._boneLengthAxis[role] = 1;
        return;
      }
      const pos = childNode.position;
      const ax = Math.abs(pos.x), ay = Math.abs(pos.y), az = Math.abs(pos.z);
      if (ax >= ay && ax >= az) this._boneLengthAxis[role] = 0;
      else if (az >= ax && az >= ay) this._boneLengthAxis[role] = 2;
      else this._boneLengthAxis[role] = 1;
    });
    ["left", "right"].forEach((side) => {
      Object.keys(FINGER_SEGMENTS).forEach((finger) => {
        const segs = FINGER_SEGMENTS[finger];
        const distalName = side + finger + segs[segs.length - 1];
        const proximalName = side + finger + segs[0];
        if (this._boneLengthAxis[distalName] === undefined) {
          this._boneLengthAxis[distalName] =
            this._boneLengthAxis[proximalName] !== undefined
              ? this._boneLengthAxis[proximalName]
              : 1;
        }
      });
    });
  }

  /** morpholith scaleBoneRole */
  _scaleBoneRole(roleKey, sx, sy, sz) {
    const node = this._getBoneNode(roleKey);
    const parentKey = SCALE_PARENT[roleKey];
    let px = 1, py = 1, pz = 1;
    if (parentKey && this._cumulativeScale[parentKey]) {
      px = this._cumulativeScale[parentKey].x;
      py = this._cumulativeScale[parentKey].y;
      pz = this._cumulativeScale[parentKey].z;
    }
    this._cumulativeScale[roleKey] = { x: sx, y: sy, z: sz };
    if (node) {
      // 相対スケール (params 由来) に、読み込み時のベース scale を乗算する。
      // これで「体型を書き出した VRM」を再読込しても形が消えず、そこから更に編集できる。
      const base = this._baseScales[roleKey] || { x: 1, y: 1, z: 1 };
      const tx = (sx / px) * base.x;
      const ty = (sy / py) * base.y;
      const tz = (sz / pz) * base.z;
      const s = node.scale;
      if (
        Math.abs(s.x - tx) > 1e-6 ||
        Math.abs(s.y - ty) > 1e-6 ||
        Math.abs(s.z - tz) > 1e-6
      ) {
        s.set(tx, ty, tz);
      }
    }
  }

  /** morpholith scaleBoneLTT */
  _scaleBoneLTT(roleKey, lengthVal, thickA, thickB) {
    const axis = this._boneLengthAxis[roleKey] !== undefined
      ? this._boneLengthAxis[roleKey]
      : 1;
    let sx, sy, sz;
    if (axis === 0) {
      sx = lengthVal;
      sy = thickA;
      sz = thickB;
    } else if (axis === 2) {
      sz = lengthVal;
      sx = thickA;
      sy = thickB;
    } else {
      sy = lengthVal;
      sx = thickA;
      sz = thickB;
    }
    this._scaleBoneRole(roleKey, sx, sy, sz);
  }

  /** 胴・頭・肩の bind ローカル位置を記憶（厚みスケールで前後に流れるのを戻すため） */
  _cacheRestLocalPositions() {
    this._restLocalPos = {};
    const roles = [
      "spine",
      "chest",
      "upperChest",
      "neck",
      "head",
      "leftShoulder",
      "rightShoulder",
    ];
    for (const role of roles) {
      const node = this._getBoneNode(role);
      if (node) this._restLocalPos[role] = node.position.clone();
    }
  }

  /**
   * 親の厚み軸スケールで子のローカル位置が引き伸ばされないよう補正する。
   * 長さ軸（親の length axis）だけは従来どおり伸ばし、幅・厚み軸は rest 位置を維持する。
   * これで胸・腰の厚みを変えても頭の前後位置がずれにくくなる。
   */
  _compensateThicknessChain() {
    if (!this._restLocalPos) return;
    const roles = [
      "spine",
      "chest",
      "upperChest",
      "neck",
      "head",
      "leftShoulder",
      "rightShoulder",
    ];
    for (const role of roles) {
      const node = this._getBoneNode(role);
      const rest = this._restLocalPos[role];
      if (!node || !rest) continue;
      const parentKey = SCALE_PARENT[role];
      const pc = parentKey && this._cumulativeScale[parentKey]
        ? this._cumulativeScale[parentKey]
        : { x: 1, y: 1, z: 1 };
      let lengthAxis = 1;
      if (parentKey && this._boneLengthAxis[parentKey] !== undefined) {
        lengthAxis = this._boneLengthAxis[parentKey];
      }
      const sx = Math.max(Math.abs(pc.x), 1e-6);
      const sy = Math.max(Math.abs(pc.y), 1e-6);
      const sz = Math.max(Math.abs(pc.z), 1e-6);
      let px = rest.x;
      let py = rest.y;
      let pz = rest.z;
      // 長さ軸以外は親スケールを打ち消して rest のワールド相対位置を保つ
      if (lengthAxis !== 0) px = rest.x / sx;
      if (lengthAxis !== 1) py = rest.y / sy;
      if (lengthAxis !== 2) pz = rest.z / sz;
      const pos = node.position;
      if (
        Math.abs(pos.x - px) > 1e-7 ||
        Math.abs(pos.y - py) > 1e-7 ||
        Math.abs(pos.z - pz) > 1e-7
      ) {
        pos.set(px, py, pz);
      }
    }
  }

  /**
   * 背骨の前後カーブを raw ボーンに載せる。
   * humanoid.update() が毎フレーム quaternion を上書きするため、
   * scale と同様に onAfterHumanoidUpdate → apply(fromFrame) のたびに再適用する。
   * 現在のポーズ回転の上に乗算する（rest を固定保存しない）ので、
   * ポーズ操作とも両立する。
   */
  _applySpineCurve(p) {
    const amount = p.spineCurve || 0;
    if (Math.abs(amount) < 1e-5) return;

    // スライダー ±50 → amount ±0.5 rad 相当。見た目が分かる程度の配分
    const pairs = [
      ["spine", 0.7],
      ["chest", -0.5],
      ["upperChest", -0.25],
    ];
    const axis = new THREE.Vector3();
    const q = new THREE.Quaternion();
    for (const [role, weight] of pairs) {
      const node = this._getBoneNode(role);
      if (!node) continue;
      const angle = amount * weight;
      if (Math.abs(angle) < 1e-5) continue;
      // ボーン長さ方向と直交する軸で前後に曲げる
      const lenAxis = this._boneLengthAxis[role];
      if (lenAxis === 0) axis.set(0, 0, 1);
      else if (lenAxis === 2) axis.set(1, 0, 0);
      else axis.set(1, 0, 0); // 長さが Y（一般的な胴）→ ローカル X で前後
      q.setFromAxisAngle(axis, angle);
      node.quaternion.multiply(q);
    }
  }

  /** morpholith applyImportedScaling と同一の並び */
  apply(opts = {}) {
    const vrm = this._getVrm();
    if (!vrm?.scene || !this._active) return;
    const fromFrame = !!opts.fromFrame;
    const p = this.params;
    if (!fromFrame) {
      this._groundDirty = true;
      this._springResetNeeded = true;
    }

    // Reset cumulative scales each pass
    this._cumulativeScale = {};

    const r = this._restRootScale || new THREE.Vector3(1, 1, 1);
    {
      const tx = r.x * p.build, ty = r.y * p.height, tz = r.z * p.build;
      const s = vrm.scene.scale;
      if (
        Math.abs(s.x - tx) > 1e-6 ||
        Math.abs(s.y - ty) > 1e-6 ||
        Math.abs(s.z - tz) > 1e-6
      ) {
        s.set(tx, ty, tz);
      }
    }

    this._scaleBoneLTT("hips", p.hipLength, p.hipWidth, p.hipDepth);
    this._scaleBoneLTT("spine", p.waistLength, p.waistSize, p.hipDepth);
    this._scaleBoneLTT("chest", p.chestLength, p.chestWidth, p.chestDepth);
    this._scaleBoneLTT(
      "upperChest",
      p.upperChestLength,
      p.upperChestWidth,
      p.upperChestDepth,
    );
    this._scaleBoneLTT("neck", p.neckLength, p.neckThickness, p.neckThickness);
    this._scaleBoneRole("head", p.headWidth, p.headLength, p.headWidth);
    this._scaleBoneLTT(
      "leftShoulder",
      p.shoulderWidth,
      1,
      1,
    );
    this._scaleBoneLTT(
      "rightShoulder",
      p.shoulderWidth,
      1,
      1,
    );
    this._scaleBoneLTT(
      "leftUpperArm",
      p.upperArmLength,
      p.upperArmThickness,
      p.upperArmThickness,
    );
    this._scaleBoneLTT(
      "rightUpperArm",
      p.upperArmLength,
      p.upperArmThickness,
      p.upperArmThickness,
    );
    this._scaleBoneLTT(
      "leftLowerArm",
      p.lowerArmLength,
      p.lowerArmThickness,
      p.lowerArmThickness,
    );
    this._scaleBoneLTT(
      "rightLowerArm",
      p.lowerArmLength,
      p.lowerArmThickness,
      p.lowerArmThickness,
    );
    this._scaleBoneLTT("leftHand", p.handLength, p.handWidth, p.handThickness);
    this._scaleBoneLTT("rightHand", p.handLength, p.handWidth, p.handThickness);
    this._scaleBoneLTT(
      "leftUpperLeg",
      p.upperLegLength,
      p.upperLegThickness,
      p.upperLegThickness,
    );
    this._scaleBoneLTT(
      "rightUpperLeg",
      p.upperLegLength,
      p.upperLegThickness,
      p.upperLegThickness,
    );
    this._scaleBoneLTT(
      "leftLowerLeg",
      p.lowerLegLength,
      p.lowerLegThickness,
      p.lowerLegThickness,
    );
    this._scaleBoneLTT(
      "rightLowerLeg",
      p.lowerLegLength,
      p.lowerLegThickness,
      p.lowerLegThickness,
    );
    this._scaleBoneLTT("leftFoot", p.footLength, p.footWidth, p.footHeight);
    this._scaleBoneLTT("rightFoot", p.footLength, p.footWidth, p.footHeight);
    this._scaleBoneLTT(
      "leftToes",
      p.toesLength,
      p.footWidth * 0.8,
      p.footHeight * 0.8,
    );
    this._scaleBoneLTT(
      "rightToes",
      p.toesLength,
      p.footWidth * 0.8,
      p.footHeight * 0.8,
    );

    FINGER_BONE_NAMES.forEach((name) => {
      let finger = null;
      for (const f of ["Thumb", "Index", "Middle", "Ring", "Little"]) {
        if (name.includes(f)) {
          finger = f;
          break;
        }
      }
      if (!finger) return;
      const key = finger.toLowerCase();
      this._scaleBoneLTT(
        name,
        p[key + "Length"],
        p[key + "Thickness"],
        p[key + "Thickness"],
      );
    });

    this._compensateThicknessChain();
    this._applySpineCurve(p);
    if (this._groundDirty) {
      this._groundAlign();
      this._groundDirty = false;
    }
    if (this._springResetNeeded) {
      this._resetSpringBones(vrm);
      this._springResetNeeded = false;
    }

    // 寸法は humanoid.update 後の reapplyIfNeeded で測る（この時点の scale は次フレームで上書きされる）
    if (!fromFrame) this._metricsDirty = true;
  }

  _resetSpringBones(vrm) {
    try {
      const manager = vrm?.springBoneManager;
      if (manager && typeof manager.reset === "function") {
        vrm.scene?.updateMatrixWorld(true);
        manager.reset();
      }
    } catch (e) {
      console.warn("[body-shape] spring reset", e);
    }
  }

  /**
   * morpholith groundAlignImportedModel
   * 脚の長さスケール後、足首ワールド位置とソールギャップから接地を合わせる。
   */
  _groundAlign() {
    const vrm = this._getVrm();
    if (!vrm?.scene) return;
    const leftFoot = this._getBoneNode("leftFoot");
    const rightFoot = this._getBoneNode("rightFoot");
    if (!leftFoot && !rightFoot) return;

    const p = this.params;
    // XZ は維持、Y だけ再計算（単一モデル想定。position.x は _placeNewModel 用に残す）
    const keepX = vrm.scene.position.x;
    const keepZ = vrm.scene.position.z;
    vrm.scene.position.y = 0;
    vrm.scene.updateMatrixWorld(true);

    let minY = Infinity;
    for (const n of [leftFoot, rightFoot]) {
      if (!n) continue;
      n.getWorldPosition(this._groundProbe);
      if (this._groundProbe.y < minY) minY = this._groundProbe.y;
    }
    if (minY === Infinity) {
      vrm.scene.position.set(keepX, 0, keepZ);
      return;
    }
    const soleGap = this._footGroundOffset * (p.height || 1) *
      (p.footHeight || 1);
    vrm.scene.position.set(keepX, -(minY - soleGap), keepZ);
    vrm.scene.updateMatrixWorld(true);
  }

  /**
   * humanoid.update の直後（揺れ物の前）に毎フレーム呼ぶ。
   * scale が humanoid によって戻されたときだけ書き直す（同じ値の set はしない）。
   * 接地合わせ・spring reset はユーザがスライダーを動かしたときだけ。
   */
  reapplyIfNeeded() {
    if (!this._active) return;
    this.apply({ fromFrame: true });
    if (this._metricsDirty) {
      this._metricsDirty = false;
      this.updateMetrics();
    }
  }

  applyBodyTypeFromSlider(sliderVal) {
    const t = sliderVal / 100;
    this.params.bodyType = t;
    // 細身〜ぽっちゃり: 胴の横幅・奥行きと四肢の太さを連動させる
    // （BWH 計測が太さ変化を拾えるよう、幅だけでなく奥行きも動かす）
    this.params.waistSize = 1 + t * 0.5;
    this.params.chestWidth = 1 + t * 0.22;
    this.params.chestDepth = 1 + t * 0.18;
    this.params.upperChestWidth = 1 + t * 0.22;
    this.params.upperChestDepth = 1 + t * 0.18;
    this.params.hipWidth = 1 + t * 0.28;
    this.params.hipDepth = 1 + t * 0.22;
    this.params.upperArmThickness = 1 + t * 0.4;
    this.params.lowerArmThickness = 1 + t * 0.4;
    this.params.upperLegThickness = 1 + t * 0.4;
    this.params.lowerLegThickness = 1 + t * 0.4;
    this.syncUI();
    this.apply();
  }

  reset() {
    this.params = { ...DEFAULTS };
    this.syncUI();
    this.apply();
  }

  /**
   * 各スライダーを可動域内でランダム化
   */
  randomize() {
    for (const key of Object.keys(SLIDER_META)) {
      const meta = SLIDER_META[key];
      if (!meta) continue;
      const min = meta.min ?? 50;
      const max = meta.max ?? 150;
      const sliderVal = min + Math.random() * (max - min);
      if (meta.special === "bodyType") {
        this.params.bodyType = sliderVal / 100;
      } else if (meta.special === "spineCurve") {
        this.params.spineCurve = sliderVal / 100;
      } else {
        this.params[key] = sliderVal / 100;
      }
    }
    this.syncUI();
    this.apply();
  }

  resetKey(key) {
    if (!(key in DEFAULTS)) return;
    if (key === "bodyType") {
      this.applyBodyTypeFromSlider(0);
      return;
    }
    this.params[key] = DEFAULTS[key];
    this.syncUI();
    this.apply();
  }

  /**
   * 体型適用後の実寸目安を canvas 左上に出す。
   * - 身長: 足底〜頭頂（髪の毛先や手上げを除外するためボーン基準）
   * - 座高: 座面（hips 中心 − 骨盤厚みの半分）〜頭頂
   * - 等身: 身長 / 頭高（首ボーン〜頭頂）
   * - BWH: 読込時の胴断面半幅 (左右・前後) に各部位スライダーを掛け、
   *   楕円周長で再計算（B=胸 / W=ウエスト / H=腰。相互干渉なし）
   */
  updateMetrics() {
    const vrm = this._getVrm();
    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };
    if (!vrm?.scene || !this._active) {
      set("metric-height", "—");
      set("metric-sitting", "—");
      set("metric-heads", "—");
      set("metric-bwh", "—");
      return;
    }

    vrm.scene.updateMatrixWorld(true);

    const pos = new THREE.Vector3();
    const head = this._getBoneNode("head");
    const neck = this._getBoneNode("neck");
    const hips = this._getBoneNode("hips");
    const leftFoot = this._getBoneNode("leftFoot");
    const rightFoot = this._getBoneNode("rightFoot");

    // 頭頂: 頭ボーン配下メッシュの maxY。無ければ頭ボーン + 余裕
    let headTopY = null;
    if (head) {
      head.getWorldPosition(pos);
      headTopY = pos.y;
      const headBox = new THREE.Box3();
      let hasMesh = false;
      head.traverse((o) => {
        if (!o.isMesh || !o.geometry) return;
        const b = new THREE.Box3().setFromObject(o);
        if (!b.isEmpty()) {
          headBox.union(b);
          hasMesh = true;
        }
      });
      if (hasMesh && !headBox.isEmpty()) {
        headTopY = Math.max(headTopY, headBox.max.y);
      } else {
        // メッシュが頭ボーン直下に無いモデル向けのフォールバック
        headTopY = pos.y +
          0.12 * (this.params.headLength || 1) * (this.params.height || 1);
      }
    }

    // 足底
    let footY = null;
    for (const f of [leftFoot, rightFoot]) {
      if (!f) continue;
      f.getWorldPosition(pos);
      const y = pos.y - this._footGroundOffset * (this.params.height || 1);
      footY = footY == null ? y : Math.min(footY, y);
    }

    // フォールバック: 全体 AABB（最後の手段）
    if (headTopY == null || footY == null) {
      const box = new THREE.Box3().setFromObject(vrm.scene);
      if (box.isEmpty()) {
        set("metric-height", "—");
        set("metric-sitting", "—");
        set("metric-heads", "—");
        set("metric-bwh", "—");
        return;
      }
      if (headTopY == null) headTopY = box.max.y;
      if (footY == null) footY = box.min.y;
    }

    const heightM = Math.max(headTopY - footY, 0);

    // 座高: 座面（hips 中心 − 骨盤厚みの半分）〜 頭頂
    // hips は骨盤中心なので、そのままだと実際の座面より高くなり座高が短く出る。
    // hipDepth / build / height で厚み分を下げ、身長比でガードする。
    let sittingM = heightM * 0.52;
    if (hips) {
      hips.getWorldPosition(pos);
      const hp = this.params;
      const hipHalf = 0.04 * (hp.height || 1) * (hp.build || 1) *
        (hp.hipDepth || 1);
      const seatOffset = Math.min(
        Math.max(hipHalf, heightM * 0.02),
        heightM * 0.06,
      );
      const seatY = pos.y - seatOffset;
      sittingM = Math.max(headTopY - seatY, 0);
    }

    // 頭高: 首（あご下付近）〜 頭頂。等身計算の分母。
    let headM = 0;
    if (neck) {
      neck.getWorldPosition(pos);
      headM = Math.max(headTopY - pos.y, 0);
    } else if (head) {
      head.getWorldPosition(pos);
      // 頭ボーンは頭の中心付近であることが多い → 頭頂までの 2 倍を頭高の近似に
      headM = Math.max((headTopY - pos.y) * 2, 0);
    }
    // 異常値ガード（身長の 5%〜25% にクランプ）
    if (heightM > 0) {
      const lo = heightM * 0.05;
      const hi = heightM * 0.25;
      if (headM < lo || headM > hi) {
        // 典型的な 7〜8 頭身寄りにフォールバックせず、計測不能として —
        // ただし僅差の外れはクランプ
        if (headM > 0 && headM < lo) headM = lo;
        else if (headM > hi) headM = hi;
      }
    }
    const heads = headM > 1e-4 ? heightM / headM : 0;

    // BWH: 読込時の半幅 (a=左右, b=前後) × 各部位スライダーで楕円周長を再計算。
    // geometry はスキニング後頂点を持たないため rest×scale 方式。
    // B←胸、W←ウエスト、H←腰。相互に干渉しない。
    const p = this.params;
    const build = p.build || 1;
    const rest = this._restGirth;
    let bustM = 0;
    let waistM = 0;
    let hipM = 0;
    if (rest?.bust && rest?.waist && rest?.hip) {
      // 幅・奥行きを別々にスケールしてから Ramanujan 楕円周長
      // spine の Z は hipDepth 連動のため、W の前後にも少し反映
      const ba = rest.bust.a * build * (p.chestWidth || 1);
      const bb = rest.bust.b * build * (p.chestDepth || 1);
      const wa = rest.waist.a * build * (p.waistSize || 1);
      const wb = rest.waist.b * build * (p.waistSize || 1);
      const ha = rest.hip.a * build * (p.hipWidth || 1);
      const hb = rest.hip.b * build * (p.hipDepth || 1);
      bustM = this._ellipseGirth(ba, bb);
      waistM = this._ellipseGirth(wa, wb);
      hipM = this._ellipseGirth(ha, hb);
    }

    const cm = (m) => (m * 100).toFixed(1) + " cm";
    set("metric-height", heightM > 0.1 ? cm(heightM) : "—");
    set("metric-sitting", sittingM > 0.05 ? cm(sittingM) : "—");
    set("metric-heads", heads >= 3 && heads <= 12 ? heads.toFixed(2) : "—");
    if (bustM > 0.2 && waistM > 0.15 && hipM > 0.2) {
      set(
        "metric-bwh",
        `${(bustM * 100).toFixed(0)} / ${(waistM * 100).toFixed(0)} / ${
          (hipM * 100).toFixed(0)
        }`,
      );
    } else {
      set("metric-bwh", "—");
    }
  }

  /** Ramanujan 楕円周長（半軸 a, b） */
  _ellipseGirth(a, b) {
    const aa = Math.abs(a);
    const bb = Math.abs(b);
    if (aa < 0.01 || bb < 0.01) return 0;
    const h = ((aa - bb) * (aa - bb)) / ((aa + bb) * (aa + bb));
    return Math.PI * (aa + bb) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  }

  /**
   * 読込直後（params = DEFAULTS）の胴断面半幅を測る。
   * この時点は scale=1 なので bind pose の断面が取れる。
   * @returns {{bust:{a:number,b:number}, waist:{a:number,b:number}, hip:{a:number,b:number}, height:number}|null}
   */
  _measureRestGirth(vrm) {
    if (!vrm?.scene) return null;
    vrm.scene.updateMatrixWorld(true);
    // スケルトンを最新の bone matrix に更新（SkinnedMesh.boneTransform 用）
    vrm.scene.traverse((o) => {
      if (o.isSkinnedMesh && o.skeleton) o.skeleton.update();
    });

    const pos = new THREE.Vector3();
    const head = this._getBoneNode("head");
    const hips = this._getBoneNode("hips");
    const spine = this._getBoneNode("spine");
    const chest = this._getBoneNode("upperChest") || this._getBoneNode("chest");
    const leftFoot = this._getBoneNode("leftFoot");
    const rightFoot = this._getBoneNode("rightFoot");

    let headTopY = null;
    if (head) {
      head.getWorldPosition(pos);
      headTopY = pos.y + 0.12;
    }
    let footY = null;
    for (const f of [leftFoot, rightFoot]) {
      if (!f) continue;
      f.getWorldPosition(pos);
      const y = pos.y - this._footGroundOffset;
      footY = footY == null ? y : Math.min(footY, y);
    }
    if (headTopY == null || footY == null) {
      const box = new THREE.Box3().setFromObject(vrm.scene);
      if (box.isEmpty()) return null;
      if (headTopY == null) headTopY = box.max.y;
      if (footY == null) footY = box.min.y;
    }
    const heightM = Math.max(headTopY - footY, 0.1);

    const yOf = (node, fallbackRel) => {
      if (node) {
        node.getWorldPosition(pos);
        return pos.y;
      }
      return footY + heightM * fallbackRel;
    };
    // 高さの目安
    const yChest = yOf(chest, 0.72) - heightM * 0.015;
    const ySpine = yOf(spine, 0.56);
    const yHipsBone = yOf(hips, 0.48);
    // ヒップは臀部の膨らみ（股関節よりやや下）
    const yHips = yHipsBone - heightM * 0.035;

    const axisOf = (node, fallback) => {
      const a = new THREE.Vector3();
      if (node) node.getWorldPosition(a);
      else if (fallback) fallback.getWorldPosition(a);
      return a;
    };
    const axisChest = axisOf(chest, spine || hips);
    const axisWaist = axisOf(spine, hips);
    const axisHip = axisOf(hips, spine);

    const ls = this._getBoneNode("leftShoulder");
    const rs = this._getBoneNode("rightShoulder");
    let shoulderHalf = heightM * 0.14;
    if (ls && rs) {
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      ls.getWorldPosition(a);
      rs.getWorldPosition(b);
      // 肩幅の半分より少し狭め → 腕・袖を落としやすい
      shoulderHalf = Math.max(a.distanceTo(b) * 0.42, heightM * 0.09);
    }
    // 胴コアだけ。服の袖・だぶつきを拾わないよう控えめに
    const torsoR = shoulderHalf * 0.98;

    const band = Math.max(heightM * 0.01, 0.006);
    const bust = this._estimateTorsoHalfExtents(
      vrm.scene,
      yChest,
      band,
      axisChest.x,
      axisChest.z,
      torsoR * 1.05,
    );

    // ウエスト: 胸下〜ヒップ上の範囲でいちばん細い断面を採用（自然ウエスト）
    // 服のシワや固定高さの外れを避け、W が B/H に近づきすぎるのを防ぐ
    const waistY0 = Math.min(yChest, yHipsBone) +
      Math.abs(yChest - yHipsBone) * 0.2;
    const waistY1 = Math.min(yChest, yHipsBone) +
      Math.abs(yChest - yHipsBone) * 0.75;
    let waist = null;
    let waistGirth = Infinity;
    const waistSteps = 10;
    for (let i = 0; i <= waistSteps; i++) {
      const t = i / waistSteps;
      const y = waistY0 + (waistY1 - waistY0) * t;
      const ab = this._estimateTorsoHalfExtents(
        vrm.scene,
        y,
        band,
        axisWaist.x,
        axisWaist.z,
        torsoR * 0.88,
      );
      if (!ab) continue;
      const g = this._ellipseGirth(ab.a, ab.b);
      if (g > 0.12 && g < waistGirth) {
        waistGirth = g;
        waist = ab;
      }
    }
    // 探索失敗時は spine 高さ
    if (!waist) {
      waist = this._estimateTorsoHalfExtents(
        vrm.scene,
        ySpine,
        band,
        axisWaist.x,
        axisWaist.z,
        torsoR * 0.88,
      );
    }

    const hip = this._estimateTorsoHalfExtents(
      vrm.scene,
      yHips,
      band,
      axisHip.x,
      axisHip.z,
      torsoR * 1.2,
    );
    if (!bust || !waist || !hip) return null;
    return { bust, waist, hip, height: heightM };
  }

  /**
   * 胴断面の左右半幅 a・前後半幅 b を返す。
   * SkinnedMesh は boneTransform で変形後頂点を使う。
   * 体軸から maxR 以内、かつ角度ビンの最大半径からシルエットを構成して過大評価を抑える。
   * @returns {{a:number,b:number}|null}
   */
  _estimateTorsoHalfExtents(root, y, band, cx, cz, maxR) {
    const band2 = Math.max(band, 0.006);
    const maxR2 = maxR * maxR;
    const v = new THREE.Vector3();
    const BIN = 24;
    const maxRad = new Float64Array(BIN); // 角度ごとの最大半径

    root.traverse((obj) => {
      if (!obj.isMesh || !obj.geometry) return;
      // 髪・腕・袖・裾など胴コア以外を名前で除外
      if (
        obj.name &&
        /hair|bangs|尾|髪|ponytail|ahoge|skirt|sleeve|arm|手|腕|袖|裾|ribbon|wing|cloak|cape/i
          .test(
            obj.name,
          )
      ) {
        return;
      }
      const posAttr = obj.geometry.attributes?.position;
      if (!posAttr) return;

      const isSkinned = obj.isSkinnedMesh &&
        obj.skeleton &&
        typeof obj.boneTransform === "function";
      if (!isSkinned) obj.updateWorldMatrix(true, false);
      const mw = obj.matrixWorld;

      for (let i = 0; i < posAttr.count; i++) {
        if (isSkinned) {
          obj.boneTransform(i, v);
          v.applyMatrix4(mw);
        } else {
          v.fromBufferAttribute(posAttr, i).applyMatrix4(mw);
        }
        if (Math.abs(v.y - y) > band2) continue;
        const dx = v.x - cx;
        const dz = v.z - cz;
        const r2 = dx * dx + dz * dz;
        if (r2 > maxR2 || r2 < 1e-8) continue;
        const r = Math.sqrt(r2);
        let ang = Math.atan2(dz, dx);
        if (ang < 0) ang += Math.PI * 2;
        const bi = Math.min(BIN - 1, (ang / (Math.PI * 2)) * BIN) | 0;
        if (r > maxRad[bi]) maxRad[bi] = r;
      }
    });

    // 有効半径を集め、外れ値（服のひらひら）を抑えるため上位を少し切り捨て
    const radii = [];
    for (let i = 0; i < BIN; i++) {
      if (maxRad[i] >= 0.01) radii.push(maxRad[i]);
    }
    if (radii.length < 6) return null;
    radii.sort((x, y) => x - y);
    // 最大付近のスパイクを避け、おおよそ 85% 点を胴半径の代表に
    const rUse = radii[Math.min(radii.length - 1, (radii.length * 0.85) | 0)];

    // 各ビンを rUse でキャップしてから左右・前後半幅を取る
    let maxAbsX = 0;
    let maxAbsZ = 0;
    let filled = 0;
    for (let i = 0; i < BIN; i++) {
      let r = maxRad[i];
      if (r < 0.01) continue;
      if (r > rUse) r = rUse;
      filled++;
      const ang = ((i + 0.5) / BIN) * Math.PI * 2;
      const ax = Math.abs(Math.cos(ang) * r);
      const az = Math.abs(Math.sin(ang) * r);
      if (ax > maxAbsX) maxAbsX = ax;
      if (az > maxAbsZ) maxAbsZ = az;
    }
    if (filled < 6) return null;
    if (maxAbsX < 0.02 || maxAbsZ < 0.015) return null;
    return { a: maxAbsX, b: maxAbsZ };
  }

  /**
   * 互換: 断面周長（半幅から楕円近似）
   */
  _estimateTorsoGirth(root, y, band, cx, cz, maxR) {
    const ab = this._estimateTorsoHalfExtents(root, y, band, cx, cz, maxR);
    if (!ab) return 0;
    return this._ellipseGirth(ab.a, ab.b);
  }

  bindUI() {
    if (this._bound) return;
    this._bound = true;

    // 委譲: 左サイドバー全体（ヘッダーのランダム/リセット含む）
    const panel = document.getElementById("panel-left") ||
      document.getElementById("body-shape-panel") ||
      document.getElementById("panel-tab-model");
    if (panel) {
      panel.addEventListener("input", (e) => {
        const t = e.target;
        if (!t || t.tagName !== "INPUT" || t.type !== "range") return;
        const id = t.id || "";
        if (!id.startsWith("p_")) return;
        const key = id.slice(2);
        if (!(key in SLIDER_META)) return;
        this._onSlider(key, t);
      });
      panel.addEventListener("click", (e) => {
        const btn = e.target?.closest?.(".body-slider-reset");
        if (btn) {
          e.preventDefault();
          const key = btn.getAttribute("data-body-key");
          if (key) this.resetKey(key);
          return;
        }
        if (e.target?.closest?.("#btn-body-random")) {
          e.preventDefault();
          this.randomize();
          return;
        }
        if (e.target?.closest?.("#btn-body-reset")) {
          e.preventDefault();
          this.reset();
        }
      });
    }

    // 個別にも念のため
    Object.keys(SLIDER_META).forEach((key) => {
      const el = document.getElementById("p_" + key);
      if (!el) return;
      el.addEventListener("input", () => this._onSlider(key, el));
      el.addEventListener("change", () => this._onSlider(key, el));
    });

    this.syncUI();
    this._applyLabels();
  }

  /** HTML 上の体型ラベルを i18n 辞書で上書き（言語別HTMLと二重でも安全） */
  _applyLabels() {
    const panel = document.getElementById("body-shape-panel") ||
      document.getElementById("panel-left");
    if (!panel) return;
    for (const key of Object.keys(SLIDER_META)) {
      const label = panel.querySelector(`label[for="p_${key}"]`);
      if (label) {
        const text = tr("body." + key);
        if (text && text !== "body." + key) {
          label.textContent = text;
          label.title = text;
        }
      }
      const resetBtn = panel.querySelector(
        `.body-slider-reset[data-body-key="${key}"]`,
      );
      if (resetBtn) {
        const t = tr("body." + key + ".reset");
        if (t && t !== "body." + key + ".reset") {
          resetBtn.title = t;
          resetBtn.setAttribute("aria-label", t);
        }
      }
    }
    // header buttons
    const rand = document.getElementById("btn-body-random");
    if (rand) {
      const t = tr("body.random");
      if (t !== "body.random") {
        rand.title = t;
        rand.setAttribute("aria-label", t);
      }
    }
    const reset = document.getElementById("btn-body-reset");
    if (reset) {
      const t = tr("body.reset");
      if (t !== "body.reset") {
        reset.title = t;
        reset.setAttribute("aria-label", t);
      }
    }
    // panel title
    const title = document.querySelector(
      "#panel-left .p-2.border-bottom span.small.fw-bold",
    );
    if (title) {
      const t = tr("body.panel");
      if (t !== "body.panel") {
        // keep icon, replace text node after svg
        const svg = title.querySelector("svg");
        title.textContent = "";
        if (svg) title.appendChild(svg);
        title.append(" " + t);
      }
    }
    // section headers: match by data attribute if present; else skip
    panel.querySelectorAll("[data-body-section]").forEach((el) => {
      const k = el.getAttribute("data-body-section");
      const t = tr("body.section." + k);
      if (t && t !== "body.section." + k) el.textContent = t;
    });
    // メトリクスは canvas 左上オーバーレイ（panel 外）にもある
    document.querySelectorAll("[data-body-metric-label]").forEach((el) => {
      const k = el.getAttribute("data-body-metric-label");
      const t = tr("body.metric." + k);
      if (t && t !== "body.metric." + k) el.textContent = t;
    });
  }

  _onSlider(key, el) {
    const meta = SLIDER_META[key];
    if (!meta) return;
    const v = parseFloat(el.value);
    if (!Number.isFinite(v)) return;

    if (meta.special === "bodyType") {
      this.applyBodyTypeFromSlider(v);
      return;
    }
    if (meta.special === "spineCurve") {
      this.params.spineCurve = v / 100;
      const lab = document.getElementById("v_" + key);
      if (lab) lab.textContent = String(Math.round(v));
      this.apply();
      return;
    }
    this.params[key] = v / 100;
    const lab = document.getElementById("v_" + key);
    if (lab) lab.textContent = this.params[key].toFixed(2) + "×";
    this.apply();
  }

  syncUI() {
    Object.keys(SLIDER_META).forEach((key) => {
      const el = document.getElementById("p_" + key);
      const lab = document.getElementById("v_" + key);
      const meta = SLIDER_META[key];
      if (!el) return;
      if (meta.special === "bodyType") {
        const v = Math.round((this.params.bodyType || 0) * 100);
        el.value = String(v);
        if (lab) lab.textContent = String(v);
      } else if (meta.special === "spineCurve") {
        const v = Math.round((this.params.spineCurve || 0) * 100);
        el.value = String(v);
        if (lab) lab.textContent = String(v);
      } else {
        el.value = String(Math.round((this.params[key] ?? 1) * 100));
        if (lab) lab.textContent = (this.params[key] ?? 1).toFixed(2) + "×";
      }
    });
  }

  // 互換
  captureRest() {
    const vrm = this._getVrm();
    if (vrm) this.bindModel(vrm);
  }
}

export { DEFAULTS as BODY_SHAPE_DEFAULTS };
