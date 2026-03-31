# Phase 1: 项目初始化与基础框架

**预计时间**: 3-4 天

**目标**: 搭建 Electron + React 项目骨架，实现基础窗口和 IPC 通信

---

## 任务清单

### 1.1 创建项目目录结构

```bash
cd /Users/cnlm007398/AI/soul
mkdir -p desktop-app/{electron,src/{components,services,stores,types}}
cd desktop-app
```

### 1.2 初始化 npm 项目

```bash
npm init -y
```

### 1.3 安装核心依赖

```bash
# Electron
npm install electron electron-builder

# React
npm install react react-dom

# 构建工具
npm install vite @vitejs/plugin-react

# TypeScript
npm install -D typescript @types/react @types/react-dom @types/node

# UI 框架
npm install tailwindcss postcss autoprefixer
npm install -D @tailwindcss/typography

# 状态管理
npm install zustand

# HTTP 客户端
npm install axios
```

### 1.4 配置 TypeScript

创建 `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

创建 `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["electron"]
}
```

### 1.5 配置 Vite

创建 `vite.config.ts`:

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist-electron',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
```

### 1.6 配置 Tailwind CSS

```bash
npx tailwindcss init -p
```

编辑 `tailwind.config.js`:

```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [
    require('@tailwindcss/typography'),
  ],
}
```

创建 `src/index.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### 1.7 创建 Electron 主进程

创建 `electron/main.ts`:

```typescript
import { app, BrowserWindow, ipcMain } from 'electron'
import path from 'path'

let mainWindow: BrowserWindow | null = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 开发环境加载 Vite 服务器
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境加载打包后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist-electron/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// IPC 测试
ipcMain.handle('ping', () => 'pong')
```

### 1.8 创建预加载脚本

创建 `electron/preload.ts`:

```typescript
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  ping: () => ipcRenderer.invoke('ping'),
})

// TypeScript 类型定义
export interface ElectronAPI {
  ping: () => Promise<string>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
```

### 1.9 创建 React 应用

创建 `src/main.tsx`:

```typescript
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
```

创建 `src/App.tsx`:

```typescript
import { useState, useEffect } from 'react'

function App() {
  const [message, setMessage] = useState('')

  useEffect(() => {
    // 测试 IPC 通信
    window.electronAPI.ping().then(setMessage)
  }, [])

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          小堵 - 工商储专家
        </h1>
        <p className="text-gray-600">
          IPC 测试: {message || '加载中...'}
        </p>
      </div>
    </div>
  )
}

export default App
```

创建 `index.html`:

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>小堵 - 工商储专家</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 1.10 配置 package.json 脚本

编辑 `package.json`:

```json
{
  "name": "xiaodu-desktop",
  "version": "1.0.0",
  "main": "electron/main.js",
  "scripts": {
    "dev": "concurrently \"npm run dev:vite\" \"npm run dev:electron\"",
    "dev:vite": "vite",
    "dev:electron": "wait-on http://localhost:5173 && electron .",
    "build": "tsc && vite build",
    "build:electron": "electron-builder"
  }
}
```

安装开发工具：

```bash
npm install -D concurrently wait-on
```

### 1.11 配置 electron-builder

创建 `electron-builder.yml`:

```yaml
appId: com.soul.xiaodu
productName: 小堵
directories:
  output: dist
files:
  - electron/**/*
  - dist-electron/**/*
win:
  target: nsis
  icon: build/icon.ico
mac:
  target: dmg
  icon: build/icon.icns
  category: public.app-category.productivity
```

---

## 验证标准

运行以下命令测试：

```bash
npm run dev
```

**预期结果**：
- ✅ 应用窗口打开，显示"小堵 - 工商储专家"
- ✅ 显示 "IPC 测试: pong"
- ✅ 窗口大小为 1200x800
- ✅ 可以打开 DevTools

---

## 下一步

完成 Phase 1 后，进入 Phase 2: DeepSeek API 集成与对话功能
