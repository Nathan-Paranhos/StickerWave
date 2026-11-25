/**
 * Generate public/models/wavi.glb and public/models/wavi-low.glb directly with Three.js
 * derived from the exact Bezier geometry, proportions, and palette of public/images/wavi.svg.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AnimationClip, CatmullRomCurve3, Color, ExtrudeGeometry, Float32BufferAttribute, Group,
  LatheGeometry, Mesh, MeshStandardMaterial, Quaternion, QuaternionKeyframeTrack, Shape,
  SphereGeometry, TubeGeometry, Vector2, Vector3, VectorKeyframeTrack,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    onloadend = null;
    result = null;
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(buf => {
        this.result = buf;
        this.onloadend?.();
      });
    }
  };
}

// Map SVG viewBox (1150 x 767, ground line ~725) directly into Three.js space (floor y = 0.23).
const SVG_CX = 575;
const SVG_GROUND = 725;
const SVG_SCALE = 0.00292;
const to3X = sx => (sx - SVG_CX) * SVG_SCALE;
const to3Y = sy => 0.23 + (SVG_GROUND - sy) * SVG_SCALE;

function cubic2D(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const t2 = t * t;
  return [
    mt2 * mt * p0[0] + 3 * mt2 * t * p1[0] + 3 * mt * t2 * p2[0] + t2 * t * p3[0],
    mt2 * mt * p0[1] + 3 * mt2 * t * p1[1] + 3 * mt * t2 * p2[1] + t2 * t * p3[1],
  ];
}

// Right half of #mascot-body from bottom center (575,678) up to top crown (575,178).
const BODY_BEZIER_BOTTOM_TO_TOP = [
  [[575, 678], [696, 678], [786, 644], [823, 554]],
  [[823, 554], [847, 493], [839, 425], [815, 358]],
  [[815, 358], [775, 249], [704, 178], [575, 178]],
];

const BODY_PROFILE = [];
for (const [segIdx, seg] of BODY_BEZIER_BOTTOM_TO_TOP.entries()) {
  const n = 40;
  for (let i = segIdx === 0 ? 0 : 1; i <= n; i++) {
    const [sx, sy] = cubic2D(seg[0], seg[1], seg[2], seg[3], i / n);
    BODY_PROFILE.push({ r: Math.max(0, to3X(sx)), y: to3Y(sy) });
  }
}
const BODY_RZ_RATIO = 0.82;

function bodyRadiusAtY(y) {
  if (y <= BODY_PROFILE[0].y) return 0;
  const last = BODY_PROFILE[BODY_PROFILE.length - 1];
  if (y >= last.y) return 0;
  for (let i = 1; i < BODY_PROFILE.length; i++) {
    const a = BODY_PROFILE[i - 1];
    const b = BODY_PROFILE[i];
    if (y <= b.y) {
      const u = (y - a.y) / Math.max(1e-6, b.y - a.y);
      return a.r + (b.r - a.r) * u;
    }
  }
  return 0;
}

function bodySurfaceZ(x, y) {
  const rx = bodyRadiusAtY(y);
  if (rx <= 1e-4) return 0;
  const rz = rx * BODY_RZ_RATIO;
  const inside = Math.max(0, 1 - (x / rx) ** 2);
  return rz * Math.sqrt(inside);
}

function createMaterials() {
  return {
    lime: new MeshStandardMaterial({
      name: 'Wavi / lima',
      color: new Color('#b7e32c'),
      roughness: 0.56,
      metalness: 0.0,
    }),
    tuft: new MeshStandardMaterial({
      name: 'Wavi / reflexo',
      color: new Color('#cef448'),
      roughness: 0.50,
      metalness: 0.0,
    }),
    graphite: new MeshStandardMaterial({
      name: 'Fones / grafite',
      color: new Color('#343533'),
      roughness: 0.42,
      metalness: 0.10,
    }),
    cushion: new MeshStandardMaterial({
      name: 'Fones / almofada',
      color: new Color('#292b28'),
      roughness: 0.72,
      metalness: 0.02,
    }),
    eye: new MeshStandardMaterial({
      name: 'Olhos',
      color: new Color('#141612'),
      roughness: 0.12,
      metalness: 0.0,
    }),
    glow: new MeshStandardMaterial({
      name: 'Reflexos',
      color: new Color('#ffffff'),
      emissive: new Color('#ffffff'),
      emissiveIntensity: 0.85,
      roughness: 0.10,
    }),
    mouthBg: new MeshStandardMaterial({
      name: 'Boca / fundo',
      color: new Color('#361210'),
      roughness: 0.82,
      metalness: 0.0,
    }),
    tongue: new MeshStandardMaterial({
      name: 'Língua',
      color: new Color('#ea7875'),
      roughness: 0.48,
      metalness: 0.0,
    }),
  };
}

function makeBody(low) {
  const steps = low ? 16 : 24;
  const radial = low ? 18 : 28;
  const y0 = BODY_PROFILE[0].y;
  const y1 = BODY_PROFILE[BODY_PROFILE.length - 1].y;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * Math.PI;
    const s = (1 - Math.cos(theta)) / 2;
    const y = y0 + s * (y1 - y0);
    pts.push(new Vector2(bodyRadiusAtY(y), y));
  }
  const geo = new LatheGeometry(pts, radial);
  geo.scale(1.0, 1.0, BODY_RZ_RATIO);
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  return geo;
}

function makeHairTuft(low) {
  // Exact SVG path #mascot-hair extruded smoothly with rounded bevel and contoured over crown dome.
  const pts = [
    [413, 239], [423, 207, 469, 193, 491, 173],
    [517, 149, 513, 110, 553, 99],
    [598, 87, 641, 112, 663, 151],
    [678, 177, 674, 191, 661, 189],
    [641, 179, 620, 178, 603, 191],
    [572, 216, 559, 250, 519, 261],
    [480, 273, 435, 262, 413, 239],
  ];
  const shape = new Shape();
  shape.moveTo(to3X(pts[0][0]), to3Y(pts[0][1]));
  for (let i = 1; i < pts.length; i++) {
    const [c1x, c1y, c2x, c2y, x, y] = pts[i];
    shape.bezierCurveTo(to3X(c1x), to3Y(c1y), to3X(c2x), to3Y(c2y), to3X(x), to3Y(y));
  }
  const geo = new ExtrudeGeometry(shape, {
    depth: 0.16,
    bevelEnabled: true,
    bevelSegments: low ? 2 : 3,
    steps: 1,
    bevelSize: 0.038,
    bevelThickness: 0.085,
    curveSegments: low ? 6 : 10,
  });
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i) - 0.08;
    // Wrap tuft backward over scalp curvature so forehead swoop sits flush on skull while peak rises freely.
    const zCurve = -0.35 * x * x + (y < 1.80 ? (1.80 - y) * 0.45 : -(y - 1.80) * 0.22);
    pos.setZ(i, z + zCurve + 0.02);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  return geo;
}

function makeCapsuleLimb(low, length, radius) {
  const pts = [];
  const shaftSteps = low ? 4 : 6;
  const capSteps = low ? 4 : 6;
  const shaftLen = Math.max(0.04, length - radius);
  for (let i = 0; i <= shaftSteps; i++) {
    const u = i / shaftSteps;
    const r = i === 0 ? radius * 0.80 : radius * (0.94 + 0.06 * Math.sin(u * Math.PI));
    pts.push(new Vector2(r, -u * shaftLen));
  }
  for (let j = 1; j <= capSteps; j++) {
    const a = (j / capSteps) * (Math.PI / 2);
    pts.push(new Vector2(Math.max(0.001, radius * Math.cos(a)), -(shaftLen + radius * Math.sin(a))));
  }
  const geo = new LatheGeometry(pts, low ? 10 : 16);
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  return geo;
}

function makeFoot(low) {
  // SVG feet: wide cushioned pillows under belly (~110px wide, ~95px tall -> r=0.162, h=0.138)
  const geo = new SphereGeometry(0.168, low ? 10 : 16, low ? 8 : 12);
  geo.scale(1.06, 0.78, 1.24);
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  return geo;
}

function makeHeadband(low) {
  // Exact SVG arch centerline between inner (r=199..252) and outer paths, peaking high above hair.
  const curve = new CatmullRomCurve3([
    new Vector3(to3X(349.5), to3Y(302), 0),
    new Vector3(to3X(349.5), to3Y(258), 0),
    new Vector3(to3X(368), to3Y(162), 0),
    new Vector3(to3X(446), to3Y(84), 0),
    new Vector3(0, to3Y(60.5), 0),
    new Vector3(to3X(704), to3Y(84), 0),
    new Vector3(to3X(782), to3Y(162), 0),
    new Vector3(to3X(800.5), to3Y(258), 0),
    new Vector3(to3X(800.5), to3Y(302), 0),
  ]);
  const segs = low ? 18 : 28;
  const radSegs = low ? 8 : 12;
  const geo = new TubeGeometry(curve, segs, 0.080, radSegs, false);
  const pos = geo.attributes.position;
  const center = new Vector3();
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    const u = Math.min(1, Math.floor(i / (radSegs + 1)) / segs);
    curve.getPointAt(u, center);
    v.fromBufferAttribute(pos, i).sub(center);
    // Broad flat headband strap profile (slimmer horizontally, plush depth front-to-back)
    v.x *= 0.96;
    v.y *= 0.96;
    v.z *= 1.85;
    pos.setXYZ(i, center.x + v.x, center.y + v.y, center.z + v.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  return geo;
}

function makeRoundedBoxShape(w, h, r) {
  const s = new Shape();
  const hw = w / 2;
  const hh = h / 2;
  const cr = Math.min(r, hw, hh);
  s.moveTo(-hw + cr, -hh);
  s.lineTo(hw - cr, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + cr);
  s.lineTo(hw, hh - cr);
  s.quadraticCurveTo(hw, hh, hw - cr, hh);
  s.lineTo(-hw + cr, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - cr);
  s.lineTo(-hw, -hh + cr);
  s.quadraticCurveTo(-hw, -hh, -hw + cr, -hh);
  return s;
}

function makeEllipseShape(rx, ry) {
  const s = new Shape();
  s.absellipse(0, 0, rx, ry, 0, Math.PI * 2, false, 0);
  return s;
}

function buildEarcup(side, low, mats) {
  // side: -1 left, +1 right — mirrors SVG #left-cup tall stadium shells, slider collars & oval pads.
  const cup = new Group();
  cup.name = `Cápsula ${side}`;
  cup.position.set(side * Math.abs(to3X(350)), to3Y(378), 0.0);

  // Slider block connecting headband arch to earcup (SVG rect w=54, h=73, rx=15 centered at sx=350, sy=272.5)
  const yokeShape = makeRoundedBoxShape(54 * SVG_SCALE, 73 * SVG_SCALE, 15 * SVG_SCALE);
  const yokeGeo = new ExtrudeGeometry(yokeShape, {
    depth: 0.24, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.012, bevelThickness: 0.015, curveSegments: low ? 4 : 6,
  });
  yokeGeo.center();
  yokeGeo.deleteAttribute('uv');
  const yoke = new Mesh(yokeGeo, mats.graphite);
  yoke.position.set(0, to3Y(272.5) - to3Y(378), 0);
  cup.add(yoke);

  // Inner plush ear cushion pressed snugly onto cheek
  const cushionGeo = new SphereGeometry(1, low ? 10 : 16, low ? 8 : 12);
  cushionGeo.scale(0.145, 0.305, 0.23);
  cushionGeo.deleteAttribute('uv');
  const cushion = new Mesh(cushionGeo, mats.cushion);
  cushion.name = `Almofada ${side}`;
  cushion.position.set(-side * 0.015, 0, 0);
  cup.add(cushion);

  // Tall vertical stadium earcup shell (SVG rect x=275..387, y=284..472, w=112, h=188, rx=56)
  const shellShape = makeRoundedBoxShape(112 * SVG_SCALE, 188 * SVG_SCALE, 56 * SVG_SCALE);
  const shellGeo = new ExtrudeGeometry(shellShape, {
    depth: 0.22, bevelEnabled: true, bevelSegments: low ? 1 : 2, steps: 1, bevelSize: 0.018, bevelThickness: 0.032, curveSegments: low ? 6 : 10,
  });
  shellGeo.center();
  shellGeo.deleteAttribute('uv');
  const shell = new Mesh(shellGeo, mats.graphite);
  shell.position.set(side * (to3X(331) - to3X(350)), 0, 0);
  cup.add(shell);

  // Tall recessed outer stadium pad disc on outside edge (SVG ellipse rx=40, ry=77 at sx=316)
  const padShape = makeEllipseShape(40 * SVG_SCALE, 77 * SVG_SCALE);
  const padGeo = new ExtrudeGeometry(padShape, {
    depth: 0.27, bevelEnabled: true, bevelSegments: 1, steps: 1, bevelSize: 0.012, bevelThickness: 0.022, curveSegments: low ? 6 : 10,
  });
  padGeo.center();
  padGeo.deleteAttribute('uv');
  const pad = new Mesh(padGeo, mats.cushion);
  pad.position.set(side * (to3X(312) - to3X(350)), 0, 0);
  cup.add(pad);

  return cup;
}

function addBlinkMorph(geo, pivotY = 0) {
  const pos = geo.attributes.position;
  const target = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    target[i * 3] = x;
    target[i * 3 + 1] = pivotY + (y - pivotY) * 0.07;
    target[i * 3 + 2] = z;
  }
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = [new Float32BufferAttribute(target, 3)];
}

const MOUTH_CY = to3Y(445);

function makeSmilingMouth(low) {
  // Exact SVG clipPath #mouth2 mapped symmetrically around x = 0, Y = MOUTH_CY.
  const shape = new Shape();
  shape.moveTo(to3X(524), to3Y(420) - MOUTH_CY);
  shape.quadraticCurveTo(to3X(522), to3Y(407) - MOUTH_CY, to3X(536), to3Y(409) - MOUTH_CY);
  shape.quadraticCurveTo(to3X(575), to3Y(420) - MOUTH_CY, to3X(614), to3Y(409) - MOUTH_CY);
  shape.quadraticCurveTo(to3X(628), to3Y(407) - MOUTH_CY, to3X(626), to3Y(420) - MOUTH_CY);
  shape.bezierCurveTo(to3X(621), to3Y(456) - MOUTH_CY, to3X(601), to3Y(482) - MOUTH_CY, 0, to3Y(482) - MOUTH_CY);
  shape.bezierCurveTo(to3X(549), to3Y(482) - MOUTH_CY, to3X(529), to3Y(456) - MOUTH_CY, to3X(524), to3Y(420) - MOUTH_CY);

  const geo = new ExtrudeGeometry(shape, {
    depth: 0.014,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.005,
    bevelThickness: 0.004,
    curveSegments: low ? 8 : 12,
  });

  const pos = geo.attributes.position;
  const talkTarget = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i) - 0.007;
    const zSkin = bodySurfaceZ(x, MOUTH_CY + y);
    pos.setZ(i, zSkin + z * 0.7 + 0.004);

    const openY = y < 0 ? y * 1.40 - 0.018 : y * 1.12 + 0.01;
    const zOpen = bodySurfaceZ(x * 0.96, MOUTH_CY + openY);
    talkTarget[i * 3] = x * 0.96;
    talkTarget[i * 3 + 1] = openY;
    talkTarget[i * 3 + 2] = zOpen + z * 0.7 + 0.005;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  geo.morphTargetsRelative = false;
  geo.morphAttributes.position = [new Float32BufferAttribute(talkTarget, 3)];
  return geo;
}

function makeClippedTongue(low) {
  // Exact SVG intersection of ellipse(575, 470, 42, 29) inside #mouth2 lower contour!
  // At dx = ±36.8 (sx = 538.2 & 611.8), tongue top dome meets lower #mouth2 curve (~sy = 456.4).
  const shape = new Shape();
  shape.moveTo(to3X(538.2), to3Y(456.4) - MOUTH_CY);
  shape.bezierCurveTo(
    to3X(551), to3Y(441.5) - MOUTH_CY,
    to3X(599), to3Y(441.5) - MOUTH_CY,
    to3X(611.8), to3Y(456.4) - MOUTH_CY,
  );
  shape.bezierCurveTo(
    to3X(602.5), to3Y(472.5) - MOUTH_CY,
    to3X(590), to3Y(481.2) - MOUTH_CY,
    0, to3Y(481.2) - MOUTH_CY,
  );
  shape.bezierCurveTo(
    to3X(560), to3Y(481.2) - MOUTH_CY,
    to3X(547.5), to3Y(472.5) - MOUTH_CY,
    to3X(538.2), to3Y(456.4) - MOUTH_CY,
  );

  const geo = new ExtrudeGeometry(shape, {
    depth: 0.012,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.004,
    bevelThickness: 0.004,
    curveSegments: low ? 6 : 10,
  });
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i) - 0.006;
    const zSkin = bodySurfaceZ(x, MOUTH_CY + y);
    pos.setZ(i, zSkin + z * 0.65 + 0.010);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.deleteAttribute('uv');
  return geo;
}

function buildAnimations() {
  const specs = {
    Idle: { h: 0.018, roll: 0.025, yaw: 0.03 },
    Blink: { h: 0.0, roll: 0.0, yaw: 0.0 },
    HeadBob: { h: 0.042, roll: 0.075, yaw: 0.03 },
    Talk: { h: 0.036, roll: 0.05, yaw: 0.04 },
    Listening: { h: 0.014, roll: 0.095, yaw: 0.025 },
    Dance: { h: 0.11, roll: 0.17, yaw: 0.08 },
    Thinking: { h: 0.018, roll: 0.065, yaw: 0.11 },
    Celebrate: { h: 0.20, roll: 0.12, yaw: 0.07 },
    Confused: { h: 0.026, roll: 0.075, yaw: 0.15 },
    Sleep: { h: 0.007, roll: -0.04, yaw: 0.035 },
  };
  const times = [0, 0.4, 0.8, 1.2, 1.6];
  const clips = [];
  for (const [name, { h, roll, yaw }] of Object.entries(specs)) {
    const posValues = [];
    const rotValues = [];
    for (const t of times) {
      const phase = Math.PI * 2 * (t / 1.6);
      posValues.push(0, h * ((1 - Math.cos(phase)) * 0.5), 0);
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), roll * Math.sin(phase));
      const qy = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw * Math.sin(phase));
      q.multiply(qy);
      rotValues.push(q.x, q.y, q.z, q.w);
    }
    clips.push(new AnimationClip(name, 1.6, [
      new VectorKeyframeTrack('Wavi.position', times, posValues),
      new QuaternionKeyframeTrack('Wavi.quaternion', times, rotValues),
    ]));
  }
  return clips;
}

function buildWaviScene(low) {
  const mats = createMaterials();
  const root = new Group();
  root.name = 'Wavi';

  const body = new Mesh(makeBody(low), mats.lime);
  body.name = 'Corpo';
  root.add(body);

  const tuft = new Mesh(makeHairTuft(low), mats.tuft);
  tuft.name = 'Tufo';
  root.add(tuft);

  // Arms matching SVG angles (left hanging down-left from ~360,498; right waving up-right from ~796,458)
  const armL = new Mesh(makeCapsuleLimb(low, 0.36, 0.142), mats.lime);
  armL.name = 'Braço esquerdo';
  armL.position.set(to3X(370), to3Y(502), 0.02);
  armL.rotation.set(0.06, 0, -0.96);
  root.add(armL);

  const armR = new Mesh(makeCapsuleLimb(low, 0.44, 0.140), mats.lime);
  armR.name = 'Braço direito';
  armR.position.set(to3X(795), to3Y(460), -0.02);
  armR.rotation.set(-0.04, 0, 2.24);
  root.add(armR);

  // Feet matching SVG spacing (~466 and ~684, bottoms resting flush at Y = 0.23)
  const footL = new Mesh(makeFoot(low), mats.lime);
  footL.name = 'Pé esquerdo';
  footL.position.set(to3X(466), to3Y(680), 0.04);
  footL.rotation.set(0, -0.18, -0.06);
  root.add(footL);

  const footR = new Mesh(makeFoot(low), mats.lime);
  footR.name = 'Pé direito';
  footR.position.set(to3X(684), to3Y(680), 0.04);
  footR.rotation.set(0, 0.18, 0.06);
  root.add(footR);

  // Symmetrical stadium-capsule headphones
  const headband = new Mesh(makeHeadband(low), mats.graphite);
  headband.name = 'Arco dos fones';
  root.add(headband);
  root.add(buildEarcup(-1, low, mats));
  root.add(buildEarcup(1, low, mats));

  // Eyes mapped to SVG cx=502,648 cy=351 rx=30 ry=53 + rotated -22deg catchlights at 493,639 cy=326
  const eyeX = Math.abs(to3X(502));
  const eyeY = to3Y(351);
  const eyeZ = bodySurfaceZ(eyeX, eyeY) - 0.014;
  const eyeGeoL = new SphereGeometry(1, low ? 14 : 20, low ? 10 : 16);
  eyeGeoL.scale(30 * SVG_SCALE, 53 * SVG_SCALE, 0.045);
  addBlinkMorph(eyeGeoL);
  const eyeL = new Mesh(eyeGeoL, mats.eye);
  eyeL.name = 'Eye L';
  eyeL.position.set(-eyeX, eyeY, eyeZ);
  eyeL.rotation.set(-0.08, -0.22, 0);
  eyeL.morphTargetDictionary = { Blink: 0 };
  eyeL.morphTargetInfluences = [0];
  root.add(eyeL);

  const eyeR = new Mesh(eyeGeoL.clone(), mats.eye);
  eyeR.name = 'Eye R';
  eyeR.position.set(eyeX, eyeY, eyeZ);
  eyeR.rotation.set(-0.08, 0.22, 0);
  eyeR.morphTargetDictionary = { Blink: 0 };
  eyeR.morphTargetInfluences = [0];
  root.add(eyeR);

  const glowGeo = new SphereGeometry(1, low ? 8 : 10, low ? 8 : 10);
  glowGeo.scale(9 * SVG_SCALE, 14 * SVG_SCALE, 0.014);
  const luzLY = to3Y(326);
  const luzL = new Mesh(glowGeo, mats.glow);
  luzL.name = 'Luz -1';
  luzL.position.set(to3X(493), luzLY, eyeZ + 0.036);
  luzL.rotation.set(-0.08, -0.22, 0.384); // 22 deg tilt matching SVG rotate(-22)
  root.add(luzL);

  const luzR = new Mesh(glowGeo.clone(), mats.glow);
  luzR.name = 'Luz 1';
  luzR.position.set(to3X(639), luzLY, eyeZ + 0.036);
  luzR.rotation.set(-0.08, 0.22, 0.384);
  root.add(luzR);

  // Conformal D-mouth + clipped coral tongue
  const mouth = new Mesh(makeSmilingMouth(low), mats.mouthBg);
  mouth.name = 'Mouth';
  mouth.position.set(0, MOUTH_CY, 0);
  mouth.morphTargetDictionary = { Talk: 0 };
  mouth.morphTargetInfluences = [0];
  root.add(mouth);

  const tongue = new Mesh(makeClippedTongue(low), mats.tongue);
  tongue.name = 'Língua';
  tongue.position.set(0, MOUTH_CY, 0);
  root.add(tongue);

  return root;
}

function countTriangles(root) {
  let tris = 0;
  root.traverse(obj => {
    if (!(obj instanceof Mesh)) return;
    const g = obj.geometry;
    tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  });
  return Math.round(tris);
}

const exporter = new GLTFExporter();
const animations = buildAnimations();

for (const [low, filename] of [[false, 'wavi.glb'], [true, 'wavi-low.glb']]) {
  const scene = new Group();
  const wavi = buildWaviScene(low);
  scene.add(wavi);
  const tris = countTriangles(wavi);
  const glb = await exporter.parseAsync(scene, { binary: true, animations });
  const outPath = resolve('public/models', filename);
  const buf = Buffer.from(glb);
  writeFileSync(outPath, buf);
  console.log(`${filename}: ${buf.length} bytes, ${tris} triangles`);
}
