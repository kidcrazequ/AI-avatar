import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PersonalParticleOrb } from '../src/personal-particle-orb';

// Controlled clocks test lifecycle promises while Chromium renders the real canvas.
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0, reduced = false, hidden = false, visible = true;
let intersection: ((entries: IntersectionObserverEntry[]) => void) | undefined;
const motionListeners = new Set<() => void>();
window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
window.cancelAnimationFrame = id => { frames.delete(id); };
Object.defineProperty(document, 'hidden', { get: () => hidden });
window.matchMedia = (() => ({ get matches() { return reduced; }, addEventListener: (_: string, callback: () => void) => motionListeners.add(callback), removeEventListener: (_: string, callback: () => void) => motionListeners.delete(callback) })) as unknown as typeof matchMedia;
window.IntersectionObserver = class {
  constructor(callback: typeof intersection) { intersection = callback; }
  observe() { intersection?.([{ isIntersecting: visible }] as IntersectionObserverEntry[]); }
  disconnect() { intersection = undefined; }
} as unknown as typeof IntersectionObserver;
document.body.innerHTML = '<div id="root"></div><style>.personal-avatar-art{width:208.8px;height:187.2px;display:block}</style>';
const root = createRoot(document.getElementById('root')!);
flushSync(() => root.render(<PersonalParticleOrb />));
const advance = (time: number) => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(time)); };
const image = () => document.querySelector('canvas')!.toDataURL();
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };

(window as unknown as { verifyOrb(): Promise<string[]> }).verifyOrb = async () => {
  await new Promise(resolve => setTimeout(resolve, 40));
  const checks: string[] = [];
  const first = image();
  advance(1000); advance(1040); advance(1080);
  assert(first !== image(), 'Particle positions must change across active frames');
  checks.push('Real canvas changes while animation is active');
  visible = false; intersection?.([{ isIntersecting: visible }] as IntersectionObserverEntry[]);
  assert(frames.size === 0, 'Offscreen cards must release animation frames');
  const offscreen = image(); advance(5000);
  assert(image() === offscreen, 'Offscreen canvas must stay idle');
  checks.push('Offscreen card cancels the animation and stays idle');
  visible = true; intersection?.([{ isIntersecting: visible }] as IntersectionObserverEntry[]);
  assert(frames.size === 1, 'Returning to the viewport must resume one loop');
  hidden = true; document.dispatchEvent(new Event('visibilitychange'));
  assert(frames.size === 0, 'Hidden document must not consume frames');
  hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  assert(frames.size === 1, 'Foreground must resume a single loop');
  checks.push('Background/foreground visibility pauses and resumes one loop');
  reduced = true; motionListeners.forEach(callback => callback());
  assert(frames.size === 0, 'Reduced motion must keep a still sphere');
  const still = image(); advance(10000);
  assert(still === image(), 'Reduced motion must not advance the sphere');
  document.documentElement.dataset.theme = 'dark';
  await new Promise(resolve => setTimeout(resolve, 0));
  const dark = image();
  assert(dark !== still && frames.size === 0, 'Theme changes must repaint even when motion is reduced');
  document.documentElement.dataset.theme = 'light';
  await new Promise(resolve => setTimeout(resolve, 0));
  assert(image() !== dark && frames.size === 0, 'Light theme must use its visible particle palette without starting animation');
  checks.push('Deep and light palettes repaint while reduced motion remains still');
  reduced = false; motionListeners.forEach(callback => callback());
  assert(frames.size === 1, 'Changing motion preference back must resume');
  checks.push('Reduced motion retains a still canvas and responds to preference changes');
  assert(document.querySelector('canvas')!.getAttribute('aria-hidden') === 'true', 'Decoration must not alter the creation button accessible name');
  checks.push('Decoration is hidden from the accessibility tree');
  flushSync(() => root.unmount());
  assert(frames.size === 0 && motionListeners.size === 0 && !intersection, 'Unmount must release frames and listeners');
  checks.push('Unmount releases the animation, observers, and preference listeners');
  return checks;
};
