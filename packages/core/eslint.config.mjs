// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', '*.js', '*.cjs', '*.mjs'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

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
      // 空 catch 允许：项目惯用 `} catch { /* 注释 */ }` 表达"有意识静默"，
      // 但自定义 no-restricted-syntax 的 AST 选择器无法识别注释、会误报。
      // 约定层面要求 catch body 写注释说明忽略原因（非机械强制）。
      'no-empty': ['error', { allowEmptyCatch: true }],

      'no-restricted-syntax': ['error',
        {
          selector: "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString']",
          message: '禁止 toISOString().slice() 获取日期，应使用 localDateString() 避免 UTC 时区偏移',
        },
      ],
    },
  },

  // 测试/调试脚本允许 console.log——qa-test / journey.test
  // 是命令行跑的诊断工具，stdout 输出本来就是用户接口
  {
    files: ['src/tests/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },

  // tool-router / skill-router 是工具路由的诊断重镇，
  // 正常路径上就有大量 `[tool-router] xxx` 信息日志。core 无 logger
  // 抽象，把它们改成 console.warn 会让 stderr 被正常诊断刷屏，info 语义也错。
  // 这里按文件白名单放开 console.log；错误路径仍应该用 console.warn / console.error
  // 以便和正常 info 分流。
  {
    files: [
      'src/tool-router.ts',
      'src/skill-router.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
);
