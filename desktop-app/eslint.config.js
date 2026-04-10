// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'dist-electron', 'node_modules', '*.js', '*.cjs', '*.mjs'] },

  // ─── 基础推荐规则 ───
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ─── React + 前端代码 (src/) ───
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },

  // ─── Electron 主进程代码 (electron/) ───
  {
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // ─── 全局自定义规则（代码质量 & 潜在 bug 检测） ───
  {
    files: ['src/**/*.{ts,tsx}', 'electron/**/*.ts'],
    rules: {
      // 禁止未使用的变量（允许下划线前缀忽略）
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      // 禁止 any 类型（警告级别，逐步修复）
      '@typescript-eslint/no-explicit-any': 'warn',
      // 必须 await async 函数返回的 Promise
      '@typescript-eslint/no-floating-promises': 'off',
      // 禁止空函数
      '@typescript-eslint/no-empty-function': 'warn',
      // 优先使用 const
      'prefer-const': 'warn',
      // 禁止 console.log（生产代码应使用 logger）
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // 禁止 debugger
      'no-debugger': 'error',
      // 禁止重复导入
      'no-duplicate-imports': 'error',
      // 要求 switch 的 default 分支
      'default-case': 'warn',
      // 要求全等比较
      'eqeqeq': ['error', 'always'],
      // 禁止 var
      'no-var': 'error',

      // ─── 约定强制执行：禁止绕过共享工具函数 ───

      'no-restricted-syntax': ['error',
        // 禁止 .toISOString().slice(0, 10) — 应使用 localDateString()
        {
          selector: "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString']",
          message: '禁止 toISOString().slice() 获取日期，应使用 localDateString()（来自 @soul/core）避免 UTC 时区偏移',
        },
        // 禁止空 catch 块
        {
          selector: "CatchClause[body.body.length=0]",
          message: '禁止空 catch 块，至少记录日志或添加注释说明忽略原因',
        },
      ],

      // 禁止直接 fetch — 应使用 fetchWithTimeout（来自 @soul/core）
      'no-restricted-globals': ['error',
        {
          name: 'fetch',
          message: '禁止直接 fetch()，应使用 fetchWithTimeout()（来自 @soul/core）确保超时控制',
        },
      ],
    },
  },
);
