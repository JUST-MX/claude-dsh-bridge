# claude-dsh-bridge

把 **Claude Code 会话**接进 **DeepSeek Harness**：在 DSH 里一屏看到所有 Claude 会话的状态，
点开就在右侧面板里对话，不用再 alt-tab 找窗口。

> 这是一个 **DSH 插件**，方便管理你的claude shell，前提是你装了claude；
> 众所周知的原因cn当前不便用cc客户端，那让你cc里的ds回到自己家里有什么问题？

---

## 一句话结论
实现方式是 **DSH 自己用 Claude Code 的 SDK 模式起常驻会话**
（`claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`），
不是扫别人的 transcript，也不是 `claude --bg`。

- Claude 桌面端在国区登录被墙（`claude.ai` 302 → `app-unavailable-in-region`），
- DSH 本身就是个可插拔的 agent 宿主，**已经有面板槽位、进程服务、会话持久化**。
- 边界：**只跟踪从 DSH 里打开的 CC 工作项**，外面自己开的 pwsh 不管。
  → 这使常驻进程成为唯一正确底座（状态精确、可批准、可打断）。

论证见「已知边界」与 `tools/probe-*.mjs` 里每条实测（每个探针文件头都写了它推翻或确认了什么）。

---

## 它能做什么

左侧栏多出一个 **Claude** 图标（order 20，排在 Plugins / Schedules 之后），
点开是左右分栏的页面。

| 能力 | 说明 |
|---|---|
| 新建工作项 | 弹原生目录选择器，在选中目录里起一个常驻 `claude -p` 会话，标题自动取目录名 |
| 列表 | 每个会话一行：状态点 + 标题 + 模型标签；第二行 `状态 · 轮次 · 步数`；第三行 `上一轮 token · 上下文 已用/上限` 加一条占比条；标题行右侧是这一轮的时钟（运行中逐秒走，结束后显示上一轮耗时）。列表栏用侧栏底色，和右侧对话栏分开 |
| 状态 | 六种：空闲（蓝）/ 运行中（绿）/ 等待批准（橙）/ 已拒绝（红）/ **接口错误（红）** / 已结束（灰空心），圆点与徽章同一套 |
| 重连 | CLI 每次重试 API 都落一行 `重连 · attempt n/m · retry in Xs · 原因`，端点挂住时写 `no response in 25.0s` —— 以前这些只在终端里看得见 |
| 详情 | 目录、批准方式（手动/自动）、轮次、最后活动、开始时间，用 `·` 分隔 |
| 对话记录 | 按重要性分四档：低了斜体灰（思考/生命周期）、中了正体次色（工具往来）、高了正体主色（双方的话）、答案是紫色大字 |
| 记录窗口 | 读最近 120 行，但**会往回补到最近一条提问**：长回合有几百条过程行，硬切会让窗口从回合中间开始，第一条孤儿行曾被当成提问（`up after 4s` 是 shell 输出）。补得超过 400 行就放弃补 |
| 每轮折叠 | 一轮结束自动收成一行「标题 + N 步」，点开看过程；**正在跑的那轮默认展开，但也能点标题折起来**（折叠状态会一直保持到这一轮结束，下一轮开始重置），折起来时标题旁标「进行中」。**问题那一行在滚动时钉在顶部**（sticky），长答案滚到底也看得见自己问的是什么。钉住的是**灰色磨玻璃**：半透明灰底 + `backdrop-filter` 模糊 + 一条下边线，底下滚过的行看得见在动，才读得出来这是浮在上面的图层（深色主题用白色薄涂，不是黑） |
| 收起 / 展开 | 答案右侧一个图标 + 黑色加粗的「展开全文 · N」/「收起」（chevron 随状态朝下或朝上）。**短到折起来什么也藏不住时不出这个控件** |
| 接续提示 | 会话结束后再发消息，顶部浮窗按实际情况说「已续接上一次的会话」或「当前是新进程、只带了文本摘要」，**新会话第一次回答后自动消失** |
| 答案 | 最终答复（`result`）默认整段展开；长到折起来真的藏得住东西时出现「展开 / 收起」，**收起后固定两行**（约 44px，Markdown 与纯文本两条路径一致） |
| 长内容 | 过程行超过 600 字默认折成 8 行（底部渐隐），点「展开全文 · N」看全文，再点收起 |
| 滚动 | 打开工作项或内容变长时自动贴底——对话是往下长的。判据是**内容**不是行数：流式答复在同一行里变长，行数不变，早先按行数判断所以回复期间不会跟随；只有在读者自己往回翻时才停 |
| 输入 | 多行输入框，Enter 发送、Shift+Enter 换行。**草稿与附件按工作项各存一份**：在 A 里写了一半切到 B，B 的框是空的；切回 A 内容还在；发送永远只发给屏幕上这个会话 |
| 指令菜单 | 发送按钮左边一个「指令」按钮，列出 10 条常用斜杠命令（`/compact` `/context` `/cost` `/model` `/effort` `/rename` `/init` `/doctor` `/mcp` `/clear`）及一句话说明。**点一下只填进输入框，不发送**——要按回车才真的生效，误点最多按一次退格；带参的（`/rename` `/effort`）留一个尾随空格。`/clear` 标红、要点第二次才填入，第一次只在菜单里说明后果（会换 CLI 的 session id，上面这段对话再也 `--resume` 不回去）。清单是固定的：CLI 每次 `system/init` 报的 `slash_commands` 有 50 条且混着各种 skill 与别名，菜单不从那里取，其余命令照样可以直接手输 |
| 图片 | 粘贴（Ctrl+V）或拖入图片即成为附件：缩略图 + 角标删除，可只发图不发字。一张最多 5 MB、一条最多 6 张；非图片与超限会就地说明原因。附件以 base64 作为 user 消息的 `image` 块发出（`tools/probe-image.mjs` 用一张纯洋红方图验证模型真的看到了） |
| 审批 | 停靠时显示「请求执行 <工具>」，三个动作：允许 / 拒绝 / 本会话总是允许该工具 |
| 问题卡片 | `AskUserQuestion` 停靠时画成答题卡：选择题（单选/多选 + 选项说明）、填空题（`kind:"text"`）、数字题（`kind:"number"`，带 min–max 提示）。逐题答完才让点「发送答案」，答案随批准一起回给 Claude |
| 会话结束 | 顶上一行说明「已结束，发消息会重开新会话」；真的发下去时在同目录起新进程，把上一轮问答作为上下文交过去 |
| 切模式 | 按钮直接写目标状态「切换为 自动 / 切换为 手动」，实时下发 `set_permission_mode` |
| 打断 | 打断当前这一轮 |
| 停止 | 结束常驻进程，保留对话记录 |
| 移除 | 只对已结束的会话开放，连事件日志一起删；**红底实心按钮**，在按钮组最右 |

真实的中文界面（`node tools/dump-text.mjs zh` 的输出，逐字；这里取「等待批准」一屏）：

```
  Claude Code 工作项
  只显示从这里打开的常驻会话；你自己在终端里开的不会出现在这里。
  新建工作项
  示例工作项
  demo · 等待批准 · 3 轮
  示例工作项
  等待批准
  目录: C:\work\demo
  批准方式: 手动
  3 轮
  最后活动: 15:48:40
  开始时间: 15:46:40
  切换为 自动
  打断
  停止
  [disabled] 移除
  请求执行
  Write · C:\work\demo\report.md
  允许
  拒绝
  本会话总是允许该工具
  >
  帮我把报表写出来
  5 步
  完成
  报表已写好，放在 report.md。
  [placeholder] 给这个会话发消息…
  [disabled] 发送
```

同一屏在会问问题时变成：

```
  Claude 需要你回答
  格式
  用哪种格式导出？
  单选
  PDF
   便于分享
  CSV
  范围
  要包含哪些工作表？
  可多选
  汇总
  明细
  [disabled] 发送答案
  拒绝
```

---

## 怎么装

```powershell
plugin_manager action=install_bundle target=<这个包目录的绝对路径>
```

装完在 Plugins 页能看到 **Claude Code Sessions**，启用即可。
**不需要手改 profile** 的 `package.json` 或 `cordis.patch.yml` —— `install_bundle`
自己会写 `dsh.profile.bundles` 和依赖链接。

改完 Host 代码后重载：

```text
plugin_manager set_plugin target=include:claude-sessions enabled=false
plugin_manager set_plugin target=include:claude-sessions enabled=true
```

**但新增一个 Remote 方法时，这个往返是不够的 —— 必须整个退出 DSH 再打开。**

`typert-loader` 的源码里写得很直白（`lib/index.js` 文件头）：

> Package verdicts and imported manifests are cached per package name and **never
> expire** — plugin-set changes take effect on restart.

它用 `loadManifest(pkgName, path)` 把 `./typert` 的 import 结果存进一个
`Map`（键是包名，**没有任何 delete/clear 路径**），而底层是裸 `import()`，
Node 的 ESM 注册表按 URL 也缓存。所以：

| 改了什么 | `set_plugin` 往返够吗 |
|---|---|
| `index.js`（Host 逻辑、工具描述、服务方法体） | ✅ 够 —— 会被重新 import |
| `client.js`（面板） | ✅ 够，另外再刷新一次页面 |
| **`typert.js` / `remote.js`（新增/删除/改签名的 Remote 方法）** | ❌ **不够，必须重启进程** |

症状很好认：**旧方法全正常，只有新方法报 404**：

```text
client api: claudeSessions/answer failed: transport failure for /api/claudeSessions/answer: HTTP 404
```

因为 Gateway 对"没人认领的 endpoint"一律返回 404（`dsh-api-gateway` README：
"returns 404 for unclaimed requests"），而这个 endpoint 在进程启动那一刻注册的
清单里根本不存在。

跑一下就能判断当前进程是不是旧的：

```powershell
powershell -NoProfile -File tools/check-manifest-stale.ps1
```

它比较 DSH 进程的 `StartTime` 与 `typert.js`/`remote.js` 的 mtime —— 晚于进程启动
就说明运行中的清单落后于文件，退出重开即可。

Client 代码改了不必重载：`client-hmr` 每 500ms 轮询 bundle 的 mtime，
`gen-typert.mjs` 写盘后页面自己换。重复 `install_bundle` 会报 `already-installed`，
用上面的往返重载即可。

> **重载的完整口诀**：
> 改逻辑 → `set_plugin` 往返；改界面 → 再刷新页面；
> **改线协议（方法增删改）→ 只能退出 DSH 重开**，`tools/check-manifest-stale.ps1`
> 会告诉你现在这次是不是踩在这条上。

---

## 目录

```
claude-dsh-bridge/
├── README.md                  ← 你在这（交付说明）
├── plugin/packages/claude-sessions/   ★ 插件包（双端完整）
├── providers/                 端点配置样例（未被任何代码引用）
└── tools/                     生成器与守卫
```

---

## 架构

```
plugin/packages/claude-sessions/
├── package.json          双面包：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      插入一行 id: claude-sessions
├── index.js              Host 半边（~830 行，手写）
├── src/client-body.js    Client 半边源码（唯一手写源）
├── typert.js   ──┐
├── remote.js     ├─ 由 tools/gen-typert.mjs 生成
├── client.js   ──┘
└── locale/{en,zh}.json   由 tools/gen-locale.mjs 生成
```

**Host 半边**（`index.js`）：`export function apply(ctx)`，`inject = ['subprocess','tools']`。
持有 `Map<id, WorkItem>`，每个 WorkItem 一个常驻 `claude -p` 子进程。
对外两部分：一个 `claudeSessions` Service（`typertRemote` 绑定给 Remote 网关）
和一个 `claude_session` 工具（给模型用）。

**Client 半边**（`client.js`）：`window.__ModuleLoader__.load({ id, factory })` 包装。
`apply(ctx)` 里 `ctx.remote.$mount(TYPERT_REMOTE)` 挂 Remote 命名空间，
然后 `ctx.inject([...], applyPanel)` 在子插件里注册两个槽位：

- `sidebar.panellist` → `id: claude-sessions`（侧边栏图标）
- `main` → `key: claude-sessions`（主区面板）

**唯一手写源是 `src/client-body.js`。** 三个 JS 产物与两个 locale 文件都是生成的。
**不要手改生成物**，改完源码跑一次生成脚本。

## 它不仅能开，还能改

第二轮按真实截图逐项改了界面（清单见下方两节）。
第三轮是用户点回答之后又提的六条（见下方「允许、折叠与端点」一节）：

| 改动 | 做法 |
|---|---|
| 左右分栏区分度 | 列表栏改用 `--dsw-specific-sidebar-fill`，对话栏留 `--dsw-alias-bg-base`，中间 `0.5px --dsw-alias-border-l3` —— 照抄 layout 包自己的分栏（`dsh-client-ui-layout/lib/client.js`） |
| 字号/颜色分级 | 四档：低（斜体 + `label-tertiary`，思考与生命周期）、中（正体 + `label-secondary`，工具往来）、高（正体 + `label-primary`，Claude 的话）、答案（**紫色 + 13.5px**） |
| 你的提问 | 深蓝（`--dsw-static-deepseek-500`，暗色取 400 档），加粗 —— 比「高」档更重，因为那是整段对话的主线 |
| 每轮结束自动收起 | 一轮 = 一条一行标题 + 步数，点标题展开过程；正在跑的那一轮不收起（否则唯一的活动反馈也没了） |
| 答案全量展示 | `result` 行默认整段可见，并铺一层 9% 的紫色底；超过 300 字出现「收起」，收起后仍留 12 行 —— 过程行和答案是**相反默认值**：过程默认折、答案默认开 |
| 时间戳 | 标题里始终有这一轮的起始时刻（收起也看得见），展开后每行左边另有自己的时刻 |
| 每轮用量 | 答案下面一行：`耗时 24s · 输出 758 · 未缓存输入 31204 · 缓存读取 30720 · 31.5 tok/s` |
| 状态五色 | 空闲蓝、运行绿、等待/暂停橙、终止/异常红、结束灰（列表圆点与详情徽章同一套） |
| **接口重连** | CLI 的重试循环（`system/api_retry`）原被丢弃，端点断了只显示「运行中」+ 空白记录。现在每次重试落一行「重连 · attempt n/m · retry in Xs · 原因」，卡住时显示 `no response in 25.0s` |
| **接口错误** | `terminal_reason:"api_error"` 单独成为一态（`error` / 接口错误，红），不再被当成「已拒绝」——被拒的是权限，这里坏的是端点 |
| 会话结束后继续对话 | `send()` 不再抛 `is not running`，而是重开进程：CLI 自己的 transcript 还在就直接 `--resume <sessionId>`（模型拿到的是**真实对话**，含工具调用与结果）；transcript 没了才退回「把上一轮问答塞进第一条消息」。两种都在对话框顶部写明当前是新进程 |
| Markdown | 答复按 Markdown 渲染：表格（含分隔行的对齐）、有序/无序列表（一级嵌套）、1–6 级标题、围栏代码（保留语言标记、横向滚动）、行内代码/粗体/斜体、引用与分隔线。不认识的语法原样显示；**工具输出与流式答复不解析** |
| 实时输出 | 启动参数带 `--include-partial-messages`，模型写一个字长到面板上就长一个字（Host 聚成一条 `streaming` 行进 `read()`，不进日志；块结束时由 `assistant` 行接管）。行尾有闪烁光标 |
| 重命名 | 点详情标题就地改名，Enter 保存 / Esc 取消；写进 `.meta.json`，重载后保留 |
| 筛选 | 工作项多于一个时列表顶部出现筛选框，按标题 / 目录 / 状态过滤；无匹配时明说 |
| 会话信息 | 列表行显示模型（悬停看全名）、整行悬停显示完整目录；详情页显示会话 id（点击复制）与累计花费 |
| 已放行工具 | 审批卡片下方列出本会话已记住的工具，不必翻事件日志才知道为什么没再问 |
| 允许智能体仍显示未作答 | 见下节：`AskUserQuestion` 要的是答案，不是批准 |

### 每轮用量是 delta，不是累计

CLI 的 `result` 记录里 `usage` 是**整个进程累计**的：第 3 轮报的是 1–3 轮之和。
直接印上去会单调增长，最后一轮看着像个天文数字。所以 Host 在 `turnUsage()` 里
记住上一次的累计值并相减，只把这一轮的增量挂到 `result` 行上。

`tok/s` 沿用 DSH 对话区自己的规则（`formatTokensPerSecond`，见
`dsh-client-ui-chat`）：十以上取整、十以下保留一位小数；分母是
`duration_ms - ttft_ms`，即「真正在生成的时间」，而不是含排队与首字等待的墙钟。
换新进程（会话结束后重开）时累计基线会一起归零，否则新进程第一轮算出来的增量是 0，
用量行会静默变空。

---

## 线协议

十二个 Remote 方法（`tools/api-spec.mjs` 是唯一真源，两份面由 `check-remote.mjs` 校验一致）：

```
list()                                  → { items }
read(id, limit?)                        → { item, rows }
start({ cwd, title?, mode? })           → { item }
send(id, text, attachments?)            → { item }
approve(id, remember?)                  → { item }
deny(id, message?)                      → { item }
answer(id, answers)                     → { item }
rename(id, title)                       → { item }
setMode(id, mode)                       → { item }
interrupt(id)                           → { item }
stop(id)                                → { item }
forget(id)                              → { ok }
```

三条容易踩的：

1. **返回值是信封，不是裸值**：`{ ok: true, value }` 或 `{ ok: false, error }`。
   按裸值读会把 `undefined` 传下去 —— 这正是白屏的根因。
2. **可选参数是位置参数，不是可省**：网关按**实参个数**校验，
   `deny(id)` 少一个直接抛。必须写 `deny(id, undefined)`。
3. **不能叫 `remove`**：和网关的命名空间服务撞名，改名 `forget`。

审批不走 Remote：它是 `control_request{can_use_tool}`，Host 停靠后由面板点「允许/拒绝」，
再写回 `control_response`。`answer` 是同一条通路的**不同载荷** —— 它多带
`updatedInput.answers`，所以是独立方法而不是 `approve` 的第四个参数：
面板只有在这个停靠请求确实带题时才敢画选择卡片。

---

## 数据落在哪

```
<DSH_HOME>/storages/claude-sessions/
├── <id>.meta.json    头：id/标题/目录/模式/sessionId/开始时间/allowRules
└── <id>.jsonl        事件日志，一行一条，append-only
```

事件的 `kind`：`opened` `reopened` `user` `init` `thinking` `tool-use` `tool-result`
`tool-error` `approval-requested` `approval-answered` `policy` `assistant` `result`
`mode` `retry` `notice` `api-error` `interrupt` `stopped` `exit` `denied` `stderr`。

**为什么要有这份日志**：它是面板的权威回放源 —— CLI 的 transcript 里有图片、附件、
`api-request` 之类面板不渲染的记录，而这条日志只存面板真的要画的东西。
（早期结论「`-p` 不写 transcript」已**被实测推翻**：2.1.310 会写，`--resume` 可用。
重开时优先走 `--resume`，日志仍然是列表、轮次、用量的来源。）

**重载时日志比文件头权威**：模式切换是追加的 `mode` 行，最后一条即当前值。

---

## 怎么验证

```powershell
node tools/check-all.mjs
→ ALL OK — 14 guards
```

| 守卫 | 抓什么 |
|---|---|
| `--check` ×2 | 语法 |
| `find-backtick.mjs` | CSS 注释里的反引号会提前结束模板字符串，报错行还指在无关的地方（已经踩了四次，单独一道） |
| `check-css.mjs` | 括号失衡；声明漏 `;`；用了没有规则的 class、写了没人用的规则 |
| `scan-text.mjs` | 文字损坏（`?` 代替破折号/箭头、U+FFFD），**自带 7 样本自测** |
| `check-theme.mjs` | `var(--dsw-…)` 写了主题没公布的 token（CSS 只会静默回退）；`var(--ccw-…)` 读了自己没声明的名字。色板现在直接从主题包读（403 个），不再手抄 |
| `check-locale.mjs` | `t('key')` 有调用没词条、有词条没人用、中英不对齐 |
| `check-remote.mjs` | 两份面同源、实参个数、Host 服务绑定、locale 与 `DICT` 一致 |
| `render-client.mjs` | 面板能渲染；拒绝信封和裸载荷都不炸 |
| `click-through.mjs` | 136 项：每个控件点下去发出什么 Remote 调用；一轮结束收起成一行、答案默认不折叠但超过 300 字可手动折（折起仍留 12 行、用量行不丢）、展开后过程行能再折；跑着的那轮不收起；前导行（`opened`/`init`）不单独成轮、标题永远是提问；**收起/展开都带时间戳**；**答案下面有用量行**；**重连行与接口错误行**（错误的收尾不画成答案、状态徽章是 `error` 不是 `denied`）；答题卡三种题型（单选/多选/填空/数字）都能画、逐题答完才让发、载荷按题干 key、多选拼成逗号串；轮询不重复；长行默认折叠并能展开；对话记录跟随滚动；**流式答复行**（不折叠、无开关、按「claude」标注）；**重命名**（空标题不可保存 / Esc 取消 / 载荷）；**列表筛选**（按标题收窄 / 无匹配提示）；**已放行工具**列表；会话 id 与花费；**输入框旁的指令菜单**（10 条常用斜杠命令、点一下只填进输入框不发送、带参命令留尾空格、`/clear` 标红且要点两次、警示文案先说后果）；**草稿按工作项分开**（A 里写的字切到 B 是空的、切回 A 还在、发送只发给屏幕上这个） |
| `host-test.mjs` | 187 项：假 `ctx` 装真 Host，六态机 / 审批 / 记住 / 拒绝 / 问题作答（含 text/number 题型）/ **重连记录（次数、等待、HTTP 码、挂住时的 no_response）/ 合成接口错误不冒充答复 / api_error 收尾不记为已拒绝 / 只留有行动价值的提示** / **每轮用量取增量、重开后基线归零、重载后用量仍在** / 重开已结束会话（无 transcript 时走 primer，有则 `--resume` 且不重复上下文）/ **流式增量：可见、不进日志、块结束被 assistant 行接管、一条答复仍只有一行** / **rename 落头 + 空标题拒绝** / 模式 / 重载全走一遍（含 init 行优先于旧头恢复 sessionId） |
| `live-ui-test.mjs` | 41 项：**真浏览器**（headless Edge/Chrome）里跑真 bundle —— 点「收起」后答案的实际高度（523px → 44px，两行）、纯文本答案走另一条规则同样能折、**问题行 sticky 后滚到底仍在顶部、磨玻璃在明暗两套主题下的半透明/模糊/边线**、**resume / primer 两种浮窗各自的措辞、回答后消失**、**短答案不出折叠控件**、粘贴图片出现缩略图与文件名、只发图也能发、`send()` 收到的 base64 载荷、发送后附件清空、**流式答复变长时视口跟随到底**（行数不变、高度 1433→2009px）、**指令菜单朝上展开且压在对话之上**（实测 boxBottom 394 < buttonTop 401）、`/clear` 算出来的颜色确实是错误色、**指令菜单压在磨砂提问层之上**（按两层实际重叠区域做 `elementFromPoint`：把 composer 改回 `z-index: 2` 时这一条会真的失败）。这一道专门抓 Node 夹具看不见的三类问题：**CSS 规则没赢级联**、**事件没接上**、**算出来的颜色根本没生效**（页面里必须注入主题包，否则 `color-mix()` 全是无效值、透明通过） |
| `markdown-test.mjs` | 31 项：表格行列与对齐、标题/列表/围栏代码/引用、未闭合围栏不吞后文、散文里的竖线不是表格、**工具输出不解析**、**流式行不解析**、标识符里的下划线不是斜体、纯文本仍走单 span |
| `dump-text.mjs` | 不是断言，是把面板会画的每个字打出来（5 个场景 × 2 语言，其中一条会**展开折叠的一轮**，否则看不到过程行长什么样；截不了图时用它看界面） |

生成物：

```
node tools/gen-typert.mjs     # typert.js / remote.js / client.js
node tools/gen-locale.mjs     # locale/en.json / locale/zh.json
```

---

## 真机验证到哪一步

| 交互 | 证据 |
|---|---|
| 新建 → 目录选择 → start → 列表出现 | ✅ 亲手操作，`title` 恰为 `baseName(cwd)` |
| 发送 → 停止 | ✅ 同上一条会话 |
| **允许** | ✅ `approve-probe.txt` 落盘，字节 `79 75`（= `OK`，无 BOM 无换行）；批准前文件不存在 |
| **拒绝** | ✅ `deny-probe.txt` **仍然不存在**；Claude Code 回 `tool_result{is_error:true}` 并自述"文件没有创建成功" |
| **切模式** | ✅ 日志出现 `mode: manual`，文件头同步重写 |
| **打断** | ✅ 并因此抓出「孤儿审批」bug（见下） |
| **移除** | ✅ `stop` → `forget` 后 `.jsonl` 与 `.meta.json` 两个文件都不存在了 |
| **会话结束后继续对话** | ✅ 对已结束的工作项直接发消息：日志出现 `[reopened] 21 prior line(s) as context` → 新 `init`（新 sessionId）→ `[assistant] 收到` / `[result] 收到`。即没有 `--resume` 也把上下文接上了 |
| **问题停靠** | ✅ 一个测试工作项停在「苹果/香蕉」这题上，`list()` 报 `waiting-approval ← AskUserQuestion` |
| **问题作答** | ✅ 用户在面板上选「草莓」并按「发送答案」，Claude 回 `你选择了**草莓**`，日志出现 `approval-answered · answer: 水果偏好: 草莓`（这条同时证实了 404 的原因只是进程清单太旧，代码本身是对的） |
| **每轮用量** | ✅ 同一轮的 `result` 行带着 `耗时 / 输出 / 未缓存输入 / 缓存读取 / tok/s`，与 DSH 对话区的口径一致 |

审批两条分支走的是**完全不同的载荷**（`{behavior:'allow'}` vs `{behavior:'deny', message}`），
现在各有一次真机证据。

---

## 已知边界

| 项 | 状态 |
|---|---|
| `bypassPermissions` | 用不了 —— 除非启动就带 `--dangerously-skip-permissions`。所以「本会话总是允许」是 Host 侧 `allowRules` 记忆，不是真正的 permission mode |
| 像素级外观 | 文字逐字核对过；颜色只核对到"用的是主题里真实存在的 token"，**没有**在屏幕上验证过对比度 |
| 截屏 | 在本机做不到：`SetForegroundWindow` / `SetWindowPos(HWND_TOPMOST)` / `PrintWindow(PW_RENDERFULLCONTENT)` 全返回 `False` |
| ~~会话恢复~~ | ✅ **已改**：`-p` 其实会写 `~/.claude/projects/<slug>/<id>.jsonl`（CLI 2.1.310 实测，见 `tools/probe-resume.mjs`），重开时先探这个文件在不在，在就 `--resume`。transcript 不在（换机、清过 `~/.claude`）才退回旧办法 |
| 退回时的上下文上限 | 只在 transcript 缺失时才有这一条：只带最近约 4000 字符（每条最多 600 字） |
| 问题作答的真机验证 | 停靠这一半已真机确认（`cc-askprobe` 上 `waiting-approval ← AskUserQuestion`，现仍停在「苹果/香蕉」这题）；**回传答案**这一半只验到载荷形状（从 `claude.exe` 读出的 `updatedInput.answers`），还没在面板上点过一次「发送答案」 |
| profile 里的历史残留 | `cordis.patch.yml` 末尾有两行 `- id: cc-diag / cc-probe3` + `disabled: true`，是早期探针留下的空操作条目（指向不存在的 entry，无害）。沙箱不允许写 `%USERPROFILE%\.dsh`，需要的话手动删掉那 4 行 |

---

## 踩过的坑（值得记住的）

1. **网关返回信封**，按裸值读 → 白屏。10 个调用点全走 `unwrap()`。
2. **可选参数按位置校验**，`deny(id)` 少一个直接抛。
3. **`find()` 返回 `undefined`**，三元里却写 `null` → 每个轮询 tick 抛一次 → 红字常驻。
4. **轮询 effect 被自己的依赖项重启成热循环**：`list()` 返回新快照 → `setSelected` 换身份
   → `refresh` 重建 → effect 重装 → 立刻又 `list()`。把选中 id 放进 `useRef` 才对。
5. **孤儿审批**：在 `waiting-approval` 上打断，日志是 `approval-requested → interrupt →
   tool-error → result`，**没有 `approval-answered`**，`pendingApproval` 就挂着不清 ——
   面板继续显示可点的允许/拒绝，点下去发出 `request_id` 无人监听的 `control_response`。
   修法：`result` 到达时清空（一轮结束，这轮挂起的审批按定义不存在了）。
6. **PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM 并把 UTF-8 当 GBK 重解码**，
   把整个文件的中文毁成乱码、破折号变 `?`。改文件用 `write`/`edit` 工具，或
   `[System.IO.File]::WriteAllText(path, text, New-Object System.Text.UTF8Encoding($false))`。
7. **`t('key')` 缺词条时屏幕上会直接画出 key 本身**；`var(--typo)` 只会静默回退。
   这两类"资产与代码脱节"只能靠专门的守卫抓。
8. **夹具的错会伪装成被测对象的错**：桩返回裸值、`useMemo` 不记忆化、`mount()` 不卸载、
   前置状态污染（用被 `allowRules` 记住的工具测"停靠"）。每次修夹具都要先确认它**能红**。
9. **批准 ≠ 作答**。`AskUserQuestion` 的答案是从**入参**读的，`{behavior:'allow'}` 原样打回
   只会让 Claude 收到「The user did not answer the questions.」—— 这个症状看起来像"UI 没提交"，
   实际是**协议层缺字段**。证据只能从 CLI 本体里读（`grep-cli.mjs` 分块扫 296 MB）。
10. **在一个已经结束的会话上打字不是错误，是"重开"**。旧 `send()` 抛
   `work item … is not running`，看起来像 bug，其实是把"没有进程"当成"非法操作"。
11. **沙箱里子进程不能带管道**（`probe-stdio.mjs` 实测 `EPERM`），所以任何
   `spawnSync(..., {encoding:'utf8'})` 都会报 `status: null`；守卫必须用 `stdio:'inherit'`。
    真正要起 `claude` 的是 DSH 自己（Host 半在 DSH 进程内 spawn，不受这条限制）。
12. **一次拒绝会在流上出现两次**。`system/permission_denied`（带 `tool_name`）和模型读到的
    那条 `tool_result`（`is_error:true`）内容完全相同 —— 实测 1509 字节，两行相隔 1 条记录。
    两条都记就是同一段话印两遍。按**原文**去重（不是按前缀），第一份带工具名，留下它。
13. **CLI 为模型写的拒绝正文不能直接给人看**。末尾那句
    "If you have other tasks that don't depend on this action… IMPORTANT: You *may* attempt
    to accomplish this action using other tools…" 是对 Claude 的指令；1509 字节里只有 60 字节
    在说发生了什么。CLI 自己按同一个哨兵切开（`CPo` 函数），面板照做：只留 `Reason: ` 到
    `. If you have other tasks` 之间。
14. **被拒不会结束这一轮**。实测 `cc-mvyml3x4-4`：11:04:02 被分类器拒写 `settings.json`，
    Claude 接着干别的，11:04:45 用户手动停止 —— 这一轮既没有 `result` 也没有别的可见痕迹，
    面板只剩一个「N 步」的折叠标题。所以折叠标题必须带标记（`1 次被拒` / `有报错`）：
    折起来看得见的东西，才是真的看得见。

---

## 附带的东西

即使不用插件，`tools/cc.ps1` 也能解决"多 shell 窗口管理"（面向 `claude --bg`）：

```powershell
cd D:\your\repo
powershell -File <本项目>\tools\cc.ps1 new 登录重构   # 建 worktree + 开新窗口跑 claude
powershell -File <本项目>\tools\cc.ps1 ls             # 一屏看后台会话 + 所有 worktree
```

> ⚠️ 本机**没有 pwsh 7**，上面用 `powershell`（5.1）。另外 `--bg` 需要目录已 trust 且
> `~/.claude/jobs` 可写 —— 两条当前都不满足，所以 `bg/at/log` 暂时用不了。
