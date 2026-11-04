# 上下文压缩：由 Pi 接管

2026-10-17 实测，Antigravity ACP server 1.4.0，模型 `gemini-4-argon`。

现在由 Pi 先压缩，Antigravity（下文 AGY）自己的截断在实测中没有再出现。Pi 压缩后，provider 丢掉旧的 AGY 会话，用 Pi 压缩后的上下文重建，所以 AGY 手里的历史始终就是 Pi 的上下文。万一 AGY 抢先截断，provider 也会丢掉它的版本，换回 Pi 的。按当前设置，日常写代码时真实上下文能用到约 18 万 token，然后 Pi 压缩；纯中文对话约 15 万。

AGY 升级后，这里的几个数字可能失效，见最后一节"ACP 更新时要检查什么"。

## 三把尺子

数字看着乱，是因为它们不在同一把尺子上。

```
① 真实 token      模型实际处理的 token。Gemini 能接受 1M，但到不了，AGY 会先截断
② AGY 的计数      AGY harness 按 transcript 的 UTF-8 字节估算，约 2.9 字节记 1 个；
                  记到约 247–250k 时，用它自己的摘要替换历史（日志里的 truncating conversation）
③ Pi 看到的数     provider 报给 Pi 的，取 ① 和 ② 的保守估计（字节 ÷ 2.6）中较大的那个
```

`CONTEXT_WINDOW = 240k` 是第 ③ 把尺子。Pi 自己预留 16,384，所以 ③ 到 223.6k 时压缩，相当于 AGY 的 transcript 涨到约 58 万字节。Pi 状态栏的百分比也是这把尺子，不是真实 token。

## 原来的问题

第一，token 数虚高一倍。AGY 的 `usage_update.used` 把 cache 命中的 token 算了两次：

```
used = input + 2 × cacheRead + output
例：3305 + 2 × 44955 + 17 = 93232，真实是 48277
```

会话 `01a14810…` 里 Pi 记录到 420k，而 AGY transcript 里真实只有 212k。Pi 因此在真实约 12 万时就开始压缩，14 分钟里压了 10 次。

第二，压缩没传到 AGY。10 次压缩都发生在工具循环中途：AGY 的 prompt 还在等 `pi_bash` 的结果。provider 走 tool-result 续接路径，把结果直接交回仍在运行的 AGY prompt，不检查历史指纹，还把指纹更新成压缩后的上下文。于是下一轮用户输入也被当作 warm session 续用。AGY 会话 `f322dda8…` 从头到尾 117 步，一条 Pi 摘要都没收到。

第三，用固定的真实 token 窗口（原来是 256k）判断什么时候压缩是错的。AGY 不按真实 token 截断，而是按字节，见下一节。

第四，重建的内容会被 AGY 截掉尾巴（验证时发现）。provider 重建会话时，把 Pi 的上下文作为一条用户消息发给 AGY。AGY 只保留单条用户消息的前约 192KB，后面的模型收不到。run 4 里一次约 40 万字符的重建，transcript 里只存了 189,935 个字符加一个 `<truncated … bytes>` 标记，新会话第一步真实只有 68,429 token（完整的话应在 12 万左右）。丢掉的恰好是最后的部分：最近几个文件的读取结果、续接说明和当前请求。agent 以为自己只读到 020，倒回去从 021 重读，其实已经读到 026。run 3 重建后读一个文件就停下，也是这个原因：重建约 21 万字节，末尾的续接说明和 Pi 的摘要被截掉了。

## 实测：AGY 什么时候截断

做法：在 zellij 里开 Pi agent，关掉 Pi 的自动压缩（实验目录下 `.pi/settings.json` 写 `{"compaction":{"enabled":false}}`），让它逐个读 40KB 左右的文件，监控脚本同时读 Pi 的 session 文件、AGY 的 `~/.gemini/antigravity-acp/brain/<id>/.system_generated/logs/transcript_full.jsonl` 和 `acp-server.log`，直到出现 CHECKPOINT。

| 内容 | 每个 AGY 计数占几字节 | 截断时的 AGY 计数 | 截断时的真实 token | 每个真实 token 占几字节 |
| --- | --- | --- | --- | --- |
| 你的编码会话 `eb8f19a8` | 2.68 | 239,518 | 约 262k | — |
| 十六进制日志 | 2.89 | 254,357 | 465,643 | 1.49 |
| 英文文档（真实 `.md`） | 2.91 | 252,010 | 233,454 | 3.08 |
| TypeScript（真实 `.ts`） | 3.00 | 251,065 | 221,822 | 3.24 |
| 中文（写作素材） | 3.06 | 250,438 | 188,137 | 3.87 |

真实 token 从 19 万到 47 万都有，但按字节算的 AGY 计数稳定在每 2.7–3.1 字节一个。所以用一个固定的真实 token 窗口，对哪种内容都不对。

中文那一轮按字符算是 1.07 字符一个，按字节算是 3.06，证明 AGY 数的是 UTF-8 字节。

触发点：英文文档那一轮，AGY 计数约 246.7k 时没截断，252.0k 时截断；中文那一轮在 237.4k 和 250.4k 之间。所以阈值在 246.7k 到 250.4k 之间，不是名义上的 256k。

截断后 Pi agent 都写出了 `CONTEXT LOST`，下一步真实 token 掉到约 1.7 万。截断时 AGY 会沉默 1–2 分钟做摘要，期间会触发 provider 90 秒的无响应提示。

## 中文和英文

同样的内容，中英文在 AGY 那里占的额度基本一样。用 DashScope `qwen-plus` 把 4 段各 2500 字的中文译成英文：

| 文件 | 中文字节 | 英文字节 | 英文/中文 |
| --- | --- | --- | --- |
| 003 | 7,184 | 6,924 | 0.96 |
| 017 | 7,248 | 6,400 | 0.88 |
| 041 | 6,594 | 7,821 | 1.19 |
| 066 | 6,864 | 7,670 | 1.12 |
| 合计 | 27,890 | 28,815 | 1.03 |

一个汉字 3 字节但信息密，英文 1 字节一个字母但要多写约 3 倍字符，两边抵消。中文在"真实 token 数"上显得少，但能放进去的内容量差不多。

## 按当前设置，真实上下文能用多少

Pi 在 AGY transcript 约 581,000 字节（223.6k × 2.6）时压缩。换算成真实 token：

| 内容 | Pi 压缩时的真实 token | AGY 截断时的真实 token |
| --- | --- | --- |
| 十六进制日志 | 约 39 万 | 约 47 万 |
| 英文文档 | 约 19 万 | 约 23 万 |
| 代码 | 约 18 万 | 约 22 万 |
| 中文 | 约 15 万 | 约 19 万 |

中间差的 3–4 万由两部分组成。约一半来自系数取得保守：一个 2.6 要覆盖所有内容，而代码实际是 3.0，Pi 的估算比 AGY 的计数高约 15%。另一半是留给一步的余量：Pi 每一步结束才检查一次，而一步最多会再进来一个 46 KiB 的工具结果（约 1.8 万 AGY 计数）。最坏情况（2.68 字节一个）下，Pi 压缩时 AGY 计数至多约 217k，再加一步约 234.5k，仍低于 246.7k。

## 代码改动

`src/acp/transcript-usage.ts`（新）：报给 Pi 的上下文占用 = max（真实 token，transcript 字节 ÷ `HARNESS_BYTES_PER_TOKEN`）。

- 真实 token：在 transcript 最近的 PLANNER_RESPONSE 里找满足 `input + 2 × cacheRead + output = used` 的那一步，取 `input + cacheRead + output`。找不到就保留 `used`，偏大只会让 Pi 早压缩。
- 字节：累计整个会话 `content` 和 `tool_calls` 的 UTF-8 字节，AGY 自己 checkpoint 之后也不清零（见下面的兜底）。transcript 会把长记录截短（工具结果约 49KB、用户输入约 192KB），留下 `<truncated N bytes>`，这个 N 也加上。
- 增量读文件，只读新追加的部分。AGY 有时先发 usage 再写这一步，所以没匹配上会在 50/100/200/400 ms 后重读。
- `HARNESS_BYTES_PER_TOKEN = 2.6`，低于所有实测值，估算略偏大。
- `transcriptCheckpoints` 返回 transcript 里 CHECKPOINT 的个数，供兜底使用。

`src/runtime.ts`：

- usage 更新改用 `contextTokensInUse`。
- 工具结果和权限结果续接前，检查 Pi 的上下文是否仍以发给 AGY 的内容开头（`contextDiverged`）。不是，就取消等待中的 turn、删掉保存的会话、新开会话，用 Pi 的上下文重建。系统指令变化不走这条，它有自己的重建路径。
- 兜底（`noteHarnessCheckpoint`）：AGY 万一抢先 checkpoint，provider 在下一次 usage 更新里看到 CHECKPOINT 个数增加，在 Pi 消息里写一行提示 "Antigravity replaced this conversation's history with its own summary…"。字节计数不清零，于是 Pi 看到上下文已满，马上压缩。Pi 下一次调用时，不管压没压缩，provider 都丢掉这个 AGY 会话，用 Pi 的上下文新开会话重建。所以即使 AGY 抢先截断，后面用的仍是 Pi 的版本，不是 AGY 自己的摘要。
- 工具调用的 100ms 批处理计时器先等 `updateQueue`，再结束 Pi 消息，保证这条消息带上修正后的 usage。

`src/models.ts`：`CONTEXT_WINDOW` 改为 240k（原 256k）。

`src/stream/context.ts`：重建预算由"历史部分 600k 字符"改为"整条输入 `MAX_PROMPT_BYTES` = 160 KiB（UTF-8 字节）"，比 AGY 的约 192KB 上限留出约 30KB 给它自己的包装和元数据。指令和当前请求先扣除（两者都不截断），剩下的给历史，放不下时先丢最旧的，当前工具循环最新的结果优先保留。历史至少保留 16 KiB 放当前工具循环的标签。以前按字符计数，中文一个字 3 字节，会被严重低估。

## 验证

开着压缩、用新代码跑了两轮。

run 2（40 个 `.ts` 文件）：Pi 在估算 240,801 和 242,313 时各压缩一次，每次随后 AGY 会话都换成新的，用 Pi 的上下文重建（首个输入约 8 万字符），没有出现 AGY CHECKPOINT。40 个文件按顺序各读一次，最后执行了回报命令。

```
14:34:26  pi usage=234,367   AGY real=188,435
14:34:44  PI COMPACTION tokensBefore=240,801
14:34:50  AGY session CHANGED b48ade52…
14:34:59  AGY real=32,464，agent 接着读 data/022.log
```

run 3（中文）：Pi 在真实 169k 时压缩（不开压缩时 AGY 在 188k 截断），AGY 会话重建，没有 CHECKPOINT。但重建输入超过了 192KB，被截掉尾巴，agent 读完一个文件就停了（问题四）。run 2、run 3 是在窗口还是 256k 时跑的，换算到 240k 分别约 17.5 万和 15.2 万真实 token。

run 4（代码，关闭 Pi 自动压缩，逼 AGY 先截断）验证兜底：AGY 在 15:18:57 checkpoint；下一步 Pi 消息里出现提示，usage 报 298,360（Pi 看到已满）；Pi 下一次调用时 AGY 会话换成新的。兜底本身生效，但重建被截断（问题四），agent 倒回 020。

改成按字节的 160 KiB 预算后重新验证：

- run 4b（代码，关闭压缩，兜底路径）：AGY 在 15:29:10 checkpoint，15:29:25 换成新会话。重建输入 164,061 字节，没有截断标记，带着续接说明。agent 写出 `read 026`，接着读 027、028、029，没有倒回去。
- run 3b（中文，开启压缩）：Pi 在估算 236,804 时压缩，AGY 会话重建，输入 164,060 字节，没有截断。agent 接着读 016、017、018，没有停下，全程没有 AGY CHECKPOINT。

`npm run check`：typecheck 通过，387 passed，12 skipped（live 测试）。相关测试：

- `test/transcript-usage.test.ts`：cache 双计修正、按字节估算、中文字节、截断标记、checkpoint 计数。
- `test/runtime.test.ts` 中 "restarts from Pi's compacted context when Pi compacts during a tool loop"：去掉修复会失败，AGY 直接续接返回 `echo result`。
- `test/pi-takeover.test.ts` 中 "rebuilds from Pi's context after the harness replaces history with its own summary"：去掉兜底会失败，第三轮沿用旧会话。
- `test/context-budget.test.ts`：整条输入不超过 `MAX_PROMPT_BYTES`，中文按字节计，最新内容保留。

## 已知局限

单步进来的内容远超一个 46 KiB 工具结果时（一次并行多个读文件、一次贴进一大段文本），AGY 可能在 Pi 检查前自己截断。这时兜底会接手，用 Pi 的上下文重建。

单条用户消息本身超过约 192KB 时（比如直接粘贴一个大文件），AGY 会截掉它的尾巴。provider 不截断当前请求，所以这种情况管不了，只能避免一次贴太多。

## ACP 更新时要检查什么

下面这些都是 AGY 的内部行为，没有文档，是 2026-10-17 在 server 1.4.0 上测出来的。AGY ACP server 一升级（`/antigravity-acp update`，或 `runtime-manifest.json` 换了版本），就要重新确认一遍。任何一项变了，上下文就可能不再由 Pi 管理，而且不会报错，只会悄悄丢历史。

| 检查项 | 1.4.0 的值 | 代码里的位置 | 怎么测 |
| --- | --- | --- | --- |
| `usage_update.used` 是否双计 cache | `input + 2 × cacheRead + output` | `transcript-usage.ts` 的匹配公式 | 发两轮相同前缀的 prompt，对比 `used` 和 transcript 里这一步的三个字段 |
| AGY 计数的字节系数 | 每 2.68–3.06 字节一个 | `HARNESS_BYTES_PER_TOKEN = 2.6` | 关掉压缩跑到截断，用 `acp-server.log` 里的 `current tokens` 除 transcript 字节 |
| AGY 截断阈值 | 约 247–250k（名义 256k） | `CONTEXT_WINDOW = 240k` | 同上，看截断前后两步的 AGY 计数 |
| 单条用户输入上限 | 约 192KB | `MAX_PROMPT_BYTES = 160 KiB` | 发一条 250KB 的输入，看 transcript 里是否出现 `<truncated N bytes>`、新会话第一步的真实 token |
| transcript 的路径和格式 | `brain/<id>/.system_generated/logs/transcript_full.jsonl`，字段 `type`、`content`、`tool_calls`、`input_tokens`、`cache_read_tokens`、`output_tokens`，类型 `PLANNER_RESPONSE`、`CHECKPOINT` | `transcript-usage.ts` | 打开一个新会话的文件看一眼 |
| `PromptResponse.usage` 的含义 | 1.4.3 起才有值，是整轮所有模型调用的**累加**（8 次调用、上下文约 70k 的一轮报约 350k），不是上下文占用 | `withContextUsage` 优先用 `usage_update` 的值 | 跑一轮多工具调用，把 transcript 里各步 `input_tokens`、`cache_read_tokens` 加起来，对比 prompt 返回的 `inputTokens`、`cachedReadTokens` |
| 客户端能否配置 AGY 压缩阈值 | 不能（1.4.0–1.4.5 均如此）。SDK 有 `CompactionConfig(token_threshold)`，但 ACP server 建会话时不传 `compaction_config`；`_meta.antigravity` 只认 `enabledTools`、`disabledTools`、`eagerMcpServers`、`mcpMaxOutputBytes`、`systemPrompt`、`forceAllToolsEager`、`gateway`；没有相关环境变量；`hooks.json` 没有压缩事件 | 所以默认只能让 Pi 抢在 AGY 之前压缩（`CONTEXT_WINDOW`），或者直接对二进制打补丁，见下节「512K 二进制补丁与自动适配方案」 | 在新版二进制里搜 `compaction_config`，看 ACP agent 构造 `common_args` 时是否带上 |

## 512K 二进制补丁与自动适配方案（2026-11-04 逆向记录）

本节完整记录对 `agy_acp_server.par` + `localharness_external`（1.4.1–1.4.5）及原生 `/Users/pengchunyou/.local/bin/agy`（1.5.0）的逆向方法、关键函数地址、指令特征和补丁方案，供后续让 AI 在 `src/acp/setup.ts` 中直接写出自动补丁逻辑。

### 1. 逆向怎么做的（还原无符号 Go 二进制 + 解包 `.par`）

1. 解包 `agy_acp_server.par`：
   - `.par` 是 Mach-O 64-bit arm64 可执行文件后拼接 ZIP 归档，末尾紧跟 Apple 代码签名块。标准 `unzip` 会因为签名尾块报错，只需在文件中搜索 ZIP EOCD 魔数 `PK\x05\x06`（最后一处 + 22 字节），截断后面的签名即可用 Python `zipfile.ZipFile` 读取全部源码。
2. 还原 `localharness_external` 与 `agy` 的 Go 符号表：
   - 两个 Go 二进制均 strip 了常规符号表（`nm` / `go tool nm` 无输出），但保留了 Go 运行时的 `__gopclntab`（魔数 `\xf1\xff\xff\xff\x00\x00`）。
   - 解析方法：
     1. 从 Mach-O `LC_SEGMENT_64`（`cmd == 0x19`）里读取 `__TEXT,__text` 的虚拟地址 `text_vaddr`（`sectOff + 32`）和文件偏移 `text_fileoff`（`sectOff + 48`）。在 `agy` 1.5.0 中 `text_vaddr = 0x1000011c0`、`text_fileoff = 0x11c0`；在 `localharness_external` 1.4.5 中 `text_vaddr = 0x100000e00`、`text_fileoff = 0xe00`。
     2. 搜索 `\xf1\xff\xff\xff\x00\x00` 定位 `pclntab` 头 `pcln`：
        - `nfunc = uint64(pcln + 8)`
        - `funcnameOff = uint64(pcln + 32)`（字符串表基址 `fnBase = pcln + funcnameOff`）
        - `functabOff = uint64(pcln + 64)`（函数表基址 `ftBase = pcln + functabOff`）
     3. 遍历 `i in 0..nfunc-1`：
        - `entryRel = uint32(ftBase + i * 8)`
        - `finfoRel = uint32(ftBase + i * 8 + 4)`
        - `nextRel = uint32(ftBase + (i + 1) * 8)`
        - `nameRel = int32(ftBase + finfoRel + 4)`
        - 函数名即 `fnBase + nameRel` 处的以 `\x00` 结尾的字符串；函数在文件中的指令范围为 `[text_fileoff + entryRel, text_fileoff + nextRel)`。

### 2. 为什么默认被锁死在 256K（完整调用链）

1. 独立版 `agy-acp`（`1.4.1–1.4.5`）：
   - Python 层 `acp_server/server.py` 创建 `ProxyAgentConfig` 时未传 `compaction_config`；且 `acp_server/proxy_agent_config.py` 的 `ProxyAgentConfig.create_strategy()` 在构造 `ProxyConnectionStrategy` 时漏传了 `self.compaction_config`，导致发给 `localharness_external` 的 `CompactionConfig.token_threshold` 恒为 `0`。
   - Go 层 `localharness_external` 有两处函数把上限锁死在 `256,000`（`0x3e800`，ARM64 编码为双指令 `mov reg, #0xe800; movk reg, #0x3, lsl #16`）：
     - `google3/.../cortex/utils.GetCheckpointConfig`（1.4.5 虚拟地址 `0x1012f0910..0x1012f0da0`，文件偏移 `0x12f0a1c`、`0x12f0a28`、`0x12f0cf0`）：当 `CheckpointConfig.MaxTokenLimit`（结构体偏移 `+0xc`）为 `0` 或超出模型允许上限时，回退到 `256,000`（上限钳制公式为 `modelMaxTokens - max(16384, min(maxOutputTokens * 2.0, modelMaxTokens * 0.15))`，1M 模型约 `868,928`）。
     - `google3/.../localharness/localagent.makeCascadeConfigWithSkillsRunnerAndFS`（1.4.1–1.4.3 名为 `makeCascadeConfigWithSkillsAndRunner`；1.4.5 虚拟地址 `0x101a44b80..0x101a48280`，文件偏移 `0x1a44d88`、`0x1a44d90`）：当 `CompactionConfig` 未设置时直接构造 `CheckpointConfig`，把 `TokenThreshold`（`+0xc0`）设为 `140,000`（`0x222e0`：`mov x3, #0x22e0; movk x3, #0x2, lsl #16`），把 `MaxTokenLimit`（`+0xc`）设为 `256,000`（`0x3e800`：`mov x4, #0xe800; movk x4, #0x3, lsl #16`）。

2. 原生 `agy` CLI（`1.5.0`，`/Users/pengchunyou/.local/bin/agy`）：
   - 已原生支持 `/compact` 斜杠命令（`slashcommands.GetSystemSlashCommandsDefinitions` `0x10bdd0370` -> `slashcmd.Expand` `0x10289f970` -> `cortex/shared.ParseCompactRequest` `0x100f05a90`）。
   - 已原生支持 `"256K"` / `"512K"` / `"900K"` 预设（`backend.ParsePresetContextWindow` `0x102851cd0`）及环境变量 `AGY_CLI_AUTO_COMPACT_OVERRIDE`（`store.AutoCompactOverride` `0x102b6c160`，支持百分比或绝对 token 数），由 `ServerBackend.buildCascadeConfigInternal`（`0x1028617c8..0x102861844`）写入 `CheckpointConfig.MaxTokenLimit`。
   - 但受限于两道门禁：
     - TUI 层的 `store.(*Store).ContextWindow`（`0x102b6c390`）和 `SelectorModel.offersContextWindow`（`0x102d76db0`）检查当前模型显示名是否在白名单切片 `0x10bdb9380`（仅含 `["Gemini 4 Argon"]`）中，非 Argon 模型在文件偏移 `0x2b6c440` 和 `0x2d76eec` 处通过 `tbnz x0, #0x3f` 直接短路返回 `""`。
     - `agy acp` 子命令的 `ACPServer.loadSettings`（`0x1028cc550`）只反序列化 5 个字段的结构体（`0x109b9cb58`），忽略了 `settings.json` 里的 `contextWindow`，且从未调用 `ServerBackend.SetContextWindow`（`0x102864c00`），因此回落到 `utils.GetCheckpointConfig`（文件偏移 `0x13465c4`、`0x13465d0`、`0x1346898`）的 `256,000` 默认值。

3. 安全与风控验证：
   - 两个二进制均无自校验或二进制哈希上报（`os.Executable` 全二进制仅 `acp.spawnWorkerProcesses.func1` `0x1028d1e80` 调用一次用于起子进程）。
   - 发往 Google Cloud Code 的 `GenerateChatRequest`（`0x1007bc1a0..0x1007bc5e0`）与 `StreamGenerateContent` 不包含 `CheckpointConfig` 字段，`MaxTokenLimit` 仅在本地 `checkpoint.shouldCheckpoint`（`0x101c13c50` / `0x101913de0`）中消费。
   - 在 `~/.gemini/antigravity-cli/settings.json` 中设置 `"enableTelemetry": false` 后，`analytics.Init`（`0x102837f30`）与 `ServerBackend.SetTelemetryEnabled`（`0x1028649f0`）直接在本地短路关闭 Clearcut。

### 3. 本地二进制已应用的补丁（备份在 `~/.local/opt/agy-acp/backups/`）

ARM64 32 位立即数双指令编码公式（寄存器号 `reg = 0..30`，目标值 `val`）：
- `lo16 = val & 0xffff`，`hi16 = (val >>> 16) & 0xffff`
- 第 1 条 `mov x<reg>, #lo16`（小端 uint32）：`(0xd2800000 | (lo16 << 5) | reg) >>> 0`
- 第 2 条 `movk x<reg>, #hi16, lsl #16`（小端 uint32）：`(0xf2a00000 | (hi16 << 5) | reg) >>> 0`

具体数值对应机器码：
- `256,000`（`0x3e800`）：`ins1 & 0xffffffe0 == 0xd29d0000`，`ins2 & 0xffffffe0 == 0xf2a00060`
- `140,000`（`0x222e0`）：`ins1 & 0xffffffe0 == 0xd2845c00`，`ins2 & 0xffffffe0 == 0xf2a00040`
- `512,000`（`0x7d000`）：`lo16 = 0xd000`，`hi16 = 0x7` -> `0xd29a0000 | reg`，`0xf2a000e0 | reg`
- `544,000`（`0x84d00`）：`lo16 = 0x4d00`，`hi16 = 0x8` -> `0xd289a000 | reg`，`0xf2a00100 | reg`
- `300,000`（`0x493e0`）：`lo16 = 0x93e0`，`hi16 = 0x4` -> `0xd2927c00 | reg`，`0xf2a00080 | reg`

已执行的修改：
1. `/Users/pengchunyou/.local/opt/agy-acp/current/localharness_external`（1.4.5）：
   - 文件偏移 `0x12f0a1c`（`x4`）、`0x12f0a28`（`x4`）、`0x12f0cf0`（`x3`）、`0x1a44d90`（`x4`）四处 `256,000` 改为 `544,000`（`0x84d00`），给 Pi 的 `CONTEXT_WINDOW = 512_000` 留出 32K 缓冲，确保永远由 Pi 先压缩。
   - 文件偏移 `0x1a44d88`（`x3`）的 `TokenThreshold = 140,000` 改为 `300,000`（`0x493e0`）。
   - 执行 `codesign -f -s -` 重签名，并将 `install-integrity.json` 中的 `harnessBytes` 更新为重签名后的文件大小（`122225056`）。
2. `/Users/pengchunyou/.local/bin/agy`（1.5.0）：
   - 文件偏移 `0x13465c4`（`x4`）、`0x13465d0`（`x4`）、`0x1346898`（`x3`）三处 `256,000` 改为 `512,000`（`0x7d000`；注意避开 `0x2d47a4c` 处 `model.(*History).load` 的历史文件截断常量）。
   - 文件偏移 `0x2b6c440` 与 `0x2d76eec` 两处 `tbnz x0, #0x3f` 改为 `nop`（`1f 20 03 d5`），解除 TUI 非 Argon 模型的上下文窗口门禁。
3. `src/models.ts`：`CONTEXT_WINDOW` 设为 `512_000`。

### 4. 后续在 `src/acp/setup.ts` 实现自动补丁的设计要点

如果希望 `pi-antigravity-acp-provider` 在自动升级 ACP runtime 时自动打补丁（跨版本免维护），只需让 AI 按以下 3 步修改 `src/acp/setup.ts`：

1. 按 `pclntab` 函数名定位并替换指令（跨版本稳定，1.4.1–1.4.5 实测全部精确命中）：
   - 解析 `localharness_external` 的 Mach-O `__text` 文件偏移和 `__gopclntab`（`\xf1\xff\xff\xff\x00\x00`）。
   - 仅在函数名满足 `name.endsWith("utils.GetCheckpointConfig") || name.includes("localagent.makeCascadeConfigWithSkills")` 的指令区间 `[start, end - 8]` 内扫描：
     - 匹配 `256,000`（`0xd29d0000` + `0xf2a00060`，且两条指令寄存器号相同）-> 替换为 `544,000`（`0x84d00`）。
     - 在 `makeCascadeConfigWithSkills*` 内匹配 `140,000`（`0xd2845c00` + `0xf2a00040`）-> 替换为 `300,000`（`0x493e0`）。
   - 写回文件后在 macOS 上调用 `codesign -f -s - <harnessPath>`。
2. 处理 `installRelease` 与 `isInstalledRelease` 的文件大小校验：
   - `codesign -f -s -` 生成的 ad-hoc 签名比 Google 原始签名略小（例如 1.4.5 从 `122957936` 变为 `122225056`），而 `release.harnessBytes` 来自 `runtime-manifest.json` 的原始大小。
   - 因此在 `installRelease` 中应先打补丁再读取 `fs.statSync(harnessPath).size` 写入 `install-integrity.json`（可同时加一个 `harnessPatchMaxTokenLimit: 544000` 标记字段）；在 `isInstalledRelease` 中，当 `record.harnessPatchMaxTokenLimit` 存在时，用 `record.harnessBytes`（而非 `release.harnessBytes`）传给 `validRuntimeFile`。
3. 在 `ensureOnce` 中做一次幂等补丁检查：
   - 若当前已安装的受管 runtime 的 `install-integrity.json` 尚无 `harnessPatchMaxTokenLimit: 544000`，原地执行一次补丁并更新 `install-integrity.json`。

最后一项最要紧。transcript 读不到或格式变了，`contextTokensInUse` 会退回 AGY 报的 `used`，那个值偏大，只会让 Pi 早压缩，不会晚压缩。但兜底依赖在 transcript 里看到 CHECKPOINT，格式一变它就失效。

最省事的整体验证是重跑一次本文的实验：在 zellij 里开 Pi agent 逐个读 40KB 文件，一轮关掉压缩，看 AGY 什么时候截断、兜底是否接手；一轮开着压缩，看监控里是否总是 `PI COMPACTION` 先于任何 `AGY CHECKPOINT`，以及重建后 agent 是否接着读下一个文件。
