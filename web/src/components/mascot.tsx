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

export type MascotState = 'idle' | 'wave' | 'thinking' | 'typing' | 'sleeping' | 'listening' | 'success' | 'error' | 'held' | 'land';
const CLIP: Record<MascotState, string> = {
  idle: 'Idle', wave: 'Wave', thinking: 'Thinking', typing: 'Typing', sleeping: 'Sleeping', listening: 'Listening', success: 'Success', error: 'Error',
  held: 'Held', land: 'Land',
};
const ONCE = new Set<MascotState>(['wave', 'success', 'error', 'land']);
import { MASCOT_POSTER } from './mascot-icon';
export { MASCOT_POSTER };

let model: Promise<GLTF> | null = null;
const load = () => (model ??= new GLTFLoader().loadAsync('/brand/satim-assistant.glb'));

/** Extra states built from the model's rest pose (no new geometry): attentive tilt, a happy hop that prints
 *  the receipt with both arms up, and a head shake with squinting eyes. */
function generated(root: THREE.Object3D): THREE.AnimationClip[] {
  // the loader sanitises node names ("Payment terminal" -> "Payment_terminal"), as its own clips do
  const node = (n: string) => root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n))!;
  const body = node('Payment terminal'), receipt = node('Receipt'), la = node('Left arm'), ra = node('Right arm'), le = node('Left eye'), re = node('Right eye'), feet = node('Feet');
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
    // idle fidgets and reactions to a poke
    new THREE.AnimationClip('LookAround', 2.6, [
      rot(body, [0, 0.5, 1.1, 1.7, 2.6], [[0, 0, 0], [0, 0.38, 0.04], [0, 0.38, 0.04], [0, -0.38, -0.04], [0, 0, 0]]),
      pos(le, [0, 0.5, 1.1, 1.7, 2.6], [0, 0.01, 0.01, 0.01, 0]), pos(re, [0, 0.5, 1.1, 1.7, 2.6], [0, 0.01, 0.01, 0.01, 0]),
    ]),
    new THREE.AnimationClip('Hop', 1.1, [
      pos(body, [0, 0.18, 0.4, 0.58, 0.8, 1.1], [0, 0.22, 0, 0.12, 0, 0]),
      scl(body, [0, 0.12, 0.4, 0.5, 0.8, 1.1], [1, 0.92, 1.06, 0.95, 1.02, 1]),
      rot(la, [0, 0.2, 0.6, 1.1], [[0, 0, 0], [0, 0, -0.6], [0, 0, -0.3], [0, 0, 0]]),
      rot(ra, [0, 0.2, 0.6, 1.1], [[0, 0, 0], [0, 0, 0.6], [0, 0, 0.3], [0, 0, 0]]),
    ]),
    new THREE.AnimationClip('Spin', 1.3, [
      rot(body, [0, 0.32, 0.65, 0.97, 1.3], [[0, 0, 0], [0, Math.PI / 2, 0], [0, Math.PI, 0], [0, (3 * Math.PI) / 2, 0], [0, 2 * Math.PI, 0]]),
      pos(body, [0, 0.65, 1.3], [0, 0.12, 0]),
    ]),
    // sits down on its feet, rests (one blink), gets back up
    new THREE.AnimationClip('Sit', 4.4, [
      pos(body, [0, 0.55, 0.7, 3.3, 3.75, 4.0, 4.4], [0, -0.34, -0.31, -0.31, 0.06, 0, 0]),
      scl(body, [0, 0.55, 0.72, 0.9, 3.3, 3.6, 3.8, 4.4], [1, 0.94, 0.9, 1, 1, 0.96, 1.04, 1]),
      rot(body, [0, 0.6, 3.3, 3.8, 4.4], [[0, 0, 0], [-0.1, 0, 0], [-0.1, 0, 0], [0.06, 0, 0], [0, 0, 0]]),
      scl(feet, [0, 0.6, 3.3, 3.8, 4.4], [1, 0.75, 0.75, 1, 1]),
      rot(la, [0, 0.6, 3.3, 3.8], [[0, 0, 0], [0, 0, -0.35], [0, 0, -0.35], [0, 0, 0]]),
      rot(ra, [0, 0.6, 3.3, 3.8], [[0, 0, 0], [0, 0, 0.35], [0, 0, 0.35], [0, 0, 0]]),
      scl(le, [0, 1.9, 2.0, 2.12, 4.4], [1, 1, 0.15, 1, 1]), scl(re, [0, 1.9, 2.0, 2.12, 4.4], [1, 1, 0.15, 1, 1]),
    ]),
    // picked up: dangles, legs and arms swinging, eyes wide
    new THREE.AnimationClip('Held', 1.2, [
      rot(body, [0, 0.3, 0.6, 0.9, 1.2], [[0, 0, 0.12], [0.05, 0, 0], [0, 0, -0.12], [0.05, 0, 0], [0, 0, 0.12]]),
      rot(feet, [0, 0.3, 0.6, 0.9, 1.2], [[0.25, 0, 0.1], [0.1, 0, 0], [0.25, 0, -0.1], [0.1, 0, 0], [0.25, 0, 0.1]]),
      rot(la, [0, 0.3, 0.6, 0.9, 1.2], [[0, 0, -0.9], [0, 0, -0.4], [0, 0, -0.9], [0, 0, -0.4], [0, 0, -0.9]]),
      rot(ra, [0, 0.3, 0.6, 0.9, 1.2], [[0, 0, 0.4], [0, 0, 0.9], [0, 0, 0.4], [0, 0, 0.9], [0, 0, 0.4]]),
      scl(le, [0, 1.2], [1.25, 1.25]), scl(re, [0, 1.2], [1.25, 1.25]),
    ]),
    // dropped: lands with a squash, bounces once, settles
    new THREE.AnimationClip('Land', 1.0, [
      pos(body, [0, 0.12, 0.3, 0.45, 0.6, 1.0], [0.22, 0, 0.08, 0, 0, 0]),
      scl(body, [0, 0.12, 0.22, 0.4, 0.55, 0.75, 1.0], [1.06, 0.74, 1.12, 0.94, 1.03, 1, 1]),
      scl(feet, [0, 0.12, 0.3, 0.6], [1, 0.7, 1.05, 1]),
      rot(la, [0, 0.15, 0.5, 1.0], [[0, 0, -0.8], [0, 0, -0.2], [0, 0, -0.5], [0, 0, 0]]),
      rot(ra, [0, 0.15, 0.5, 1.0], [[0, 0, 0.8], [0, 0, 0.2], [0, 0, 0.5], [0, 0, 0]]),
      scl(le, [0, 0.12, 0.6, 1.0], [1.2, 0.3, 1, 1]), scl(re, [0, 0.12, 0.6, 1.0], [1.2, 0.3, 1, 1]),
    ]),
    new THREE.AnimationClip('Poke', 0.9, [
      scl(body, [0, 0.08, 0.25, 0.45, 0.65, 0.9], [1, 0.82, 1.1, 0.96, 1.02, 1]),
      scl(le, [0, 0.08, 0.5, 0.9], [1, 0.2, 0.2, 1]), scl(re, [0, 0.08, 0.5, 0.9], [1, 0.2, 0.2, 1]),
      rot(body, [0, 0.1, 0.35, 0.9], [[0, 0, 0], [-0.12, 0, 0.08], [0.05, 0, -0.04], [0, 0, 0]]),
    ]),
  ];
}

const FIDGETS = ['LookAround', 'Hop', 'Spin', 'Wave', 'Sit', 'Sit'], POKES = ['Poke', 'Hop', 'Spin', 'Sit'];
const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];

/** interactive: poking it (click / tap) makes it react, hovering makes it wave. It always follows the pointer
 *  with its body and eyes, and fidgets now and then while idle (not with reduced motion). */
export function Mascot({ state = 'idle', rest = 'idle', size = 48, className = '', interactive = false }: { state?: MascotState; rest?: MascotState; size?: number; className?: string; interactive?: boolean }) {
  const box = useRef<HTMLSpanElement>(null);
  const api = useRef<{ play: (s: MascotState) => void; react: (clip: string) => void } | null>(null);
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
    // pointer following: parts the clips may not animate are reset to their rest pose each frame, then a
    // small smoothed offset toward the pointer is added on top of the clip
    let parts: { body: THREE.Object3D; eyes: THREE.Object3D[]; rest: { o: THREE.Object3D; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }[] } | null = null;
    const look = { x: 0, y: 0, tx: 0, ty: 0 };
    const offset = new THREE.Quaternion(), euler = new THREE.Euler();
    const follow = (dt: number) => {
      if (!parts) return;
      const asleep = current === actions.get('Sleeping') || current === actions.get('Held') || current === actions.get('Sit');
      const k = 1 - Math.exp(-dt * 6);
      look.x += ((asleep ? 0 : look.tx) - look.x) * k; look.y += ((asleep ? 0 : look.ty) - look.y) * k;
      parts.body.quaternion.multiply(offset.setFromEuler(euler.set(-look.y * 0.18, look.x * 0.32, 0)));
      parts.eyes.forEach((eye) => { eye.position.x += look.x * 0.05; eye.position.y += look.y * 0.035; });
    };
    const resetParts = () => {
      if (!parts) return;
      for (const r of parts.rest) { r.o.position.copy(r.p); r.o.quaternion.copy(r.q); r.o.scale.copy(r.s); }
    };

    const draw = () => { if (!disposed) renderer.render(scene, camera); };
    const tick = () => {
      frame = 0;
      if (!visible || disposed) return;
      timer.update();
      const dt = Math.min(timer.getDelta(), 0.1);
      resetParts();
      mixer?.update(dt);
      follow(dt);
      draw();
      frame = requestAnimationFrame(tick);
    };
    const playClip = (name: string, once: boolean) => {
      const next = actions.get(name) ?? actions.get('Idle');
      if (!next || !mixer) return;
      next.reset().setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = once;
      if (current && current !== next) next.crossFadeFrom(current, 0.35, false);
      next.play(); current = next;
      if (still) { mixer.setTime(next.getClip().duration * 0.5); draw(); }
    };
    const play = (s: MascotState) => playClip(CLIP[s], ONCE.has(s));
    // after a one-shot (a reaction, a fidget, wave/success/error): back to what the chat is doing
    const settle = () => { const w = want.current; play(ONCE.has(w.state) ? w.rest : w.state); };
    const react = (clip: string) => { if (!still) playClip(clip, true); };
    api.current = { play, react };

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
      mixer.addEventListener('finished', settle);
      const body = root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName('Payment terminal'))!;
      const eyes = ['Left eye', 'Right eye'].map((n) => root.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(n))!);
      const moving: THREE.Object3D[] = []; root.traverse((o) => { if (o !== root) moving.push(o); });
      parts = { body, eyes, rest: moving.map((o) => ({ o, p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() })) };
      el.appendChild(renderer.domElement);
      setReady(true);
      play(want.current.state);
      if (!still) frame = requestAnimationFrame(tick); else draw();
    }).catch((e) => { console.warn('[mascot] model unavailable, showing the still image:', e instanceof Error ? e.message : e); });

    // the pointer anywhere on the page: where the mascot looks (-1..1 around its own centre)
    const onPointer = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect(), span = Math.max(240, Math.min(innerWidth, innerHeight) * 0.6);
      look.tx = THREE.MathUtils.clamp((ev.clientX - (r.left + r.width / 2)) / span, -1, 1);
      look.ty = THREE.MathUtils.clamp((ev.clientY - (r.top + r.height / 2)) / span, -1, 1);
    };
    if (!still) addEventListener('pointermove', onPointer, { passive: true });
    // now and then, when idle and on screen, a fidget (look around, hop, spin, wave)
    let fidget = 0;
    const schedule = () => { fidget = window.setTimeout(() => {
      if (visible && mixer && want.current.state === 'idle' && current === actions.get('Idle')) playClip(pick(FIDGETS), true);
      schedule();
    }, 6000 + Math.random() * 6000); };
    if (!still) schedule();

    const resize = () => { const s = el.clientWidth || size; renderer.setSize(s, s, false); camera.aspect = 1; camera.updateProjectionMatrix(); draw(); };
    resize();
    const ro = new ResizeObserver(resize); ro.observe(el);
    // render only when visible on screen and the tab is shown
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting && !document.hidden; if (visible && !frame && !still && mixer) { timer.update(); frame = requestAnimationFrame(tick); } });
    io.observe(el);
    const onVis = () => { visible = !document.hidden; if (visible && !frame && !still && mixer) { timer.update(); frame = requestAnimationFrame(tick); } };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true; cancelAnimationFrame(frame); clearTimeout(fidget); removeEventListener('pointermove', onPointer);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', onVis);
      mixer?.stopAllAction(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); api.current = null;
    };
  }, [size]);

  useEffect(() => { api.current?.play(state); }, [state]);

  return (
    <span ref={box} className={`mascot${ready ? ' is-ready' : ''}${interactive ? ' is-interactive' : ''} ${className}`} style={{ width: size, height: size }} aria-hidden data-state={state}
      onPointerDown={interactive ? () => api.current?.react(pick(POKES)) : undefined}
      onPointerEnter={interactive ? () => { if (want.current.state === 'idle') api.current?.react('Wave'); } : undefined}>
      {!ready && <Image src={MASCOT_POSTER} alt="" width={size} height={size} priority={size > 80} />}
    </span>
  );
}
