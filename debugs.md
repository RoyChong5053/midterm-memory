# MidTerm Memory 插件 Debug 笔记

> 状态：**已实施自愈修复（commit 见 git log），待重启 ST + 硬刷新验证**
> 日期：2026-08-18
> 现象：插件能正确生成并保存摘要，但实时会话中 ST 注入的 raw prompt 一直用旧摘要；刷新页面一次后新内容才生效。
> 关键结论：**不是幽灵缓存** —— 干净重启后 bug 依旧复发，根因是"生成页面的内存态 `extension_prompts['1_memory']` 与 chat 脱节"。

---

## 1. 环境

| 项 | 值 |
|---|---|
| ST 版本 | v1.18.0（`/mnt/sdcard/app/st-8k/Sillytavern/`，PID 9863，`node server.js`） |
| ST 监听 | 仅 `127.0.0.1:8888`（config.yaml `listen: false`） |
| API | main_api=openai，chat_completion_source=custom（One-API → gemini-3.5-flash） |
| Streaming | **关**（`streaming_processor = null`） |
| 官方 memory 扩展 | **禁用**（settings.json `disabledExtensions: ["memory"]`） |
| 插件部署 | `/mnt/sdcard/app/st-8k/Sillytavern/data/default-user/extensions/midterm-memory/`（与本地 repo md5 一致） |
| 插件设置 | source=main, promptInterval=8, position=0(IN_PROMPT), 模板 `<User State(mid-term memory)>\n{{summary}}\n</User State(mid-term memory)>` |
| 注入 tag | `INJECT_TAG = '1_memory'`（commit e0dcf4c 从 `midterm-memory` 改来） |
| 其他进程 | st-tele 连接器 server（PID 10443，WS :2333） |
| 浏览器 | 远端 Firefox（x11vnc :5900），**6:34 PM 时仅 1 个 ST tab** |

---

## 2. 关键时间线（本地时间 +08）

chat 文件：`data/default-user/chats/Leer乐儿/Leer乐儿 - 2026-08-16@02h31m41s631ms.jsonl`

| 时间 | 事件 | 消息 |
|---|---|---|
| 9:50 AM | 摘要生成，挂到 msg 180（内容 = 9:50 AM 状态） | msg 180 |
| 6:28:48 PM | 用户发消息 | msg 188 |
| 6:30:17 PM | 助手回复渲染 → 插件 onChatEvent → 触发摘要 | msg 189 |
| 6:30:35 PM | 摘要 API 返回（`created: 1787049035`）→ `setMemoryContext` 挂到 **msg 188** | msg 188 extra.memory |
| 6:38:00 PM | 用户发消息 | msg 190 |
| 6:38:02 PM | 生成请求发出 → **注入的仍是 9:50 AM 摘要**（来自 msg 180） | msg 191 |
| 6:50 PM | 下一次生成请求 → **还是 9:50 AM 摘要** | msg 193 |

**矛盾点**：6:28 PM 新摘要在 6:30:35 已生成并挂上 msg 188，但 6:38/6:50 的真实请求仍用旧值。而 6:34 PM 只有一个 ST tab，且 6:28 PM 摘要确实是该页面自己生成的。

---

## 3. 证据：真实发送的 payload（服务器实测）

`src/endpoints/backends/chat-completions.js:2588` 在真正 fetch 前会打：
```
console.debug('Chat Completion request:', requestBody);
```
这是**实际发给 API 的字节**，与前端 itemization 显示无关。

tmux `st-8k` 会话日志（本地副本 `/tmp/st8k-full.log`）：
- L15：6:30:35 PM 摘要 response（内容 6:28 PM）
- L76：`Time: 6:38 PM` 请求 → `<User State(mid-term memory)>` 块 = **9:50 AM 内容**
- L1041：`Time: 6:50 PM` 请求 → `<User State(mid-term memory)>` 块 = **9:50 AM 内容**

结论：**真实的注入就是旧的**，不是显示问题。

---

## 4. 逐条排查结论

| # | 怀疑点 | 结论 |
|---|---|---|
| 1 | setExtensionPrompt 是否触发重建/刷新 | 否。此版本 `script.js:8866` 只是纯对象写入 `extension_prompts[key]`，不发任何事件。getExtensionPrompt/getAllExtensionPrompts 每次构建 prompt 时重新读取（script.js:3242, 4641-4642） |
| 2 | CHAT_CHANGED 是否每条消息都触发 | 否。只在 chat 加载/切换/删除时（script.js:1696/7641/10700/10853） |
| 3 | MESSAGE_UPDATED 是否来自 setExtensionPrompt | 否。此版本没有该联动（MESSAGE_UPDATED 只在编辑时发） |
| 4 | streaming 时序问题 | 无关，streaming 关闭 |
| 5 | 官方 memory 扩展干扰 | 无关，已禁用 |
| 6 | flushWIInjections 等 WI 逻辑 | 无关，只处理 WI keys |
| 7 | 插件插入逻辑本身 | **逻辑正确**。setMemoryContext（index.js:985）无条件先调 setExtensionPrompt 再保存 extra.memory，不存在"只保存不注入"的路径 |
| 8 | **prompts itemization 是否坏掉/误导** | **不是根因**。itemization 是每条消息生成时的快照（localforage），`summarizeString = extension_prompts['1_memory']?.value`（script.js:5287）——它**确实统计 1_memory tag**，并如实记录当时（旧）的注入值。它是"镜子"，不是"源头" |
| 9 | 插件显示框 vs 注入是否可能不一致 | 不可能。两者由同一个 setMemoryContext 更新（`$('#mtm_contents').val()` 和 `setExtensionPrompt` 同函数内）。"显示框看起来对"= 刷新后 onChatChanged 用最新 chat memory 重同步过，这正是"刷新就好了"的原因 |
| 10 | 多 tab / 多实例 | 6:34 PM recovery.jsonlz4 显示**仅 1 个 ST tab**（+1 个 Google Keep）。多 tab 假设在 6:38 PM 时刻不成立；但 6:30-6:34 之间曾存在过第二个实例并随后关闭的可能性**无法排除**，那能完美解释"摘要由 A 页生成、B 页拿着旧 extension_prompts 生成" |

---

## 5. 当前判断

- 插件插入代码逻辑正确、摘要管线正确、itemization 没坏。
- 坏的是**生成页面的内存态 `extension_prompts['1_memory']` 与 chat 文件脱节**——即生成时页面手里的值还是旧的 9:50 AM。
- 最可能机制（无法 100% 追溯）：
  1. 6:30-6:34 之间短暂存在第二个页面实例（做摘要的那页随后被关闭），存活页持有旧内存态；**或**
  2. 页面在 6:30:35 后、6:38 前发生状态重置/重新加载，且读到的 chat 快照里 msg 188 的记忆尚未写入（saveChatDebounced 用的是 `debounce_timeout.relaxed`，较难但非不可能）。
- 用户昨天"边用边改边 git pull"，**不排除页面缓存了旧版插件 JS**（e0dcf4c 之前用 tag `midterm-memory`，若生成页跑旧版，其 setMemoryContext 写的是 `extension_prompts['midterm-memory']`，而读取侧…但按 setExtensionPrompt 语义仍会注入）。**需重启验证。**

---

## 6. 重启复现结果（2026-08-18 晚，决定性）

干净重启后（node PID 542355，19:35:08 启动），bug 在 ~10 分钟内再次出现：

| 时间 | 事件 |
|---|---|
| 19:35:08 | ST 重启（新进程），单 tab（sessionstore 确认 1 个 ST tab） |
| 19:41:02 | 页面自动生成 **7:39 PM 摘要**（新），挂到 msg 196（文件已确认） |
| 19:46 | 下一次生成请求（服务器 wire log）**仍注入 6:28 PM 旧摘要** |

→ 排除了 git pull / 浏览器缓存。问题在摘要写入后、下一次生成时，生成页面的
`extension_prompts['1_memory']` 仍是旧值。最可能机制：第二页面实例（隐私窗口等 sessionstore
不记录）做摘要/生成分流，或页面在保存瞬间重载；`extension_prompts` 不随跨 tab 同步。

## 7. 已实施的修复（commit 后 git log 查看）

在 `index.js` 加入"注入自愈"逻辑，生成前把 `extension_prompts['1_memory']` 重新对齐到 chat 最新记忆：

1. **`syncMemoryFromChat()`**：读 `getLatestMemoryFromChat(chat)`，仅当与当前注入值不一致时才
   `setMemoryContext(latest, false)` 重写；跳过 `inApiCall` / streaming 中 / 用户正在编辑文本框。
2. 触发时机：`USER_MESSAGE_RENDERED`（用户发消息、生成前必触发）+ `MESSAGE_SWIPED`/`MESSAGE_UPDATED`
   （重掷/重新生成）+ `window focus` + `visibilitychange`（切回 ST tab）。
3. **`logInjectedMemory(data)`**：挂 `GENERATE_AFTER_COMBINE_PROMPTS`，每次生成后 console 打印
   "Latest memory injected into prompt: YES/NO"，便于与服务器日志（`Chat Completion request`）对照。

验证方式：重启 ST + Ctrl+Shift+R 硬刷新 + 保持单 tab；走一轮 8 回合自动摘要后，看浏览器 console
的 `[MidTermMemory] Latest memory injected into prompt: YES`，并核对 ST 服务器日志下一次请求的
`<User State>` 块内容 = 最新摘要。

## 8. 备选修复方案（未实施，待确认）

让注入**自愈**——每次生成前把 `extension_prompts[INJECT_TAG]` 重新对齐到 chat 里最新 memory：

1. 监听 `USER_MESSAGE_RENDERED`（script.js:5853，用户在生成前必触发）→ `setMemoryContext(getLatestMemoryFromChat(chat), false)`。
2. 监听 `window focus` / `visibilitychange` → 同样重同步（覆盖"另一实例写好摘要、切回来生成"）。
3. 加保护：`inApiCall` 期间跳过；仅当 chat 最新 memory ≠ 当前注入值才重写，避免覆盖用户正在编辑的文本框。
4. 观测：在 GENERATE_AFTER_COMBINE_PROMPTS 时 console 打印本次实际注入的 memory 值，便于对照服务器日志。

---

## 9. 常用命令

```bash
# 服务器请求日志（真实 payload）
tmux capture-pane -t st-8k -p -S -200

# Firefox 窗口
ssh d3180 "export DISPLAY=:0; xdotool search --class firefox getwindowname %@"

# 会话恢复文件里 tab 列表（mozLz4 格式）
# 见 debugs 过程：recovery.jsonlz4 头部 = 'mozLz40\0' + uint32 LE 长度 + lz4.block

# chat 文件
data/default-user/chats/Leer乐儿/Leer乐儿 - 2026-08-16@02h31m41s631ms.jsonl

# ST 端口
ss -tan | grep -E ':8888|:2333'
```