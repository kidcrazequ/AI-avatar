import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopAPI, RuntimeStatus } from '../shared/contracts';
import './style.css';

declare global { interface Window { soulDesktop: DesktopAPI } }

function App() {
  const [status, setStatus] = useState<RuntimeStatus>();
  const [error, setError] = useState<string>();
  useEffect(() => { window.soulDesktop.readStatus().then(setStatus).catch(cause => setError(String(cause))); }, []);
  return <div className="shell" data-runtime-ready={Boolean(status)} data-ued-node="soul-v3.shell">
    <nav aria-label="主导航" data-ued-node="soul-v3.global-nav">
      <img className="brand" src="./assets/soul-avatar.png" alt="Soul" />
      <div className="nav-active" aria-current="page"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1"/></svg>专家</div>
      <span className="nav-bottom">S</span>
    </nav>
    <main data-ued-node="soul-v3.management">
      <header><h1>专家管理</h1><span className="badge">开发验证版</span></header>
      <p className="description">Soul 的专业能力，从每一位专家开始。</p>
      {error && <p role="alert" data-runtime-error>{error}</p>}
      {!status && !error && <p>正在读取专家包…</p>}
      {status && <>
        <div className="tabs"><span>专家包 <small>{status.experts.length}</small></span></div>
        <div className="grid" data-ued-node="soul-v3.management.cards">
          {status.experts.map(expert => <article key={expert.id} data-expert-id={expert.id}>
            <div className="card-top"><div className="avatar">{expert.name.slice(0, 1)}</div><div><h2>{expert.name}</h2><p>{expert.domain}</p></div></div>
            <p className="card-description">{expert.description}</p>
            <footer><span>{expert.knowledgeFiles} 份知识文件</span><span>随安装包提供</span></footer>
          </article>)}
        </div>
        <section className="runtime" aria-label="运行环境验证">
          <div>Soul {status.version} · {status.platform} / {status.arch}</div>
          <div>{status.checks.filter(check => check.ok).length} / {status.checks.length} 项运行检查通过 · {status.resources.files} 个资源文件</div>
          {status.checks.filter(check => !check.ok).map(check => <p className="error" key={check.name}>{check.name}：{String(check.detail)}</p>)}
        </section>
      </>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
