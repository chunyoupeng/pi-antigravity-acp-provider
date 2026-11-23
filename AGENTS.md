# AGENTS.md

这个仓库是 Pi 的 Google Antigravity ACP provider 扩展（入口：`extensions/index.ts`，源码在 `src/`，测试在 `test/`）。

## 常用命令

- `npm run typecheck`：类型检查
- `npm test`：单元测试（vitest）
- `npm run check`：typecheck + test
- `npm run test:real-acp` / `npm run test:live`：需要真实 ACP runtime / 已登录账号的测试

## 修改完成后的必做步骤

> **只跑单元测试不算完成。** 单测通过之后，还必须开一个真实的 Pi 加载本地扩展做回归测试，两者缺一不可。

1. 跑 `npm run check`，确保类型检查和单元测试都通过。
2. **用一个真实的 Pi 做回归测试。** 单元测试不算数，必须真实加载当前源码跑一次：

   ```bash
   # 非交互冒烟：加载本地扩展，用 antigravity-acp 模型发一条 prompt
   pi --no-extensions -e ./extensions/index.ts --no-session \
      --model "antigravity-acp/gemini-4-neon" \
      -p "Read package.json and tell me the package name, then run \`ls\`."
   ```

   - 回归测试默认使用模型 `antigravity-acp/gemini-4-neon`。如需确认可用模型，用 `pi --no-extensions -e ./extensions/index.ts --list-models antigravity` 查看。
   - 至少要确认：扩展能正常加载、模型能返回回答、Pi 的工具调用（read / bash / edit 等经 MCP bridge）能成功执行并回传结果。
   - 改动涉及哪块功能，就针对那块写 prompt 去测（比如工具渲染、权限模式、session 恢复、图片输入、reasoning effort 等）。交互式或 session 恢复相关的改动，要开交互式 `pi --no-extensions -e ./extensions/index.ts` 手动测，必要时用 `-c` / `--session` 恢复会话。
   - 回归测试失败或出现异常输出，就继续修，不能直接报告完成。
3. 汇报时写明跑了哪些命令、用的哪个模型、结果是什么。
