'use client';
// The SATIM assistant mascot (public/brand/satim-assistant.glb), rendered with three.js.
// States: the model's own clips (Idle, Wave, Thinking, Typing, Sleeping) plus three generated here from
// the same nodes (Listening, Success, Error). One-shot states play once, then settle on `rest`.
// Decorative (aria-hidden): the chat announces what happens. Reduced motion: one still pose, no loop.
// Without WebGL, or before the model loads, the still image (public/brand/assistant-mascot.png) is shown.
import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type MascotState = 'idle' | 'wave' | 'thinking' | 'typing' | 'sleeping' | 'listening' | 'success' | 'error';
const CLIP: Record<MascotState, string> = {
  idle: 'Idle', wave: 'Wave', thinking: 'Thinking', typing: 'Typing', sleeping: 'Sleeping', listening: 'Listening', success: 'Success', error: 'Error',
};
const ONCE = new Set<MascotState>(['wave', 'success', 'error']);
export const MASCOT_POSTER = '/brand/assistant-mascot.png';

let model: Promise<GLTF> | null = null;
const load = () => (model ??= new GLTFLoader().loadAsync('/brand/satim-assistant.glb'));

/** Extra states built from the model's rest pose (no new geometry): attentive tilt, a happy hop that prints
 *  the receipt with both arms up, and a head shake with squinting eyes. */
function generated(root: THREE.Object3D): THREE.AnimationClip[] {
  // the loader sanitises node names ("Payment terminal" -> "Payment_terminal"), as its own clips do
  const node = (n: string) => root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n))!;
  const body = node('Payment terminal'), receipt = node('Receipt'), la = node('Left arm'), ra = node('Right arm'), le = node('Left eye'), re = node('Right eye');
  const q = (o: THREE.Object3D, x: number, y: number, z: number) => o.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z))).toArray();
  const rot = (o: THREE.Object3D, times: number[], eulers: [number, number, number][]) =>
    new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`, times, eulers.flatMap(([x, y, z]) => q(o, x, y, z)));
  const pos = (o: THREE.Object3D, times: number[], dy: number[]) =>
    new THREE.VectorKeyframeTrack(`${o.name}.position`, times, dy.flatMap((d) => [o.position.x, o.position.y + d, o.position.z]));
  const scl = (o: THREE.Object3D, times: number[], sy: number[]) =>
    new THREE.VectorKeyframeTrack(`${o.name}.scale`, times, sy.flatMap((s) => [o.scale.x, o.scale.y * s, o.scale.z]));
  return [
    new THREE.AnimationClip('Listening', 2.4, [
      rot(body, [0, 1.2, 2.4], [[0.1, 0, 0.06], [0.14, 0, 0.1], [0.1, 0, 0.06]]),
      scl(le, [0, 1.2, 2.4], [1.12, 1.18, 1.12]), scl(re, [0, 1.2, 2.4], [1.12, 1.18, 1.12]),
    ]),
    new THREE.AnimationClip('Success', 1.4, [
      pos(body, [0, 0.25, 0.5, 0.8, 1.4], [0, 0.16, 0, 0.05, 0]),
      pos(receipt, [0, 0.5, 1.0, 1.4], [0, 0.22, 0.22, 0]),
      rot(la, [0, 0.35, 1.0, 1.4], [[0, 0, 0], [0, 0, -1.1], [0, 0, -1.1], [0, 0, 0]]),
      rot(ra, [0, 0.35, 1.0, 1.4], [[0, 0, 0], [0, 0, 1.1], [0, 0, 1.1], [0, 0, 0]]),
    ]),
    new THREE.AnimationClip('Error', 1.2, [
      rot(body, [0, 0.15, 0.35, 0.55, 0.75, 1.2], [[0, 0, 0], [0, 0.28, 0], [0, -0.28, 0], [0, 0.2, 0], [0, -0.12, 0], [0, 0, 0]]),
      scl(le, [0, 0.2, 1.0, 1.2], [1, 0.35, 0.35, 1]), scl(re, [0, 0.2, 1.0, 1.2], [1, 0.35, 0.35, 1]),
    ]),
  ];
}

export function Mascot({ state = 'idle', rest = 'idle', size = 48, className = '' }: { state?: MascotState; rest?: MascotState; size?: number; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const api = useRef<{ play: (s: MascotState) => void } | null>(null);
  const [ready, setReady] = useState(false);
  const want = useRef({ state, rest });
  useEffect(() => { want.current = { state, rest }; }, [state, rest]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' }); } catch { return; }   // no WebGL: the poster stays
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(2, 4, 5); scene.add(sun);
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    const timer = new THREE.Timer();
    let mixer: THREE.AnimationMixer | null = null, frame = 0, visible = true, disposed = false;
    const actions = new Map<string, THREE.AnimationAction>();
    let current: THREE.AnimationAction | null = null;

    const draw = () => { if (!disposed) renderer.render(scene, camera); };
    const tick = () => {
      frame = 0;
      if (!visible || disposed) return;
      timer.update();
      mixer?.update(Math.min(timer.getDelta(), 0.1));
      draw();
      frame = requestAnimationFrame(tick);
    };
    const play = (s: MascotState) => {
      const next = actions.get(CLIP[s]) ?? actions.get('Idle');
      if (!next || !mixer) return;
      next.reset().setLoop(ONCE.has(s) ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = ONCE.has(s);
      if (current && current !== next) next.crossFadeFrom(current, 0.35, false);
      next.play(); current = next;
      if (still) { mixer.setTime(next.getClip().duration * 0.5); draw(); }
    };
    api.current = { play };

    load().then((gltf) => {
      if (disposed) return;
      const root = gltf.scene.clone(true);
      scene.add(root);
      // frame the whole figure, a little margin around it
      const bounds = new THREE.Box3().setFromObject(root), centre = bounds.getCenter(new THREE.Vector3()), dim = bounds.getSize(new THREE.Vector3());
      const fit = Math.max(dim.y, dim.x) * 0.62 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      camera.position.set(centre.x, centre.y + dim.y * 0.04, centre.z + fit);
      camera.lookAt(centre);
      mixer = new THREE.AnimationMixer(root);
      for (const clip of [...gltf.animations, ...generated(root)]) actions.set(clip.name, mixer.clipAction(clip));
      mixer.addEventListener('finished', () => play(want.current.rest));
      el.appendChild(renderer.domElement);
      setReady(true);
      play(want.current.state);
      if (!still) frame = requestAnimationFrame(tick); else draw();
    }).catch((e) => { console.warn('[mascot] model unavailable, showing the still image:', e instanceof Error ? e.message : e); });

    const resize = () => { const s = el.clientWidth || size; renderer.setSize(s, s, false); camera.aspect = 1; camera.updateProjectionMatrix(); draw(); };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(el);
    // render only when visible on screen and the tab is shown
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting && !document.hidden; if (visible && !frame && !still && mixer) { timer.update(); frame = requestAnimationFrame(tick); } });
    io.observe(el);
    const onVis = () => { visible = !document.hidden; if (visible && !frame && !still && mixer) { timer.update(); frame = requestAnimationFrame(tick); } };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true; cancelAnimationFrame(frame); ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis);
      mixer?.stopAllAction(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); api.current = null;
    };
  }, [size]);

  useEffect(() => { api.current?.play(state); }, [state]);

  return (
    <span ref={box} className={`mascot${ready ? ' is-ready' : ''} ${className}`} style={{ width: size, height: size }} aria-hidden data-state={state}>
      {!ready && <Image src={MASCOT_POSTER} alt="" width={size} height={size} priority={size > 80} />}
    </span>
  );
}
