import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { defaultAvatars, fallbackIcons, referenceIcons } from './ui-assets';

// Navigation SVGs captured from the approved QoderWake CN reference on 2026-10-10.
const workspaceIcons: Record<string, string> = {
  "workspace-board": "<svg viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17 2H20C20.5523 2 21 2.44772 21 3V21C21 21.5523 20.5523 22 20 22H4C3.44772 22 3 21.5523 3 21V3C3 2.44772 3.44772 2 4 2H7V0H9V2H15V0H17V2ZM17 4V6H15V4H9V6H7V4H5V20H19V4H17ZM7 8H17V10H7V8ZM7 12H17V14H7V12Z\"></path></svg>",
  "bulb": "<svg viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M9.97308 18H11V13H13V18H14.0269C14.1589 16.7984 14.7721 15.8065 15.7676 14.7226C15.8797 14.6006 16.5988 13.8564 16.6841 13.7501C17.5318 12.6931 18 11.385 18 10C18 6.68629 15.3137 4 12 4C8.68629 4 6 6.68629 6 10C6 11.3843 6.46774 12.6917 7.31462 13.7484C7.40004 13.855 8.12081 14.6012 8.23154 14.7218C9.22766 15.8064 9.84103 16.7984 9.97308 18ZM10 20V21H14V20H10ZM5.75395 14.9992C4.65645 13.6297 4 11.8915 4 10C4 5.58172 7.58172 2 12 2C16.4183 2 20 5.58172 20 10C20 11.8925 19.3428 13.6315 18.2443 15.0014C17.624 15.7748 16 17 16 18.5V21C16 22.1046 15.1046 23 14 23H10C8.89543 23 8 22.1046 8 21V18.5C8 17 6.37458 15.7736 5.75395 14.9992Z\"></path></svg>",
  "workspace-users": "<svg viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12 14V16C8.68629 16 6 18.6863 6 22H4C4 17.5817 7.58172 14 12 14ZM12 13C8.685 13 6 10.315 6 7C6 3.685 8.685 1 12 1C15.315 1 18 3.685 18 7C18 10.315 15.315 13 12 13ZM12 11C14.21 11 16 9.21 16 7C16 4.79 14.21 3 12 3C9.79 3 8 4.79 8 7C8 9.21 9.79 11 12 11ZM14.5946 18.8115C14.5327 18.5511 14.5 18.2794 14.5 18C14.5 17.7207 14.5327 17.449 14.5945 17.1886L13.6029 16.6161L14.6029 14.884L15.5952 15.4569C15.9883 15.0851 16.4676 14.8034 17 14.6449V13.5H19V14.6449C19.5324 14.8034 20.0116 15.0851 20.4047 15.4569L21.3971 14.8839L22.3972 16.616L21.4055 17.1885C21.4673 17.449 21.5 17.7207 21.5 18C21.5 18.2793 21.4673 18.551 21.4055 18.8114L22.3972 19.3839L21.3972 21.116L20.4048 20.543C20.0117 20.9149 19.5325 21.1966 19.0001 21.355V22.5H17.0001V21.3551C16.4677 21.1967 15.9884 20.915 15.5953 20.5431L14.603 21.1161L13.6029 19.384L14.5946 18.8115ZM18 19.5C18.8284 19.5 19.5 18.8284 19.5 18C19.5 17.1716 18.8284 16.5 18 16.5C17.1716 16.5 16.5 17.1716 16.5 18C16.5 18.8284 17.1716 19.5 18 19.5Z\"></path></svg>",
  "sparkles": "<svg viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M17.0007 1.20825 18.3195 3.68108 20.7923 4.99992 18.3195 6.31876 17.0007 8.79159 15.6818 6.31876 13.209 4.99992 15.6818 3.68108 17.0007 1.20825ZM10.6673 9.33325 15.6673 11.9999 10.6673 14.6666 8.00065 19.6666 5.33398 14.6666.333984 11.9999 5.33398 9.33325 8.00065 4.33325 10.6673 9.33325ZM11.4173 11.9999 9.18905 10.8115 8.00065 8.58325 6.81224 10.8115 4.58398 11.9999 6.81224 13.1883 8.00065 15.4166 9.18905 13.1883 11.4173 11.9999ZM19.6673 16.3333 18.0007 13.2083 16.334 16.3333 13.209 17.9999 16.334 19.6666 18.0007 22.7916 19.6673 19.6666 22.7923 17.9999 19.6673 16.3333Z\"></path></svg>",
  "panel": "<svg viewBox=\"0 0 24 24\" width=\"1em\" height=\"1em\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M21 3C21.5523 3 22 3.44772 22 4V20C22 20.5523 21.5523 21 21 21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM7 5H4V19H7V5ZM20 5H9V19H20V5Z\"></path></svg>",
  "at": "<svg width=\"19\" height=\"19\" viewBox=\"0 0 19 19\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><g clip-path=\"url(#clip0_7674_85809)\"><path d=\"M10.5548 0.552239L10.7618 0.572868L10.7706 0.573806L10.8048 0.579432L10.8136 0.581307C10.816 0.581721 10.819 0.581823 10.8214 0.582245L10.8615 0.587871L10.8898 0.597248C11.8371 0.792677 12.5007 1.58725 12.521 2.49135L12.5561 2.52511L12.4594 3.05583L12.4575 3.06614L12.4565 3.07271L12.4545 3.08021L12.4526 3.08959V3.09334C12.3639 3.51049 12.3338 4.23966 12.5805 4.94149C12.8093 5.59199 13.2734 6.23166 14.2469 6.6415C15.3252 7.04248 16.3403 7.49918 17.0843 8.04895C17.7918 8.57184 18.6084 9.46084 18.4234 10.696V10.7185L18.4127 10.7785C18.1778 12.0561 17.0614 12.6423 16.1916 12.907C15.2972 13.1792 14.1819 13.2752 13.0269 13.298C11.9645 13.363 11.2998 13.8116 10.8527 14.3482C10.3718 14.9255 10.1392 15.6183 10.0732 16.0398L10.0723 16.0501L10.0713 16.0595L10.0674 16.0783V16.0811L10.0342 16.2545C9.84131 17.3047 8.82271 18.0129 7.73296 17.8767H7.7017L7.63919 17.8655C6.51422 17.6751 5.76283 16.6452 5.96114 15.5653L5.99337 15.3909L5.99435 15.3862L5.9963 15.3741L5.99923 15.3609L6.00119 15.3516C6.0896 14.9342 6.11872 14.2063 5.87226 13.5053C5.64397 12.856 5.18144 12.2172 4.21179 11.8071C3.13133 11.4056 2.11384 10.9486 1.36849 10.3978C0.645439 9.86348 -0.194454 8.94599 0.0401179 7.66825L0.0948156 7.43664C0.414141 6.31858 1.44574 5.78791 2.26123 5.53973C3.15559 5.26755 4.27071 5.17069 5.42589 5.14778C6.48827 5.08282 7.1531 4.63419 7.60012 4.09759C8.08098 3.52013 8.31273 2.82737 8.37858 2.40602L8.38054 2.39664L8.38151 2.38914L8.38249 2.38258L8.38444 2.37227L8.38542 2.36476L8.41863 2.18942C8.60245 1.19396 9.52905 0.503409 10.5548 0.552239ZM10.5421 1.94562C10.2125 1.9003 9.90216 2.11507 9.8437 2.43228L9.81244 2.59543L9.81342 2.59637L9.81147 2.60575L9.81049 2.60762L9.81147 2.60856C9.71617 3.22248 9.40175 4.15971 8.73021 4.96587C8.06048 5.76981 7.03515 6.443 5.51672 6.53554L5.48547 6.53741C4.35354 6.55856 3.39637 6.65238 2.69882 6.86466C1.99239 7.07965 1.55721 7.41455 1.46616 7.91017C1.37545 8.40546 1.66472 8.86236 2.25147 9.29605C2.83119 9.72444 3.69702 10.1274 4.75291 10.5188L4.76854 10.5244L4.78319 10.53C6.17717 11.1156 6.90064 12.0854 7.24361 13.0608C7.58642 14.0359 7.54782 15.0166 7.41942 15.6254V15.631L7.38719 15.8063C7.32782 16.1303 7.55291 16.4402 7.89021 16.4974C8.22755 16.5544 8.54961 16.3375 8.6091 16.0136L8.6423 15.8382C8.7376 15.2243 9.05112 14.287 9.72258 13.4809C10.3923 12.6769 11.4175 12.0028 12.9361 11.9103L12.9517 11.9094H12.9683C14.1 11.8882 15.0566 11.7943 15.754 11.5821C16.4604 11.3671 16.8956 11.0322 16.9866 10.5366C17.0775 10.0411 16.7884 9.58363 16.2013 9.14978C15.6215 8.72133 14.755 8.31945 13.6989 7.92799L13.6843 7.92236L13.6696 7.9158C12.2759 7.33033 11.5522 6.3612 11.2092 5.38595C10.8677 4.41471 10.9033 3.43718 11.0304 2.82797L11.0656 2.6395C11.1248 2.31579 10.8997 2.00665 10.5626 1.94937L10.5509 1.9475L10.5421 1.94562Z\" fill=\"currentColor\"/><path d=\"M0.964839 7.69463C1.14838 7.35377 1.58551 7.22018 1.94062 7.39632L1.94273 7.39804C1.94453 7.39893 1.94727 7.40029 1.95092 7.40209C1.95883 7.40598 1.97166 7.41198 1.98775 7.41984C2.01993 7.43556 2.06849 7.45925 2.131 7.48929C2.2564 7.54954 2.43977 7.63641 2.66954 7.74256C3.13019 7.95538 3.77605 8.24467 4.5156 8.54885C6.01033 9.16364 7.83091 9.81604 9.27444 10.0525C10.6833 10.2832 12.5347 10.2567 14.0711 10.1643C14.8313 10.1186 15.5 10.0571 15.9786 10.0078C16.2175 9.98314 16.409 9.96143 16.5397 9.94592C16.605 9.93817 16.6556 9.93252 16.6892 9.92831C16.7059 9.92621 16.7187 9.92446 16.727 9.9234C16.7309 9.9229 16.7337 9.92201 16.7356 9.92177L16.7386 9.92153C17.1344 9.8697 17.4994 10.1358 17.5537 10.5159C17.608 10.8961 17.3307 11.2463 16.9346 11.2984L16.9337 11.2985C16.9329 11.2986 16.9312 11.2996 16.9298 11.2997C16.9273 11.3001 16.9237 11.3 16.9191 11.3006C16.9094 11.3018 16.8948 11.3036 16.8765 11.3059C16.8398 11.3105 16.7861 11.3171 16.7174 11.3252C16.5799 11.3415 16.3812 11.3643 16.134 11.3898C15.6392 11.4408 14.9479 11.5042 14.1613 11.5515C12.6037 11.6452 10.6131 11.6814 9.03079 11.4222C7.40869 11.1565 5.45633 10.4476 3.94538 9.82618C3.18237 9.51235 2.51713 9.21466 2.0423 8.99529C1.8047 8.88552 1.61372 8.79468 1.48226 8.73151C1.41666 8.69998 1.36569 8.67505 1.33082 8.65801C1.31352 8.64956 1.30011 8.64315 1.29091 8.63862C1.2863 8.63635 1.28212 8.63417 1.27963 8.63294L1.27761 8.63216L1.27655 8.6313L1.27558 8.63138C0.920515 8.45518 0.781356 8.03554 0.964839 7.69463Z\" fill=\"currentColor\"/></g><defs><clipPath id=\"clip0_7674_85809\"><rect width=\"18.45\" height=\"18.45\" fill=\"white\"/></clipPath></defs></svg>",
  "swap": "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.7\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M4 7h16l-4-4M20 17H4l4 4\"/></svg>"
};

export function Icon({ name, small = false }: { name: string; small?: boolean }) {
  const size = small ? 16 : 20;
  const svg = (workspaceIcons[name] ?? referenceIcons[name])?.replace('<svg ', `<svg class="${small ? 'small-icon' : 'icon'}" aria-hidden="true" `).replace(/width="[^"]+"/, `width="${size}"`).replace(/height="[^"]+"/, `height="${size}"`)
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
