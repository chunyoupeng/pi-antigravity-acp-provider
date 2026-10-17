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

最后一项最要紧。transcript 读不到或格式变了，`contextTokensInUse` 会退回 AGY 报的 `used`，那个值偏大，只会让 Pi 早压缩，不会晚压缩。但兜底依赖在 transcript 里看到 CHECKPOINT，格式一变它就失效。

最省事的整体验证是重跑一次本文的实验：在 zellij 里开 Pi agent 逐个读 40KB 文件，一轮关掉压缩，看 AGY 什么时候截断、兜底是否接手；一轮开着压缩，看监控里是否总是 `PI COMPACTION` 先于任何 `AGY CHECKPOINT`，以及重建后 agent 是否接着读下一个文件。
