# AI-avatar 手工模拟场景测试代码

包含 3 个文件：

- `desktop-app/src/services/manual-qa-scenarios.ts`
- `desktop-app/src/services/manual-qa-scenarios.test.ts`
- `desktop-app/scripts/manual-qa-scenarios-smoke.ts`

## 覆盖场景

1. 知识库事实问答
2. Excel 精确数值问答
3. 连续两轮追问
4. 诱导系统乱引用

## 建议加入 package.json 的 scripts

```json
{
  "test:manual-qa-scenarios": "NODE_PATH=./test-support/node_modules npx --yes tsx --test src/services/manual-qa-scenarios.test.ts",
  "test:manual-qa-smoke": "NODE_PATH=./test-support/node_modules npx --yes tsx scripts/manual-qa-scenarios-smoke.ts"
}
```

## 运行

```bash
cd desktop-app
npm run test:manual-qa-scenarios
npm run test:manual-qa-smoke
```

如果你还没加 scripts，也可以直接运行：

```bash
cd desktop-app
NODE_PATH=./test-support/node_modules npx --yes tsx --test src/services/manual-qa-scenarios.test.ts
NODE_PATH=./test-support/node_modules npx --yes tsx scripts/manual-qa-scenarios-smoke.ts
```
