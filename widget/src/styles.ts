/**
 * Soul Embed widget 样式。
 *
 * 设计取舍：
 *   - 全部以字符串形式注入到 Shadow DOM 内的 <style>，与父页样式完全隔离
 *   - 不引入任何外部字体（系统字体栈足够），不引入 tailwind / styled-components
 *   - :host 决定外层定位：固定右下角（z-index 大数，避免被遮挡）
 *   - 移动端（<= 480px）退化为全屏 sheet 样式
 *   - 流式光标用 CSS 动画，不靠 JS setInterval
 *
 * @author zhi.qu
 * @date 2026-05-09
 */

export const STYLES = `
:host {
  all: initial;
  --soul-bg: #ffffff;
  --soul-fg: #1f2937;
  --soul-muted: #6b7280;
  --soul-border: #e5e7eb;
  --soul-bubble-user-bg: #2563eb;
  --soul-bubble-user-fg: #ffffff;
  --soul-bubble-assistant-bg: #f3f4f6;
  --soul-bubble-assistant-fg: #111827;
  --soul-primary: #111827;
  --soul-primary-fg: #ffffff;
  --soul-error: #b91c1c;
  --soul-error-bg: #fef2f2;
  --soul-warn: #92400e;
  --soul-warn-bg: #fef3c7;

  position: fixed;
  bottom: 24px;
  right: 24px;
  width: 360px;
  height: 520px;
  z-index: 2147483000;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--soul-fg);
  contain: layout style;
}

* {
  box-sizing: border-box;
}

.root {
  width: 100%;
  height: 100%;
  background: var(--soul-bg);
  border: 1px solid var(--soul-border);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.12);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.header {
  flex: 0 0 auto;
  padding: 12px 16px;
  border-bottom: 1px solid var(--soul-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--soul-bg);
}

.header .title {
  font-weight: 600;
  font-size: 14px;
  color: var(--soul-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header .powered {
  font-size: 11px;
  color: var(--soul-muted);
}

.body {
  flex: 1 1 auto;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: #fafafa;
  scrollbar-width: thin;
}

.body::-webkit-scrollbar {
  width: 6px;
}

.body::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
  border-radius: 3px;
}

.greeting {
  align-self: flex-start;
  background: var(--soul-bubble-assistant-bg);
  color: var(--soul-bubble-assistant-fg);
  padding: 8px 12px;
  border-radius: 12px 12px 12px 4px;
  max-width: 80%;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble {
  max-width: 80%;
  padding: 8px 12px;
  border-radius: 12px;
  word-break: break-word;
  white-space: normal;
}

.bubble.user {
  align-self: flex-end;
  background: var(--soul-bubble-user-bg);
  color: var(--soul-bubble-user-fg);
  border-radius: 12px 12px 4px 12px;
  white-space: pre-wrap;
}

.bubble.assistant {
  align-self: flex-start;
  background: var(--soul-bubble-assistant-bg);
  color: var(--soul-bubble-assistant-fg);
  border-radius: 12px 12px 12px 4px;
}

.bubble.assistant p {
  margin: 0 0 8px 0;
}

.bubble.assistant p:last-child {
  margin-bottom: 0;
}

.bubble.assistant a {
  color: var(--soul-bubble-user-bg);
  text-decoration: underline;
}

.bubble.assistant code {
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12.5px;
}

.bubble.assistant pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 10px 12px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 6px 0;
  font-size: 12.5px;
}

.bubble.assistant pre code {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: inherit;
}

.cursor {
  display: inline-block;
  width: 8px;
  height: 14px;
  background: currentColor;
  margin-left: 2px;
  vertical-align: -2px;
  animation: soul-blink 1s step-end infinite;
}

@keyframes soul-blink {
  50% { opacity: 0; }
}

.notice {
  align-self: stretch;
  text-align: center;
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 6px;
}

.notice.error {
  background: var(--soul-error-bg);
  color: var(--soul-error);
}

.notice.warn {
  background: var(--soul-warn-bg);
  color: var(--soul-warn);
}

.footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--soul-border);
  padding: 8px;
  display: flex;
  gap: 6px;
  align-items: flex-end;
  background: var(--soul-bg);
}

.footer textarea {
  flex: 1 1 auto;
  resize: none;
  border: 1px solid var(--soul-border);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: inherit;
  font-size: 14px;
  line-height: 1.4;
  outline: none;
  max-height: 96px;
  min-height: 36px;
  color: var(--soul-fg);
  background: #ffffff;
}

.footer textarea:focus {
  border-color: var(--soul-bubble-user-bg);
}

.footer textarea:disabled {
  background: #f9fafb;
  color: var(--soul-muted);
  cursor: not-allowed;
}

.footer button {
  flex: 0 0 auto;
  background: var(--soul-primary);
  color: var(--soul-primary-fg);
  border: 0;
  border-radius: 8px;
  padding: 0 14px;
  height: 36px;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
}

.footer button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 480px) {
  :host {
    bottom: 0;
    right: 0;
    width: 100vw;
    height: 100vh;
  }
  .root {
    border-radius: 0;
    border-width: 0;
  }
}
`
