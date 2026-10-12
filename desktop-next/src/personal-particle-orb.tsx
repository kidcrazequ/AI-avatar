import { useEffect, useRef } from 'react';

// Fixed samples keep the sphere coherent as it turns, instead of flickering noise.
const particles = Array.from({ length: 1400 }, (_, index) => {
  const y = 1 - 2 * (index + .5) / 1400;
  const radius = Math.sqrt(1 - y * y);
  const angle = index * Math.PI * (3 - Math.sqrt(5));
  return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius, phase: index * .71 };
});

export function PersonalParticleOrb() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const context = canvas.getContext('2d');
    if (!context) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = true, frame = 0, previous = 0, phase = 0, width = 0, height = 0;
    const draw = () => {
      const dark = document.documentElement.dataset.theme === 'dark';
      const radius = Math.min(width, height) * .39;
      const cx = width / 2, cy = height / 2;
      context.clearRect(0, 0, width, height);
      const halo = context.createRadialGradient(cx, cy, radius * .5, cx, cy, radius * 1.28);
      halo.addColorStop(0, 'rgba(69, 174, 189, 0)');
      halo.addColorStop(.64, 'rgba(83, 203, 202, .08)');
      halo.addColorStop(1, 'rgba(69, 174, 189, 0)');
      context.fillStyle = halo;
      context.fillRect(0, 0, width, height);
      const turn = phase * .18, tilt = .27 + Math.sin(phase * .22) * .12;
      const ct = Math.cos(turn), st = Math.sin(turn), ca = Math.cos(tilt), sa = Math.sin(tilt);
      const project = (x: number, y: number, z: number) => {
        const rx = x * ct + z * st, rz = z * ct - x * st;
        return { x: rx, y: y * ca - rz * sa, z: y * sa + rz * ca };
      };
      for (const particle of particles) {
        const point = project(particle.x, particle.y, particle.z);
        const breathe = 1 + .035 * Math.sin(phase * .8 + particle.y * 4);
        const depth = (point.z + 1) / 2;
        const edge = Math.pow(1 - Math.abs(point.z), 5);
        const shimmer = .87 + .13 * Math.sin(phase * 1.2 + particle.phase);
        const alpha = (.13 + .48 * depth + .24 * edge) * shimmer;
        const blue = .5 + .5 * Math.sin(particle.y * 3 + particle.x * 2 + phase * .17);
        context.fillStyle = dark
          ? `rgba(${Math.round(84 + blue * 37)},${Math.round(215 - blue * 49)},${Math.round(179 + blue * 70)},${alpha})`
          : `rgba(${Math.round(34 + blue * 42)},${Math.round(142 - blue * 42)},${Math.round(121 + blue * 54)},${alpha})`;
        context.beginPath();
        context.arc(cx + point.x * radius * breathe, cy + point.y * radius * breathe, .42 + depth * .49 + edge * .28, 0, Math.PI * 2);
        context.fill();
      }
      // Two ribbons of sparks give the cloud a readable direction of travel.
      for (let ribbon = 0; ribbon < 2; ribbon++) {
        for (let index = 0; index < 160; index++) {
          const angle = index / 160 * Math.PI * 2 + phase * .1 + ribbon * Math.PI;
          const latitude = Math.sin(angle * 2 + ribbon * 1.8) * .38;
          const ring = Math.sqrt(1 - latitude * latitude);
          const point = project(Math.cos(angle) * ring, latitude, Math.sin(angle) * ring);
          const color = ribbon ? dark ? '140, 169, 255' : '68, 101, 182' : dark ? '159, 235, 216' : '39, 132, 116';
          context.fillStyle = `rgba(${color},${.18 + (point.z + 1) * .26})`;
          context.beginPath();
          context.arc(cx + point.x * radius * 1.04, cy + point.y * radius * 1.04, .85, 0, Math.PI * 2);
          context.fill();
        }
      }
    };
    const animate = (now: number) => {
      frame = 0;
      if (previous && now - previous < 1000 / 30) { frame = requestAnimationFrame(animate); return; }
      if (previous) phase += Math.min((now - previous) / 1000, .1);
      previous = now;
      draw();
      frame = requestAnimationFrame(animate);
    };
    const sync = () => {
      cancelAnimationFrame(frame); frame = 0; previous = 0;
      draw();
      if (visible && !document.hidden && !motion.matches) frame = requestAnimationFrame(animate);
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width; height = bounds.height;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      sync();
    };
    const size = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? false; sync(); });
    const theme = new MutationObserver(sync);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    size.observe(canvas); intersection.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    motion.addEventListener('change', sync);
    resize();
    return () => {
      cancelAnimationFrame(frame); size.disconnect(); intersection.disconnect(); theme.disconnect();
      document.removeEventListener('visibilitychange', sync); motion.removeEventListener('change', sync);
    };
  }, []);
  return <canvas ref={ref} className="personal-avatar-art" aria-hidden="true" data-ued-node="recruitment.particle-orb" />;
}
