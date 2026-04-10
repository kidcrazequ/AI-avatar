// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = tseslint.config(
  { ignores: ['dist', 'node_modules'] },

  // ─── 基础推荐规则 ───
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ─── Node.js 环境 ───
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-empty-function': 'warn',
      'prefer-const': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-duplicate-imports': 'error',
      'default-case': 'warn',
      'eqeqeq': ['error', 'always'],
      'no-var': 'error',

      // ─── 约定强制执行：禁止绕过共享工具函数 ───

      'no-restricted-syntax': ['error',
        // 禁止 .toISOString().slice(0, 10) — 应使用 localDateString()
        {
          selector: "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString']",
          message: '禁止 toISOString().slice() 获取日期，应使用 localDateString() 避免 UTC 时区偏移',
        },
        // 禁止空 catch 块
        {
          selector: "CatchClause[body.body.length=0]",
          message: '禁止空 catch 块，至少记录日志或添加注释说明忽略原因',
        },
      ],
    },
  },
);
