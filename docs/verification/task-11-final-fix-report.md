# Task 11 最终小修报告

## 1. 基线

```text
HEAD:  bcbd1fe5c378c06c8e7d5ea50bd6faa8f662c8cf
HEAD^: 2e98d9920742cae17152d6032df2a692d0e281ec
分支:  workbench/agent-core
```

## 2. 两个测试证据缺口

### 问题 A：固定 IV 变异未被有效检出

**原始问题**：原测试比较的是两个不同 Session 的文件内容。明文不同（不同 id / 事件），即使 IV 被固定，密文也可能不同，因此不能证明随机 IV。

**根因**：测试未控制“相同明文 + 相同密钥 + 相同时间”。

**修复**：改为固定 `clock`、固定 `idFactory`、同一 Session，连续两次保存后直接比较 envelope 的 `iv` 字段。

### 问题 B：文件路径泄露测试未覆盖写入失败路径

**原始问题**：原测试通过错误密钥触发解密失败，没有真实进入 `renameSync` 失败分支。

**根因**：未模拟“目标路径被目录占用导致 rename 失败”的保存失败场景。

**修复**：新增测试 —— 删除目标文件后 `mkdirSync(filePath)`，调用 `appendEvent()` 触发真实写入失败，断言固定文案且不泄露路径 / 文件名 / stack / ciphertext / key。

## 3. 修改文件清单

| 文件 | 变更 |
|------|------|
| `tests/task-11-session-persistence-recovery.test.ts` | 重写 IV 随机性测试 |
| `tests/task-11-session-persistence-security.test.ts` | 新增写入失败路径泄露测试 |
| `README.md` | 修正过时能力状态 |
| `docs/verification/task-11-final-fix-report.md` | 本报告 |

**生产代码无改动**（`packages/**` 最终与基线一致）。

## 4. 随机 IV 测试说明

- 相同 32 字节密钥
- 相同 Session（固定 `idFactory`）
- 相同时间（固定 `clock: () => 1000`）
- 相同逻辑明文（同一 session、`setStatus("idle")` 不改变状态）
- 连续两次保存
- 直接解析 envelope，断言 `first.iv !== second.iv`

## 5. 写入失败路径不泄露测试说明

- 真实触发 `renameSync(tempPath, filePath)` 失败（目标为目录）
- 捕获异常后断言 message === `"Session file write failed."`
- 断言不包含：完整 `filePath`、临时目录 `dir`、文件名 `s.json`、源文件名、`stack`、`ciphertext`、key 的 base64/hex

## 6. Red 阶段证据（受控变异）

### 变异 1：固定 IV

```text
命令: corepack pnpm test -- tests/task-11-session-persistence-recovery.test.ts
变异: randomBytes(IV_BYTES) → Buffer.alloc(IV_BYTES, 1)
退出码: 1
关键失败: 1 failed（uses a fresh IV when saving identical plaintext）
恢复后: packages/session-persistence/src/crypto.ts 无 diff
```

### 变异 2：写入失败泄露路径

```text
命令: corepack pnpm test -- tests/task-11-session-persistence-security.test.ts
变异: fileWriteFailed 消息附加 process.cwd()
退出码: 1
关键失败: 1 failed（does not leak the file path when saving fails）
恢复后: packages/session-persistence/src/errors.ts 无 diff
```

两项变异均被新测试检出。

## 7. Green 阶段证据

```text
corepack pnpm typecheck → 0
corepack pnpm test → 0（936 passed）
```

## 8. 全量验证命令与退出码

```text
corepack pnpm install --frozen-lockfile → 0
corepack pnpm typecheck                 → 0
corepack pnpm test                      → 0（936）
corepack pnpm verify:layout             → 0
corepack pnpm security:scan             → 0
corepack pnpm evals:deterministic       → 0
git diff --check                        → 0
```

## 9. 测试总数变化

```text
小修前: 935
小修后: 936（+1 写入失败泄露测试；IV 测试为重写，不增量）
```

## 10. 边界声明

- **生产代码**：无改动
- **网络访问**：无
- **真实凭据**：无
- **`.superpowers/`**：未修改、未暂存、未提交
- **新增依赖**：无
- **Task 12**：未开始

## 11. Git

```text
Commit message: test(session): close Task 11 evidence gaps
```

（提交后由下方实际输出填充 hash / parent / status）
