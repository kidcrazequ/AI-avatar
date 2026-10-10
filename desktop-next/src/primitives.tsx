import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { defaultAvatars, fallbackIcons, referenceIcons } from './ui-assets';

export function Icon({ name, small = false }: { name: string; small?: boolean }) {
  const size = small ? 16 : 20;
  const svg = referenceIcons[name]?.replace('<svg ', `<svg class="${small ? 'small-icon' : 'icon'}" aria-hidden="true" `).replace(/width="\d+"/, `width="${size}"`).replace(/height="\d+"/, `height="${size}"`)
    ?? `<svg class="${small ? 'small-icon' : 'icon'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${fallbackIcons[name] ?? fallbackIcons.file}</svg>`;
  return <span className="svg-icon" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export function Avatar({ name, avatar }: { name: string; avatar: string }) {
  const svg = defaultAvatars[avatar.replace('default:', '')];
  return <span className="avatar" role="img" aria-label={name}>
    {avatar.startsWith('data:image/png;base64,') ? <img src={avatar} alt="" /> : svg ? <span className="svg-avatar" dangerouslySetInnerHTML={{ __html: svg }} /> : name.slice(0, 1)}
  </span>;
}

export function Modal({ title, className = '', onClose, children, footer }: { title: string; className?: string; onClose(): void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    dialog.showModal();
    return () => { dialog.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className={`dialog ${className}`} aria-label={title} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }}>
    <span id={titleId} className="sr-only">{title}</span>
    <button className="icon-button dialog-close" aria-label={`关闭${title}`} onClick={onClose}><Icon name="close" small /></button>
    {children}
    {footer && <div className="dialog-footer">{footer}</div>}
  </dialog>, document.body);
}

export function Menu({ anchor, children, onClose }: { anchor: HTMLElement; children: ReactNode; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const rect = anchor.getBoundingClientRect();
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { onClose(); anchor.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    ref.current?.querySelector('button')?.focus();
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [anchor, onClose]);
  return createPortal(<div ref={ref} className="menu" role="menu" style={{ left: Math.max(72, Math.min(rect.left, window.innerWidth - 200)), top: Math.min(rect.bottom + 4, window.innerHeight - 250) }} onClick={onClose}>{children}</div>, document.body);
}

export function Section({ title, extra, node, children }: { title: string; extra?: ReactNode; node: string; children: ReactNode }) {
  return <section className="home-section" data-ued-node={node}><div className="section-header"><h2>{title}</h2>{extra}<button className="icon-button" aria-label={`折叠${title}`} aria-expanded="true" onClick={event => {
    const section = event.currentTarget.closest('section')!;
    const collapsed = section.classList.toggle('collapsed');
    event.currentTarget.setAttribute('aria-expanded', String(!collapsed));
    event.currentTarget.setAttribute('aria-label', `${collapsed ? '展开' : '折叠'}${title}`);
  }}><span className="collapse-icon"><Icon name="collapse" small /></span></button></div>{children}</section>;
}
