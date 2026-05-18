# Stash Pop 冲突解决计划

> 创建时间：2026-05-12 11:40
> 作者：zhi.qu
> 触发上下文：用户执行"拉取远程最新代码"，本地有未提交改动，采用 stash → pull → pop 策略；pop 时出现 4 个冲突。

---

## 背景

- 本次 pull：`5f62f97 → 46cdc4d`（fast-forward 成功）
- 远程关键变更：`avatars/小堵-工商储专家/` 整目录已迁移至 `expert-packs/小堵-工商储专家/`
- 本地改动已通过 `git stash` 暂存：`stash@{0}: On main: auto-stash before pull 20260512-113923`
- `git stash pop` 后绝大多数文件已自动恢复并 staged，剩 4 个冲突需手工处理
- ⚠️ stash 仍保留（pop 失败时 git 自动保留），可随时回退

---

## 冲突清单（4 个）

| # | 文件 | 冲突类型 | 规模 | 处理思路 |
|---|---|---|---|---|
| 1 | `avatars/小堵-工商储专家/CLAUDE.md` | modify/delete | 233 行（本地版本） | 迁移：把本地修改"移植"到 `expert-packs/小堵-工商储专家/CLAUDE.md` |
| 2 | `avatars/小堵-工商储专家/memory/MEMORY.md` | modify/delete | 18 行（本地版本） | 迁移：把本地修改"移植"到 `expert-packs/小堵-工商储专家/memory/MEMORY.md` |
| 3 | `desktop-app/src/App.tsx` | content | 1 处冲突，行 662-670（9 行） | 阅读两侧 + 业务上下文，合并 |
| 4 | `desktop-app/src/index.css` | content | 1 处冲突，行 1584-1594（11 行） | 阅读两侧 + 业务上下文，合并 |

---

## 子任务列表（每个独立 1 文件，符合"任务拆分规则"）

> 每个子任务一个独立窗口/对话执行，避免上下文污染。建议执行顺序：3 → 4 → 1 → 2（先解决代码冲突，再处理迁移类冲突）。

### 子任务 1：解决 `desktop-app/src/App.tsx` 内容冲突

- **唯一目标**：移除文件中行 662-670 的冲突标记，输出最终版本
- **加载文件**：仅 `desktop-app/src/App.tsx`
- **步骤**：
  1. 读取文件第 640-690 行（含冲突区域上下 20 行上下文）
  2. 分析 `<<<<<<< Updated upstream` ↔ `>>>>>>> Stashed changes` 两侧差异
  3. 决定合并策略：取上游 / 取本地 / 融合
  4. 移除所有 `<<<<<<<` `=======` `>>>>>>>` 标记
  5. 验证：`grep -c "^<<<<<<<\|^=======$\|^>>>>>>>" desktop-app/src/App.tsx` 应为 0
  6. `git add desktop-app/src/App.tsx`
- **风险**：App.tsx 是主入口，合并错误会导致编译失败。完成后建议 `cd desktop-app && npx tsc --noEmit` 一次（用 background subagent，不阻塞）

### 子任务 2：解决 `desktop-app/src/index.css` 内容冲突

- **唯一目标**：移除文件中行 1584-1594 的冲突标记
- **加载文件**：仅 `desktop-app/src/index.css`
- **步骤**：
  1. 读取文件第 1560-1610 行
  2. 分析两侧 CSS 差异（通常是同一个选择器的属性差异）
  3. 决定合并策略；如果是不冲突的属性可以全保留
  4. 移除冲突标记
  5. 验证：`grep -c "^<<<<<<<\|^=======$\|^>>>>>>>" desktop-app/src/index.css` 应为 0
  6. `git add desktop-app/src/index.css`
- **风险**：低（CSS 不影响编译，只影响视觉）

### 子任务 3：迁移 `avatars/小堵-工商储专家/CLAUDE.md` 改动到 `expert-packs/`

- **唯一目标**：把本地对老路径文件的修改，合并进新路径文件
- **加载文件**：
  - `avatars/小堵-工商储专家/CLAUDE.md`（本地修改版本，待迁移）
  - `expert-packs/小堵-工商储专家/CLAUDE.md`（远程新位置，迁移目标）
- **步骤**：
  1. `git diff HEAD -- "avatars/小堵-工商储专家/CLAUDE.md"` 看本地改了什么（注：HEAD 上该文件已删除，需用 `git show stash@{0}:"avatars/小堵-工商储专家/CLAUDE.md"` 对比 stash 前的工作区）
     - 更稳妥：对比 stash 中的版本与远程被删除前的版本（`git show 5f62f97:"avatars/小堵-工商储专家/CLAUDE.md"`）
  2. 将本地的修改 patch 应用到 `expert-packs/小堵-工商储专家/CLAUDE.md`
  3. 删除老路径文件：`git rm "avatars/小堵-工商储专家/CLAUDE.md"`（远程已删，本地需同步删除）
  4. `git add "expert-packs/小堵-工商储专家/CLAUDE.md"`
- **风险**：迁移过程可能漏掉部分本地改动。完成后用 `diff` 对比一次确保无遗漏。

### 子任务 4：迁移 `avatars/小堵-工商储专家/memory/MEMORY.md` 改动到 `expert-packs/`

- **唯一目标**：同子任务 3，针对 MEMORY.md
- **加载文件**：
  - `avatars/小堵-工商储专家/memory/MEMORY.md`
  - `expert-packs/小堵-工商储专家/memory/MEMORY.md`
- **步骤**：同子任务 3 流程
- **风险**：低（仅 18 行，差异容易看清）

---

## 完成后收尾（独立小步骤，可在子任务 4 完成后顺手做）

1. 全局检查无冲突标记残留：
   ```bash
   git grep -nE "^<<<<<<< |^>>>>>>> " || echo "✅ 无冲突残留"
   ```
2. 检查 `avatars/小堵-工商储专家/` 目录是否清理干净（应为空或不存在）：
   ```bash
   ls -la "avatars/小堵-工商储专家/" 2>/dev/null && echo "⚠️ 目录还有残留" || echo "✅ 目录已清理"
   ```
3. 确认 stash 可以丢弃：
   ```bash
   git status   # 期望：所有修改 staged，无 unmerged
   git stash drop stash@{0}   # 仅在确认无误后执行
   ```
4. **不要**自动 commit，由用户决定 commit 时机和粒度。

---

## 熔断规则

- 任意子任务执行 > 2 轮仍失败 → 停止，回报根因，等待用户决策
- 不得为了"恢复 stash"而扩大改动范围（不要顺手改其他文件）
- 若子任务 1 / 2 合并后 `tsc` 编译失败 → 不再尝试新合并，回报错误并询问用户是回退到上游版本还是 stash 版本

---

## 应急回退方案（如果决定放弃 stash 内容）

如果用户改变主意，想"放弃所有未恢复的本地改动，保持干净拉取后的状态"：

```bash
# 步骤 1：清掉 pop 残留（已 staged + 工作区冲突文件）
git checkout HEAD -- .
git clean -fd

# 步骤 2：stash 仍在 stash@{0}，可保留（万一以后想找）或丢弃
git stash drop stash@{0}   # 可选
```

---

## 状态追踪

- [ ] 子任务 1：App.tsx 冲突解决
- [ ] 子任务 2：index.css 冲突解决
- [ ] 子任务 3：CLAUDE.md 迁移
- [ ] 子任务 4：MEMORY.md 迁移
- [ ] 收尾：全局校验 + drop stash
