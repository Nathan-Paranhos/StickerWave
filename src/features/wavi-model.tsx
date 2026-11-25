import { useEffect, useRef } from 'react';
import {
  ACESFilmicToneMapping, AnimationMixer, CanvasTexture, Color,
  DirectionalLight, ExtrudeGeometry, Group, HemisphereLight, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PerspectiveCamera, PlaneGeometry, PMREMGenerator, RingGeometry,
  Scene, Shape, SRGBColorSpace, WebGLRenderer, type AnimationAction,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export type WaviState = 'Idle' | 'Listening' | 'Thinking' | 'Talk' | 'Celebrate' | 'Confused' | 'Dance';

type RestPart = {
  node: Object3D;
  px: number; py: number; pz: number;
  rx: number; ry: number; rz: number;
  sx: number; sy: number; sz: number;
};

type RigParts = Record<string, RestPart>;

function makeShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(64, 64, 10, 64, 64, 60);
    gradient.addColorStop(0, 'rgba(28, 44, 20, 0.28)');
    gradient.addColorStop(0.55, 'rgba(28, 44, 20, 0.11)');
    gradient.addColorStop(1, 'rgba(28, 44, 20, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function createSparkleMesh(material: MeshStandardMaterial) {
  // Exact 4-point star proportions matching #star in wavi.svg
  const shape = new Shape();
  shape.moveTo(0, 0.145);
  shape.quadraticCurveTo(0.036, 0.036, 0.140, 0);
  shape.quadraticCurveTo(0.036, -0.036, 0, -0.145);
  shape.quadraticCurveTo(-0.036, -0.036, -0.140, 0);
  shape.quadraticCurveTo(-0.036, 0.036, 0, 0.145);
  const geometry = new ExtrudeGeometry(shape, { depth: 0.030, bevelEnabled: true, bevelThickness: 0.020, bevelSize: 0.018, bevelSegments: 3 });
  geometry.center();
  return new Mesh(geometry, material);
}

function createMusicBadge(discMaterial: MeshStandardMaterial, noteMaterial: MeshStandardMaterial) {
  const group = new Group();
  const discShape = new Shape();
  discShape.absarc(0, 0, 0.172, 0, Math.PI * 2, false);
  const discGeo = new ExtrudeGeometry(discShape, {
    depth: 0.036, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.018, bevelSegments: 3, curveSegments: 28,
  });
  discGeo.center();
  group.add(new Mesh(discGeo, discMaterial));

  // Exact SVG music note glyph centered inside purple circle (#music-note in wavi.svg)
  const s = 0.00292;
  const nx = (x: number) => (x - 914) * s;
  const ny = (y: number) => (130 - y) * s;
  const noteShape = new Shape();
  noteShape.moveTo(nx(911), ny(133));
  noteShape.lineTo(nx(918), ny(94));
  noteShape.quadraticCurveTo(nx(919), ny(90), nx(924), ny(93));
  noteShape.lineTo(nx(947), ny(102));
  noteShape.lineTo(nx(944), ny(116));
  noteShape.lineTo(nx(925), ny(109));
  noteShape.lineTo(nx(917), ny(145));
  noteShape.bezierCurveTo(nx(914), ny(157), nx(900), ny(160), nx(890), ny(152));
  noteShape.bezierCurveTo(nx(875), ny(140), nx(892), ny(122), nx(911), ny(133));
  const noteGeo = new ExtrudeGeometry(noteShape, { depth: 0.018, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.004, bevelSegments: 2, curveSegments: 10 });
  const noteMesh = new Mesh(noteGeo, noteMaterial);
  noteMesh.position.z = 0.022;
  group.add(noteMesh);
  return group;
}

function createStageProps(small: boolean) {
  const stage = new Group();
  const disposables: { dispose(): void }[] = [];

  const shadowTexture = makeShadowTexture();
  const shadowMat = new MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false });
  const shadowGeo = new PlaneGeometry(2.15, 2.15);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadow = new Mesh(shadowGeo, shadowMat);
  shadow.position.set(0, 0.23, 0.02);
  stage.add(shadow);

  const haloGeo = new RingGeometry(0.86, 0.99, 48);
  haloGeo.rotateX(-Math.PI / 2);
  const haloMat = new MeshBasicMaterial({ color: '#b7e842', transparent: true, opacity: 0, depthWrite: false });
  const halo = new Mesh(haloGeo, haloMat);
  halo.position.set(0, 0.24, 0.02);
  stage.add(halo);
  disposables.push(shadowTexture, shadowMat, shadowGeo, haloGeo, haloMat);

  let sparkle: Mesh | undefined;
  let badge: Group | undefined;
  if (!small) {
    const lavender = new MeshStandardMaterial({ color: '#c291ed', roughness: 0.42, metalness: 0.02, envMapIntensity: 0.42 });
    const noteInk = new MeshStandardMaterial({ color: '#35263e', roughness: 0.35, metalness: 0.04 });
    sparkle = createSparkleMesh(lavender);
    sparkle.position.set(-1.04, 1.49, 0.06);
    badge = createMusicBadge(lavender, noteInk);
    badge.position.set(0.99, 1.97, 0.04);
    stage.add(sparkle, badge);
    disposables.push(lavender, noteInk, sparkle.geometry);
    badge.traverse(item => { if (item instanceof Mesh) disposables.push(item.geometry); });
  }

  return {
    stage,
    shadow,
    halo,
    haloMat,
    sparkle,
    badge,
    dispose: () => disposables.forEach(item => item.dispose()),
  };
}

function polishMaterial(material: MeshStandardMaterial) {
  const base = material.name.replace(/\.\d+$/, '');
  if (base === 'Olhos') {
    material.color.set('#141612');
    material.roughness = 0.12;
    material.envMapIntensity = 1.5;
  } else if (base === 'Reflexos') {
    material.emissive = new Color('#ffffff');
    material.emissiveIntensity = 0.85;
    material.roughness = 0.10;
  } else if (base === 'Fones / grafite') {
    material.color.set('#343533');
    material.roughness = 0.42;
    material.metalness = 0.10;
    material.envMapIntensity = 0.65;
  } else if (base === 'Fones / almofada') {
    material.color.set('#292b28');
    material.roughness = 0.72;
    material.envMapIntensity = 0.40;
  } else if (base === 'Wavi / lima') {
    material.color.set('#b7e32c');
    material.roughness = 0.56;
    material.envMapIntensity = 0.28;
  } else if (base === 'Wavi / reflexo') {
    material.color.set('#cef448');
    material.roughness = 0.50;
    material.envMapIntensity = 0.32;
  } else if (base === 'Boca / fundo') {
    material.color.set('#361210');
    material.roughness = 0.82;
    material.envMapIntensity = 0.15;
  } else if (base === 'Língua') {
    material.color.set('#ea7875');
    material.roughness = 0.48;
    material.envMapIntensity = 0.30;
  }
}

function captureRig(root: Object3D) {
  const parts: RigParts = {};
  const lipModels: Mesh[] = [];
  const eyelids: Mesh[] = [];
  root.traverse(child => {
    if (child.name) {
      parts[child.name] = {
        node: child,
        px: child.position.x, py: child.position.y, pz: child.position.z,
        rx: child.rotation.x, ry: child.rotation.y, rz: child.rotation.z,
        sx: child.scale.x, sy: child.scale.y, sz: child.scale.z,
      };
    }
    if (!(child instanceof Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach(mat => { if (mat instanceof MeshStandardMaterial) polishMaterial(mat); });
    if (!child.morphTargetInfluences) return;
    if (child.morphTargetDictionary?.Talk !== undefined) lipModels.push(child);
    if (child.morphTargetDictionary?.Blink !== undefined) eyelids.push(child);
  });
  return { parts, lipModels, eyelids };
}

function animateRig(parts: RigParts, state: WaviState, t: number, level: number, bass: number, lookX: number, lookY: number, mouthOpen: number, blink: number) {
  const leftArm = parts['Braço esquerdo'];
  const rightArm = parts['Braço direito'];
  const tuft = parts['Tufo'];
  const tongue = parts['Língua'];
  const cupL = parts['Cápsula -1'];
  const cupR = parts['Cápsula 1'];

  const groove = state === 'Dance' || state === 'Celebrate' ? 1 : state === 'Talk' || state === 'Listening' ? 0.55 : 0.22;
  const speed = state === 'Celebrate' ? 7.5 : state === 'Dance' ? 6.2 : 2.2;

  if (rightArm) {
    const wave = state === 'Celebrate'
      ? 0.22 + Math.sin(t * speed) * 0.28
      : state === 'Thinking'
        ? -1.45 + Math.sin(t * 2.2) * 0.08
        : state === 'Confused'
          ? -0.95 + Math.sin(t * 3.0) * 0.14
          : Math.sin(t * speed) * (0.09 + groove * 0.16 + bass * 0.18);
    rightArm.node.rotation.z = rightArm.rz + wave;
    rightArm.node.rotation.x = rightArm.rx + Math.cos(t * speed * 0.5) * 0.08 * groove;
  }

  if (leftArm) {
    const sway = state === 'Celebrate'
      ? 0.55 - Math.sin(t * speed + 0.5) * 0.28
      : state === 'Confused'
        ? 0.22 + Math.cos(t * 3.2) * 0.12
        : Math.sin(t * speed + Math.PI * 0.75) * (0.06 + groove * 0.14 + bass * 0.14);
    leftArm.node.rotation.z = leftArm.rz + sway;
  }

  if (tuft) {
    tuft.node.rotation.z = tuft.rz + Math.sin(t * 3.1) * 0.045 - bass * 0.09;
    tuft.node.rotation.x = tuft.rx + Math.cos(t * 2.4) * 0.03;
  }

  if (tongue) {
    tongue.node.position.y = tongue.py - mouthOpen * 0.018;
    tongue.node.position.z = tongue.pz + mouthOpen * 0.008;
  }

  const cupPulse = 1 + bass * 0.09 + level * 0.03;
  for (const cup of [cupL, cupR]) {
    if (cup) cup.node.scale.set(cup.sx * cupPulse, cup.sy * cupPulse, cup.sz * cupPulse);
  }

  const eyeShiftX = lookX * 0.022;
  const eyeShiftY = lookY * 0.018;
  for (const name of ['Eye L', 'Eye R', 'Luz -1', 'Luz 1']) {
    const part = parts[name];
    if (!part) continue;
    part.node.position.x = part.px + eyeShiftX;
    part.node.position.y = part.py + eyeShiftY;
    if (name.startsWith('Luz')) {
      part.node.scale.y = part.sy * Math.max(0.05, 1 - blink * 0.96);
      part.node.visible = blink < 0.72;
    }
  }
}

export default function WaviModel({ small, state, level, bass, failed, interactive = true }: {
  small?: boolean; state: WaviState; level: number; bass: number; failed: () => void; interactive?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ state, level, bass, failed });
  latest.current = { state, level, bass, failed };

  useEffect(() => {
    const place = host.current;
    if (!place || matchMedia('(prefers-reduced-motion: reduce)').matches) { latest.current.failed(); return; }
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    } catch {
      latest.current.failed();
      return;
    }

    const low = Boolean(small || innerWidth < 700);
    renderer.setPixelRatio(Math.min(devicePixelRatio, small ? 1.5 : 2));
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.94;
    renderer.setClearColor(new Color('#eef2e5'), 0);
    renderer.domElement.setAttribute('aria-hidden', 'true');
    place.appendChild(renderer.domElement);

    const scene = new Scene();
    const pmrem = new PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envTarget = pmrem.fromScene(room, 0.04);
    scene.environment = envTarget.texture;
    scene.environmentIntensity = 0.34;
    room.dispose();

    const stageProps = createStageProps(Boolean(small));
    scene.add(stageProps.stage);

    const frame = new Group();
    scene.add(frame);

    const hemi = new HemisphereLight('#efffa0', '#698a0c', 0.68);
    // Warm sunlight highlight from upper-right (matches cx=62% cy=27% radial gradient in wavi.svg)
    const key = new DirectionalLight('#f9ffe6', 1.55);
    key.position.set(2.4, 3.8, 3.6);
    const rim = new DirectionalLight('#d6f275', 0.65);
    rim.position.set(-2.8, 2.2, -2.5);
    const fill = new DirectionalLight('#d6ef8a', 0.42);
    fill.position.set(-2.2, 0.5, 2.8);
    scene.add(hemi, key, rim, fill);

    const camera = new PerspectiveCamera(32, 1, 0.01, 25);
    camera.position.set(0.0, small ? 1.26 : 1.32, small ? 4.45 : 4.88);
    camera.lookAt(0, small ? 1.22 : 1.27, 0);

    const resize = () => {
      const { clientWidth, clientHeight } = place;
      if (!clientWidth || !clientHeight) return;
      camera.aspect = clientWidth / clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(clientWidth, clientHeight, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(place);
    resize();

    let visible = true;
    let disposed = false;
    let request = 0;
    let mixer: AnimationMixer | undefined;
    let model: Object3D | undefined;
    let current: AnimationAction | undefined;
    const actions = new Map<string, AnimationAction>();
    let rig: ReturnType<typeof captureRig> | undefined;
    let last = 0, slow = 0, smoothed = 0, bassValue = 0;

    // Symmetrical front pose matching public/images/wavi.svg, with full 360 drag interaction
    const restingYaw = 0;
    let dragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragMoved = 0;
    let targetYaw = restingYaw;
    let targetPitch = 0;
    let yaw = restingYaw;
    let pitch = 0;
    let lookX = 0;
    let lookY = 0;
    let lastInteraction = 0;
    let burstUntil = 0;

    const canvasEl = renderer.domElement;
    const onPointerDown = (event: PointerEvent) => {
      if (!interactive || event.button !== 0) return;
      dragging = true;
      dragMoved = 0;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      lastInteraction = performance.now();
      canvasEl.setPointerCapture(event.pointerId);
      canvasEl.style.cursor = 'grabbing';
    };
    const onPointerMove = (event: PointerEvent) => {
      const rect = canvasEl.getBoundingClientRect();
      if (rect.width && rect.height) {
        lookX = Math.max(-1, Math.min(1, ((event.clientX - rect.left) / rect.width) * 2 - 1));
        lookY = Math.max(-1, Math.min(1, -(((event.clientY - rect.top) / rect.height) * 2 - 1)));
      }
      if (!dragging) return;
      const dx = event.clientX - dragStartX;
      const dy = event.clientY - dragStartY;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragMoved += Math.hypot(dx, dy);
      targetYaw += dx * 0.011;
      targetPitch = Math.max(-0.38, Math.min(0.45, targetPitch + dy * 0.008));
      lastInteraction = performance.now();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      canvasEl.style.cursor = interactive ? 'grab' : '';
      if (canvasEl.hasPointerCapture(event.pointerId)) canvasEl.releasePointerCapture(event.pointerId);
      if (dragMoved < 7) burstUntil = performance.now() + 1850;
    };
    const onPointerLeave = () => {
      if (!dragging) { lookX = 0; lookY = 0; }
    };
    if (interactive) {
      canvasEl.style.cursor = 'grab';
      canvasEl.style.touchAction = 'none';
      canvasEl.addEventListener('pointerdown', onPointerDown);
      canvasEl.addEventListener('pointermove', onPointerMove);
      canvasEl.addEventListener('pointerup', onPointerUp);
      canvasEl.addEventListener('pointercancel', onPointerUp);
      canvasEl.addEventListener('pointerleave', onPointerLeave);
    }

    const disposeModel = (item: Object3D) => item.traverse(child => {
      if (!(child instanceof Mesh)) return;
      child.geometry.dispose();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.forEach(material => material.dispose());
    });
    const disconnect = () => latest.current.failed();
    canvasEl.addEventListener('webglcontextlost', disconnect, { once: true });

    const loader = new GLTFLoader();
    loader.load(low ? '/models/wavi-low.glb' : '/models/wavi.glb', result => {
      if (disposed) { disposeModel(result.scene); return; }
      model = result.scene;
      rig = captureRig(model);
      frame.add(model);
      mixer = new AnimationMixer(model);
      result.animations.forEach(clip => actions.set(clip.name, mixer!.clipAction(clip)));
      schedule();
    }, undefined, () => { if (!disposed) disconnect(); });

    function tick(now: number) {
      request = 0;
      if (!visible || document.hidden || disposed) return;
      const dt = last ? Math.min(0.12, (now - last) / 1000) : 0.016;
      last = now;
      if (dt > 0.095) slow++; else slow = Math.max(0, slow - 2);
      if (slow > 55) { disconnect(); return; }

      const { state, level, bass } = latest.current;
      const bursting = now < burstUntil;
      const activeState: WaviState = bursting ? 'Celebrate' : state;
      const targetAction = actions.get(activeState) ?? actions.get('Idle');
      if (targetAction && current !== targetAction) {
        current?.fadeOut(0.2);
        targetAction.reset().fadeIn(0.2).play();
        current = targetAction;
      }
      mixer?.update(dt);

      smoothed += 0.28 * (level - smoothed);
      bassValue += 0.24 * (bass - bassValue);

      if (!dragging && now - lastInteraction > 2800) {
        targetYaw += (restingYaw - targetYaw) * Math.min(1, dt * 1.4);
        targetPitch += (0 - targetPitch) * Math.min(1, dt * 1.6);
      }
      const damp = 1 - Math.exp(-10 * dt);
      yaw += (targetYaw - yaw) * damp;
      pitch += (targetPitch - pitch) * damp;

      const t = now / 1000;
      const burstBounce = bursting ? Math.abs(Math.sin(t * 7)) * 0.12 : 0;
      const hop = bassValue * 0.1 + burstBounce;
      frame.rotation.y = yaw + lookX * 0.12;
      frame.rotation.x = pitch - lookY * 0.08;
      frame.rotation.z = bassValue * 0.1;
      frame.position.y = hop;
      const stretch = 1 + hop * 0.28;
      const squash = 1 / Math.sqrt(stretch);
      frame.scale.set(squash, stretch, squash);

      if (rig) {
        const mouthOpen = Math.min(1, smoothed + (bursting ? 0.55 : 0));
        const blink = Math.max(0, 1 - Math.abs((now % 4600) - 3750) / 95);
        animateRig(rig.parts, activeState, t, smoothed, bassValue, lookX, lookY, mouthOpen, blink);
        for (const mesh of rig.lipModels) mesh.morphTargetInfluences![mesh.morphTargetDictionary!.Talk] = mouthOpen;
        for (const mesh of rig.eyelids) mesh.morphTargetInfluences![mesh.morphTargetDictionary!.Blink] = blink;
      }

      const shadowScale = Math.max(0.78, 1 - hop * 0.9);
      stageProps.shadow.scale.set(shadowScale, 1, shadowScale);
      const energy = Math.min(1, smoothed * 0.9 + bassValue * 0.7 + (bursting ? 0.6 : 0));
      stageProps.haloMat.opacity = energy * 0.42;
      const haloScale = 0.92 + energy * 0.22;
      stageProps.halo.scale.set(haloScale, 1, haloScale);

      if (stageProps.sparkle) {
        stageProps.sparkle.position.y = 1.49 + Math.sin(t * 1.9) * 0.045 + bassValue * 0.07;
        stageProps.sparkle.rotation.y = Math.sin(t * 1.1) * 0.30 + yaw * 0.25;
        stageProps.sparkle.rotation.z = Math.cos(t * 1.4) * 0.10;
        const s = 1 + bassValue * 0.18;
        stageProps.sparkle.scale.set(s, s, s);
      }
      if (stageProps.badge) {
        stageProps.badge.position.y = 1.97 + Math.cos(t * 1.7 + 0.8) * 0.045 + bassValue * 0.08;
        stageProps.badge.rotation.y = Math.sin(t * 1.3 + 1.2) * 0.25 + yaw * 0.25;
        stageProps.badge.rotation.z = Math.sin(t * 2.1) * 0.06;
        const b = 1 + bassValue * 0.16;
        stageProps.badge.scale.set(b, b, b);
      }

      renderer.render(scene, camera);
      schedule();
    }

    function schedule() {
      if (!request && model && visible && !document.hidden && !disposed) request = requestAnimationFrame(tick);
    }
    const hide = () => {
      if (document.hidden) { cancelAnimationFrame(request); request = 0; last = 0; }
      else schedule();
    };
    document.addEventListener('visibilitychange', hide);
    const intersection = new IntersectionObserver(items => {
      visible = items.some(item => item.isIntersecting);
      if (!visible) { cancelAnimationFrame(request); request = 0; last = 0; } else schedule();
    });
    intersection.observe(place);

    return () => {
      disposed = true;
      cancelAnimationFrame(request);
      document.removeEventListener('visibilitychange', hide);
      intersection.disconnect();
      observer.disconnect();
      if (interactive) {
        canvasEl.removeEventListener('pointerdown', onPointerDown);
        canvasEl.removeEventListener('pointermove', onPointerMove);
        canvasEl.removeEventListener('pointerup', onPointerUp);
        canvasEl.removeEventListener('pointercancel', onPointerUp);
        canvasEl.removeEventListener('pointerleave', onPointerLeave);
      }
      mixer?.stopAllAction();
      if (model) disposeModel(model);
      stageProps.dispose();
      envTarget.dispose();
      pmrem.dispose();
      canvasEl.removeEventListener('webglcontextlost', disconnect);
      renderer.dispose();
      canvasEl.remove();
    };
  }, [small, interactive]);

  return <div className={`wavi-model ${small ? 'wavi-small' : ''}`} ref={host} aria-hidden="true" />;
}
