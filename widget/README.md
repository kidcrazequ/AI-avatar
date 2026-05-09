<!--
  @author zhi.qu
  @date 2026-05-09
-->

# soul-embed-widget

Soul「#15 Web Embed widget」前端 bundle —— Preact + Shadow DOM + Custom Element 单文件 IIFE 实现。

## 目录定位

`widget/` 是一个**独立** npm package（与 `desktop-app/` / `packages/core/` 无 monorepo 耦合）。
构建产物 `dist/soul-embed.js` 拷贝到 `desktop-app/electron/widget-static/soul-embed.js`，由 `widget-server` 静态托管。

## 体积目标

| 指标 | 上限 | 守卫 |
|---|---|---|
| minified | < 150KB | `scripts/check-bundle-size.ts` 报错退出 |
| gzipped | < 50KB | `scripts/check-bundle-size.ts` 黄色警告 |

## 构建

```bash
cd widget
npm install
npm run build
# 产物：dist/soul-embed.js
```

构建完成后**手工**拷贝到 widget-server 静态托管点：

```bash
mkdir -p ../desktop-app/electron/widget-static
cp dist/soul-embed.js ../desktop-app/electron/widget-static/soul-embed.js
```

## 开发

```bash
npm run dev   # vite 开发服务器，默认 http://127.0.0.1:5173
```

`widget-server` 的 origin 白名单需包含 `http://localhost:5173` 才能本地联调；
访问 `http://localhost:5173/` 看到一个右下角的对话气泡即成功。

## 技术约束

- ❌ 不引入 React / antd / shadcn / tailwind / styled-components
- ❌ 不引入 markdown 渲染库（自己手写转义 + 极简渲染）
- ❌ 不引入 SSE 解析库（fetch + ReadableStream + 手写解析）
- ✅ Preact 10 + JSX（@preact/preset-vite 编译 `h(...)`）
- ✅ Custom Element + Shadow DOM 隔离，所有样式通过 `<style>` 节点注入 shadow root，不污染父页

## 嵌入用法（产物侧）

```html
<script src="https://your-soul-host:3211/embed.js"></script>
<soul-embed embed-id="emb_xxx"></soul-embed>
```

`data-server` 缺省时，widget 会从 `<script src>` 自动推断 server URL。
