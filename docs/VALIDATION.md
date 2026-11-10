# Validation and supported scope

## 2026-11-10 更名为 Plexus（0.3.0）

项目从 Cooperation（仓库 codex-claude-bridge）更名为 Plexus，以符合“不限客户端、自由拓扑”的定位。本条之前的记录保留当时的名称（`coop`、`.cooperation`、`COOP_*`、MCP 服务名 `cooperation`），对应关系见 README“从 Cooperation 升级”。

- 命令与脚本：`bin/coop*.mjs` → `bin/plexus*.mjs`；MCP 服务名、OpenCode 插件工具前缀、环境变量、管理页请求头、wrapper 自身请求 ID 前缀、页面本地存储键一并改名。版本升至 0.3.0。
- 数据：首次以新版本启动时，安装目录的 `.cooperation/` 移为 `.plexus/`。若 `.plexus/` 已被部分创建，只移动不冲突的项并在管理页列出留下的项；已有数据库时不再迁移。安装目录内未完成维护流程的交付文档路径随之更新；提示词设置中仍为旧默认标签的部分改为新标签。
- 兼容：启动与关闭脚本能识别并停止更名前仍在运行的服务；OpenCode 原生会话的创建核对同时识别新旧 metadata 键；页面已保存的偏好迁移到新存储键。
- 测试：新增 `test/rename-migration.test.mjs`（3 项），覆盖整体迁移、部分迁移与留存报告、服务启动时的迁移与交付路径更新。全量 451 项中 450 项通过，未通过的仍是启动脚本测试（代码页问题）。前一次全量运行中，一项启动真实进程的计时测试在满载时超时一次，单独重跑 3 次均通过。

## 2026-11-10 资源占用优化

用户要求降低资源占用和存储读写，提高响应速度。管理服务当时未运行，以下测量都在本机真实数据的副本上进行，没有启动线上服务。

**发现与修复**：

- **wrapper 注册文件**：`.cooperation/claude-wrapper/instances` 中有 515 个注册文件，其中 502 个所属进程早已退出（面板被强制关闭时 wrapper 来不及删除）。每个离线 Claude 会话（46 个）每 10 秒采样一次，每次都要读取并解析全部 515 个文件。实测一轮采样需要 23,598 次文件读取、7.7 秒，这也是启动和状态更新缓慢的主要原因。
  - 改为全进程共用一份索引（`src/claude-instance-registry.mjs`）：目录修改时间不变且索引不超过 1 秒时直接复用结果。
  - 扫描时删除 wrapper 进程或 Claude 进程已退出的注册文件；名称不符合 wrapper 格式的文件不删除。
  - 实测：首次扫描 0.64 秒，清理后剩 3 个文件；之后 46 次查询共 14 毫秒。
  - wrapper 的注册文件现在只写定位信息，只在会话 ID 或初始化状态改变时重写；以前工作中每个状态变化都会重写，最高每秒 10 次。
- **状态快照写盘**：以前每次采样都写一次 SQLite，`synchronous=FULL` 下每次都要刷盘，100 多个会话约每秒 10 次。现在只有采样时间以外的内容变化时才写盘，最新结果保存在内存中供读取。事务回滚的快照会在下次采样时重写。管理页也只在内容变化时收到通知；以前每次采样都会触发页面重新读取全部监控数据。
- **管理页轮询**：
  - `/api/monitoring` 从内存读取，策略、维护流程、队列状态都改为整表查询各一次（以前每个会话五六次查询），8.5 → 1.8 毫秒/次。页面定时刷新从 2.5 秒改为 5 秒，内容变化另有即时通知。
  - `/api/messages` 返回修订号，内容未变时只回复“未变化”。以前每次都完整读取并解析全部 832 条消息，约 43 毫秒，并返回全部正文。
  - 会话发现由后台监控每 15 秒做一次，列表变化时通知页面；页面的定时刷新复用 15 秒内的结果，手动刷新仍重新扫描。
- **消息暂缓重试**：接收会话未就绪时，以前每 2 秒重试一次，每次写入两条事件并通知页面重读消息列表（库中已累计 1,149 条 `dispatch_deferred`）。现在按 2、4、8、16 秒退避；接收会话的连接、活动、设置同步或额度状态一变化，就在下一个 2 秒周期立即重试。
- **PowerShell 进程核对**：同一（PID，启动时间）的核对结果从保留 30 秒改为 5 分钟。进程退出仍由每次读取时的 `alive()` 立即识别，发消息前的严格核对不变。以前只要有 Claude 会话在运行，就每 30 秒启动一次 PowerShell。
- **wrapper 输出处理**：
  - 上下文通道以前把每个输出块拼接到整个缓冲区上，超长行（大的工具结果）的复制量是平方级。实测 10 MB 的行按 64 KB 分块：383 → 5 毫秒。
  - 上下文通道只解析可能是自身回复的行（含 `control_response` 和 `cooperation-`）；可见消息模块只解析含 `"isReplay"` 的行。其余行原样转发，不再重复解析。
- **MCP 与命令行进程**：`bin/coop.mjs` 只在 `serve` 时加载管理服务模块。每个 Claude 会话的 MCP 进程工作集 63.5 → 57.5 MB，启动 217 → 164 毫秒；`coop notify` 等一次性命令同样受益。
- **其他**：
  - 目录访问策略缓存 1 秒，以前每次采样都读文件。
  - `cycles` 表增加 `session_key` 索引。

**测试**：新增 `test/resource-usage.test.mjs`（4 项），覆盖注册文件清理与索引、快照只在内容变化时写入、暂缓消息的退避与提前重试、消息列表修订号；`claude-context-channel` 增加一项分块长行测试。可见消息测试改为从 `/status` 读取状态，并允许 wrapper 自身的只读查询。全量 448 项中 447 项通过；未通过的一项仍是启动脚本测试，原因是 cmd 无法解析中文脚本名（代码页问题），与本次改动无关。

**生效方式**：管理服务和管理页的改动在重启服务、刷新页面后生效；wrapper 的改动在重新打开 Claude 面板后生效。首次启动时会删除 502 个过期注册文件。

## 2026-11-07 会话接口实测与显示修正

管理服务重启后做了实际测试：会话通过 MCP `session_interface` 取得自己的接口，再用 `coop notify` 给自己发消息。命令 1.2 秒返回；会话一直在工作，消息就在队列中等待。会话空闲后约 2.3 秒消息送达，开启了新的一轮，原生端确认已收到（`nativeDelivery.state: received`）。

用户发现这条消息在面板里的显示方式和平时 agent 之间的消息不同。核对结果：两者的传输路径相同，都经过同一服务端口、同一队列和 Claude 原生的跨会话收件通道。区别在于 wrapper 只把 `发送方：client://…` / `发送方地址：…` 格式的消息转换成带“【Cooperation 会话消息】”标签的气泡，外部程序的封装格式没有被识别，于是按原生样式显示。现在显示转换也能识别外部程序的封装，同样要求消息编号与原生消息 ID 一致，并且正文里只能有一个封装。新增 1 项测试，用真实的 `messageEnvelope` 输出验证。完整测试 443 项，442 通过，唯一失败的是既有的启动脚本测试。修正在 wrapper 中，Claude 面板重开后生效。

## 2026-11-07 响应延迟与上下文用量缺失

用户反馈：状态更新慢、启动后长时间等待；先打开并开始工作的 Claude 会话，在管理服务启动后拿不到上下文用量，必须中断才会显示。

**测量（改动前，运行中的服务）**：`POST /api/sessions`（会话发现）每次约 6.4 秒，其他接口都在 0.1 秒以内。管理页打开时和此后每 15 秒都会调用它，后台监控也每 15 秒做一次相同的发现，期间所有会话的采样都会停下来。当时唯一在线的 Claude 会话快照已经是 7.7 秒前的（设计刷新间隔为 2 秒），离线会话快照的中位数是 17 秒前（设计间隔为 10 秒）。

**原因**：

- 为了找会话标题，每次发现都把 Claude 对话记录从头读到尾。本机两个项目的对话记录分别共有 695 MB（最大一份 541 MB）和 395 MB。查找单个会话（发消息、页面操作）也同样全量扫描。
- 每个目录、每次查找都会启动 PowerShell 核对进程启动时间，每次约 0.35 秒。
- 后台监控的对话记录兜底读取，会把整份 Claude 记录逐行完整解析，但 Claude 记录里没有窗口大小，最终算不出百分比。
- 上下文窗口大小只在一轮结束时（`modelUsage`）或会话空闲时的原生查询中取得。会话在管理服务启动前就已进入长任务，就要等到这一轮结束才会显示百分比。
- 另外发现：Codex 现在把不活跃会话的记录压缩成 `.jsonl.zst`（本机 893 个压缩、3 个未压缩），而状态库里记的仍是 `.jsonl` 路径。51 个已发现的 Codex 会话全部因为找不到文件读不到用量。

**修复**：

- Claude 对话记录：按文件记下已扫描到的位置和已找到的标题、目录，之后只读新追加的字节；文件被替换或截断时从头重扫。已拿到目录后跳过超过 64 KB 的行（标题行都很短）。管理服务把这份缓存存到 `.cooperation/cache/claude-transcripts.json`。
- 进程核对：注册表每次照常实时读取，同一（PID，启动时间）的核对结果保留 30 秒，并发扫描排队共用一次 PowerShell。进程退出仍由每次的 `alive()` 立即识别；发消息前的严格核对（`validateProcessLifetime`）保持不变。
- 页面和后台监控同时发起的发现请求共用一次扫描，只缓存扫描结果 2 秒；策略、监控、队列信息每次仍实时读取。Codex 状态库和 OpenCode 注册文件的并发读取也合并为一次。
- Claude 兜底读取改为只读末尾 4 MB，文件不变就不重读。窗口之前的压缩记为 `contextEpoch: 'unknown'`，不冒充初始状态；Claude 会话的压缩核对本来就使用 wrapper 状态，不读对话记录。
- Codex 支持 `.jsonl.zst`：按（文件，大小，修改时间）只解压一次，结果存到 `.cooperation/cache/codex-archives.json`；会话恢复后写出未压缩文件时自动切换过去；投递核对不读取压缩文件。
- wrapper：会话已有用量但还不知道窗口大小时，即使正在工作，也在行边界发一次 `get_context_usage {detail: 'summary'}`（原生用最近一次回复的用量和本地估算作答，不调用 token 计数 API），失败最多每 30 秒重试一次。空闲时的完整查询保持不变。

**测量（改动后，同一台机器、同一批目录）**：

| 项目 | 改动前 | 改动后 |
| --- | --- | --- |
| 完整会话发现 | 每次约 6.4 秒 | 首次 2.2 秒，之后约 0.14 秒，服务重启后约 0.5 秒 |
| Claude 发现（9 个目录） | 5.2 秒 | 首次 1.9 秒，之后 13–21 毫秒 |
| 查找单个 Claude 会话 | 整份记录扫描加 PowerShell | 约 5 毫秒 |
| Claude 兜底读取（8 个会话） | 逐行解析约 1.1 GB | 首次 160 毫秒，之后 4 毫秒 |
| Codex 用量（51 个会话） | 全部读取失败 | 首次 4.7 秒（只付一次，存盘），之后 8 毫秒；46 个有百分比 |

新实现与 HEAD 版本对全部目录的 Claude 发现结果（名称、目录、在线状态、更新时间等）逐项对比完全一致。新增 6 项测试，覆盖增量扫描与截断重扫、缓存持久化与损坏容错、末尾窗口读取、压缩记录读取与切换、并发发现合并，以及在真实 wrapper 进程中途获取窗口大小。完整测试 442 项，441 通过，唯一失败的是既有的启动脚本测试（代码页问题）。

管理端改动需要重启管理服务；wrapper 中途获取窗口大小，需要各 Claude 面板在任务结束后重开一次才会加载。

## 2026-11-06 固定管理服务端口

按用户要求，管理服务改为固定端口 **47821**；`startServer` 的参数默认值原本就是它，但 CLI 一直传入 0 改成了随机端口。选它的依据：

- IANA 注册表：属于 47810–47999 未分配段。
- 本机 TCP 动态端口范围为 1024–15000，系统保留段为 50000–50059，47821 都不在其中。
- 不在浏览器 Fetch 禁止的端口内，选定时本机没有程序占用。

`--port` 优先，其次是环境变量 `COOP_PORT`，`0` 保留随机端口。只有默认端口被占用时才回退到随机端口，同时在终端和管理页顶部提示（`/api/config` 的 warnings 现在会显示到页面）；显式指定的端口被占用则直接报错。测试一律使用随机端口，启动器测试的环境设为 `COOP_PORT=0`。

新增 2 项测试。完整测试 436 项，434 通过：一项是既有的启动脚本测试（代码页问题），另一项是负载下超时的真实进程计时测试（busy wrapper 输出投影），单独重跑 3/3 通过。管理服务重启后改用新端口；已打开的旧管理页地址会失效，需改开 http://127.0.0.1:47821。

## 2026-11-06 会话接口：外部程序唤醒会话

按用户要求，每个会话可开启一个专用接口，供 MCP 服务、后台任务等外部程序在完成后向该会话发消息并唤醒它。

- 接口密钥形如 `hk_<id>.<secret>`，一个会话一个，存于管理数据库新增的 `session_hooks` 表（`CREATE TABLE IF NOT EXISTS`，数据库版本号不变）。只有接口自身的 id 会写入事件与消息记录；密钥不出现在监控、配置或通信记录接口中。
- 调用方式：`coop notify --hook KEY`（或 `COOP_HOOK_KEY`），以及 `POST /api/hooks/notify`，鉴权头为 `Authorization: Bearer KEY`，只接受 `text`、`source` 两个字段。目标会话完全由密钥决定。每个接口每分钟最多 30 次。
- 取得接口：管理页“会话接口”对话框（受 CSRF 保护，可开启、重置、停用、重新启用），或由会话自己调用 MCP `session_interface` / CLI `coop hook`（沿用 `send` 的身份识别）。agent 不能重新启用用户停用的接口；接口密钥不能用来替其他会话申请接口。
- 投递：外部消息进入目标会话的普通 FIFO 队列，沿用维护锁、额度等待和原生裁定回传；不走用户提示或维护控制通道。封装标为“外部程序「来源」（会话接口 id）”，说明没有可回复地址、不是用户新授权。外部程序没有权限类别，Claude 消息不附带权限声明，也不借用其他会话的类别；接收方为“绕过权限”时依赖“允许不同权限模式互发消息”开关。本机各已重开的 Claude 会话均已读回 `effective: accept`。

新增 4 项测试，更新 2 项 MCP 工具目录断言；测试使用独立临时根目录，未调用正在运行的管理服务。完整测试 434 项，两次全量各 432 通过：固定失败的是既有的启动脚本测试（代码页问题）；另外每次各有 1 项真实进程计时测试超时，两次分别是 service-launcher 的传输保持测试和 busy wrapper 输出投影测试，单独重跑均 3/3 通过，均不涉及本次改动，测试时本机有其他会话在运行重负载任务。尚未对真实会话做在线投递验证：管理服务需重启加载后，可由用户授权做一次实际唤醒测试。

## 2026-10-28 允许不同权限模式互发的开关

按用户要求，管理页“通信设置”新增“允许不同权限模式互发消息”开关，默认关闭；本机已开启（`.cooperation/claude-wrapper/config.json` 的 `peerCrossModeAccept: true`）。

已安装 Claude 2.1.280 的原生代码确认：`crossSessionInbound` 依次从托管策略、启动参数层（flagSettings）和用户设置中取第一个定义的值，项目设置和本地设置只能收紧；`apply_flag_settings` 对启动参数层做浅合并，值为 `null` 的键会被移除。开关开启时，wrapper 在行边界向自己的 Claude 子进程发送 `apply_flag_settings {crossSessionInbound: "accept"}`；关闭或撤回 Claude 连接时发送 `null`，恢复原生规则。会话空闲时用 `get_settings` 读回，只保留按原生优先级算出的 `crossSessionInbound` 结果，其他设置内容不对外暴露。被托管策略覆盖、下发失败（30 秒后再试）或旧 wrapper 不支持，都会在对话框中分别显示。不写任何 Claude 设置文件，不冒用发送方的权限声明；wrapper 自己的控制回复不会转发给 IDE。

发现并修复一处随带问题：新增的前端模块须加入静态文件白名单，否则管理页的模块加载会失败；已加测试，检查管理页导入的每个模块都在白名单中。

新增 7 项测试，其中 2 项使用真实 wrapper 进程，覆盖开启、读回、关闭、托管策略覆盖和下发被拒后不在每次轮询都重试。完整测试 430 项：429 通过，1 项失败为既有的启动脚本测试（代码页问题）。开发中全量测试还抓到一处请求处理里的变量遮蔽，已在提交前修复。浏览器只做了加载检查，前端外观由用户检查。管理端需重启管理服务才生效；wrapper 端在各 Claude 面板任务结束后重开一次时加载。

## 2026-10-28 Claude 协作消息显示已发送，实际被原生暂存后过期

一条 Claude → Claude 消息在管理账本中为 `submitted`，发送方也只收到“已提交”，但接收方从未收到。接收端 wrapper 记录：提交后 5 ms 原生端以 `mode-mismatch` 暂存，5 分钟后 `expired` 丢弃。发送会话此前已从“绕过权限”切换为 `auto`，接收会话仍为 `bypassPermissions`。

已安装 Claude 2.1.280 的接收策略只把 `bypassPermissions`（及可切回绕过权限的 plan 模式）归为 bypass，`auto` 属于 prompting；跨类别消息会暂存，宿主没有批准入口，到期后丢弃。Cooperation 的发送声明与原生分类一致，没有冒用接收方类别。缺陷在于结果回传：transport 提交被当作送达，原生裁定只写入接收会话的运行状态，没有回写消息账本，也没有告诉发送方。

修复：

- 提交后最多等待约 1.5 秒取原生裁定。被暂存时，发送方收到 `receiver_held` 及原因和处理建议；当场被丢弃时收到 `undelivered`。
- 监控采样同步之后的过期、拒收、丢弃、放行：`receiver_held` / `submitted` → `undelivered` 为终态；暂存后放行恢复为 `submitted`；普通接收不改写记录。仅限发往该会话、走 `claude-peer-inbox` 通道的消息。
- wrapper 新增按消息 ID 记录的最近 32 条原生结果 `peerDeliveries`，避免另一条消息很快结算时覆盖前一条的过期结果；旧 wrapper 回退到原有的 `peerDelivery`。
- MCP 与 CLI 把 `undelivered` 视为失败；管理页新增“接收端暂存”“未送达”标签和筛选。
- 不自动重发，不修改任一客户端的权限或 `crossSessionInbound` 设置。

新增 8 项回归（7 项单元 / 存储，1 项真实 wrapper 进程）。完整测试 423 项：422 通过，1 项失败为既有的启动脚本测试，当前环境的 `cmd.exe` 无法按代码页解析中文脚本名，修改前的基线同样失败。wrapper 端的 `peerDeliveries` 在 Claude 面板下次重开后加载；管理端改动需重启管理服务后生效。

## 2026-10-08 示例研究会话 可用额度与历史子任务误阻塞

修复 Codex 把全部历史协作调用永久当作未结束后台工作的判定，并修复重连被阻塞时额度解释停止刷新。原生记录确认 示例研究会话 的 19 个子任务都已结束，47 个旧 wait 调用也已完成；当前可继续。缺少完成证据或新子任务仍保持检查。

**385 项测试、4 组浏览器检查通过**。管理服务于北京时间 **17:47:39** 更新；恢复确认已记录为 approved 后，系统在 **17:48:08** 只提交一次继续请求，**17:48:11** 提交排队消息，原生新轮次已运行。具体证据和边界见 [CODEX-HISTORICAL-AGENTS-2026-10-08.md](CODEX-HISTORICAL-AGENTS-2026-10-08.md)。

## 2026-10-08 OpenCode 设置一致性限制补齐

按后续要求，OpenCode 接入的活动版本号移除 effort/variant 与权限配置哈希；真实原生审批请求、模型/代理、新输入、子任务、回滚和幂等操作检查仍保留。最终发送采用最后一次核对的当前 variant，不会把检查前的旧值写回。

**41 项关联测试通过**，包含两次检查之间改变设置、压缩后改变设置仍正常恢复、回执与 FIFO 只释放一次，以及待审批/新输入继续阻塞控制。证据：`.cooperation/verification/opencode-settings-unlock-targeted.txt`。代码已保存，现有 OpenCode 后端需重启加载；本轮未重启管理服务、原生客户端或发送真实消息。

## 2026-10-08 移除思考强度与权限一致性限制

按用户新要求，Claude/Codex 的维护、恢复回执和额度接续不再因 effort 或权限元数据与先前不同而阻塞，仍沿用当前原生设置。补齐 OpenCode 发送权限声明，未知声明的消息明确留在本地队列；原生接收策略和真实发送方权限不变。指定消息在本次压缩开始前已于 Claude 原生端过期，未自动重发。

**373 项自动测试、3 组浏览器检查通过**，另完成已安装 Claude 原生消息解析器/默认策略的离线回放。管理服务于北京时间 **13:39:53** 更新，原维护、回执和队列保持。详细证据、客户端加载要求及原生接收边界见 [SETTINGS-UNLOCK-2026-10-08.md](SETTINGS-UNLOCK-2026-10-08.md)。以下旧记录中的设置一致性限制描述属于当时实现，已由本次用户要求取代。

## 2026-10-07 Claude Code / Codex 恢复链路追加审计

修复设置同步旧值、默认值与未知值混淆、查询超时槽位耗尽、回执设置比较不一致、Codex 额度暂停交付缺少额度参数、额度时长误标、小幅跨进程时差，以及设置已就绪/额度已恢复时的卡片旧状态。完整记录见 [AUDIT-2026-10-07.md](AUDIT-2026-10-07.md)。

全量 **364 项通过，0 失败、跳过或取消**；实际浏览器 **8 组通过 / 0 页面错误**。最后的视图提示另通过 16 项测试，Claude 选择来源保留另运行原生 wrapper 专项。北京时间 **21:23:58** 更新管理服务，现有维护、回执、策略和 ready / unknown 消息保持；无真实消息发送或原生客户端重启。Claude 当前运行连接需加载本轮新增的设置同步能力，管理页需刷新加载卡片变化检测。

## 2026-10-07 已打开的管理页沿用旧状态文案

20:40 实时核对：Claude example-id-07 的后台原因是旧接入尚未加载启动参数修复，`requiresReopen=true`，原生 PID（本地记录） 仍为 19:59 启动的旧实例；没有设置变更证据。新视图对同一快照显示“已连接，需要重开面板加载修复”，而旧视图会因为原因中含“模型设置”误归为“会话设置发生变化”。HTTP 已设 `Cache-Control: no-store`，但它不会替换已在打开页面中执行的 ES module。

管理页现于服务 boot ID 改变、点击“更新状态”或刷新会话列表时重新加载状态视图模块，并清除卡片显示签名。此过程不重载整页，保留未保存提示词、表单和导航；不批准接续确认、不发起维护。已有旧页面仍需先用浏览器 F5 完整刷新一次，加载这段更新逻辑；它与 Claude 原生接入加载属于两件事。

隔离实际浏览器 **3 组通过 / 0 页面错误**：重现旧文案后不刷新整页即可加载新文案；服务重启后自动更新显示且保留未保存提示词；接续确认仍为 pending，维护仍暂停。证据 `.cooperation/verification/live-view-update-browser.json`。本次只有静态页面代码更新，无需重启生产管理服务或原生客户端。

## 2026-10-07 Claude 已连接但恢复卡住：启动参数、设置和压缩失败

生产会话 example-id-07 的 Claude 实际以 `--resume=UUID` 启动，而旧 wrapper 只识别 `--resume UUID`，因此设置读取根本未启动。恢复状态又把设置未就绪统一显示成“等待重新连接”。其维护流程 example-id 的压缩请求已返回 `not_compacted`，没有压缩边界；旧页面没有提供这一已知失败结果的可执行接续入口。

现在识别分离和等号两种原生参数，已初始化会话也能在第一条业务消息之前查询当前设置。管理页区分离线、已连接等待设置、设置读取失败、当前回复、待确认权限、核对历史和旧接入需要更新；等待原因随观察结果变化，不重置原阶段期限。旧进程缺少新版设置读取能力时明确提示重开同一面板一次，不让用户反复试连接。

对精确请求的终态 `failed` / `not_compacted`，仅在没有压缩边界和完成记录时允许“重新保存进度并继续整理”。点击时重新核对会话、设置和可用额度，并再次检查原生状态没有变化；新流程、交付文档和凭证重新生成，原交付、回执、失败记录和 FIFO 队列保留。仍处于已核对额度中断的原生轮次使用额度接续通道保存新进度。未知结果、已有压缩边界、晚到的成功结果、取消、人工停止和检查期间的新输入均不能直接重压缩。维护因额度暂停后每分钟查询实际额度；额度未知不会被当成耗尽或可用。

本机 2.1.280 的隔离原生测试还确认：默认 `get_settings` 返回模型名带 `[1m]`，原回复 metadata 则可只含基础模型名。比较现区分历史解析名和明确的模型选择，两次明确选择的窗口变化仍判为变更；明确清空思考强度判为设置变化，不再无限等待同步。原生测试无业务提示，配置和缓存均位于本项目内。

完整 **352 项测试通过，0 失败、跳过或取消**。新增回归覆盖等号参数、两种启动顺序、额度耗尽/未知/恢复、真实设置变更、旧 wrapper 升级提示、接续时取消/输入竞态、重复操作、一次压缩和恢复后 FIFO；原有五阶段恢复测试仍通过。实际浏览器 **7 组通过 / 0 页面错误**，点击按钮到后端并检查 390px 布局。证据：`.cooperation/verification/reconnect-recovery-full-tests.txt`、`reconnect-recovery-browser.json`、`reconnect-default-settings-native.json`；最后的额度缺项提示更新另通过 7 项视图测试和相同浏览器检查。

北京时间 **20:31** 已更新管理服务。3 个未结束流程、交付回执、配置和所有待发/未知发送记录保持；只增加该失败维护的额度查询结果。生产 API 已确认目标 `connected=true`、`requiresReopen=true`、`compactionFailed=true`、`canRestartFromCurrent=true`。当时 Claude 额度接口缺少五小时和每周数据，保持 UNKNOWN 并定时重查。原生 Claude 面板未被关闭、未发送真实业务/维护消息、未替用户完成重启接续确认；同一面板重开后才会加载新版 wrapper。部署证据：`reconnect-recovery-deployment.json`。

## 2026-10-07 新输入后的维护继续入口

流程 example-id 的 handoff 回执已接受，但服务与原生进程重启后，最新会话轮次已变成后续用户输入。自动恢复正确拒绝沿旧控制轮次压缩，然而前端仍只显示“检查并继续”，没有可执行的后续操作。

现在对尚未发起压缩的暂停流程提供“按当前进度继续维护”。用户点击后核对当前原生会话、工作目录、空闲状态、权限请求和额度，再以新的流程 ID、文档路径和回执凭证保存最新进度。旧流程标记 cancelled 并关联新流程，旧交付与已接受回执保留；旧锁到新锁的转移在同一数据库事务内完成，排队消息没有提前放行的间隙。任意压缩意图、请求、结果或压缩后阶段均禁止走此入口；已有压缩仍需核对原结果。

当前会话仍在回复时按钮显示但禁用，并提示回复结束后可用。新流程按当前空闲状态启动，不重放原业务输入；新 handoff、一次压缩、restored 回执和原生轮次结束后才放行 FIFO。此功能只由明确的页面操作调用，不因新输入自动重启维护。

完整测试 **340 项通过，0 失败、跳过或取消**；针对性 **57 项通过**。新增 6 项回归覆盖端到端新旧流程切换、旧回执保存、FIFO、重复请求拒绝、压缩意图保护、取消竞态和事务回滚。浏览器 **4 组通过 / 0 页面错误**，实际点击新按钮验证后端请求与状态转换，含 390px；未向生产会话发送维护提示或执行压缩。

证据：`.cooperation/verification/continue-current-targeted.txt`、`continue-current-full-tests.txt`、`continue-current-browser.json`。

已于北京时间 20:12 更新管理服务，实际监控 API 已对 example-id 返回 `canRestartFromCurrent=true`。发布前确认其他待重连流程的原生操作已结束、没有在途控制请求，保留 3 个未完成流程及所有待发／未知发送记录；没有替用户点击生产会话的继续按钮。部署记录为 `continue-current-deployment.json`。

## 2026-10-07 额度查询不完整与过时维护锁

10 月 6 日 18:53，Claude 示例会话 的 `get_usage` 仅返回周额度 50%，五小时窗口缺失。原生扩展日志反复报告 `Usage fetch returned a fieldless or non-object body (in-band error)`。本机 2.1.280 源码显示：额度端点失败时会回退到仍未过期的响应头窗口，而五小时窗口到期后从回退数据消失。此结果无法证明剩余额度为零，也不能仅凭时间证明已恢复。

现在将该状态显示为“额度查询不完整”，明确缺少五小时数据及 `/usage` 核对方法；原生离线时不显示过期的下次查询时间。解析支持服务器返回的 `limits[]`，按 `session` / `weekly_all` 类型确定必需窗口；其他返回窗口也保留约束。缺失、未知及不完整数据保持 unknown，不补零。新版解析由 wrapper 加载，原生客户端重新打开后生效；页面说明兼容旧版返回的窗口列表。

审计同时确认，Claude 示例会话 曾于 10 月 6 日 19:55 自动提交额度继续，20:40 再次因五小时额度中断。10 月 7 日核对时原生客户端已离线，另有 1 条消息保留在队列中；未重发业务内容或伪造额度恢复。

本 Codex 对话的卡锁来自 10 月 4 日流程 `example-id-01`：恢复回执曾被拒绝，此后已有新的原生工作，旧流程已过时。本轮备份后通过正常取消接口结束该旧流程，状态为 cancelled，释放维护锁；交付文档摘要、原 handoff 回执及队列均保持不变，没有伪造 restored 回执。取消时记录当前正在执行的轮次，待当前回复结束后再按原策略评估新维护，避免立即打断当前回复。

完整测试 **334 项通过，0 失败、跳过或取消**；针对性 **60 项通过**，浏览器 **4 组通过 / 0 页面错误**，含 390px。新增回归覆盖缺失窗口、现代窗口列表、原生通道字段过滤、仅在完整额度恢复后提交一次，以及取消旧锁后不立即中断当前轮次。未以真实耗尽或重复提交业务进行验证。管理服务已于北京时间 10 月 7 日 10:41 更新，保留 1 条待发消息。

证据：`.cooperation/verification/quota-diagnostics-targeted.txt`、`quota-diagnostics-full-tests.txt`、`quota-diagnostics-browser.json`、`quota-diagnostics-deployment.json`、`obsolete-codex-cycle-repair.json`。Claude 上游额度接口异常尚未由本项目修复；当前离线，需重新打开原会话并按管理页确认接续，之后以实时完整额度数据判断。

## 2026-10-06 Codex 空闲时独立检测账户额度

旧实现只在原生轮次出现额度失败后查询账户额度；因此其他显示 idle 的会话没有独立额度状态。另外，真实 `threadRuntimeStatus.type=systemError` 配合终态 `usageLimitExceeded` 被归为 unknown，无法进入正常额度接续。

管理服务现通过已有原生 App Tools 连接每分钟共享查询一次账户额度，查询与模型轮次和用户消息无关，多会话共享查询及缓存。账户结果与具体轮次失败分别保存：空闲会话可显示“账户额度不足”，排队投递和新维护等待容量；运行中的原生任务仍显示工作中。额度恢复不会为已完成的会话凭空建立继续请求。具有明确原生终态额度错误的 systemError 可进入原有接续流程，待审批、混合轮次不确定及通用错误继续保留限制。

查询失败或过期显示 unknown，不视为零用量。仅保留额度窗口、状态及查询时间，不保存账户 ID、重置券或凭据。账户查询由管理后台运行，不需要用户在耗尽额度的 Codex 聊天中再发消息；前提是管理服务与原生额度连接可用。

完整测试 **329 项通过，0 失败、跳过或取消**；新增 6 项回归覆盖共享查询、失败/过期处理、空闲无错误时检测、FIFO 保留及恢复、systemError、原生操作前检查、维护阶段等待及页面状态。浏览器 **5 组通过 / 0 页面错误**，含 390px。使用管理服务保存的连接独立读取真实账户额度成功，未调用模型或发送业务消息；没有人为耗尽真实账户做故障注入。证据：`.cooperation/verification/codex-passive-quota-full-tests.txt`、`codex-passive-quota-browser.json`、`codex-passive-quota-native.json`。

已于北京时间 16:30 更新本地管理服务，后台自动查询的账户额度及下一次查询时间已出现在真实会话监控状态中。更新保留暂停流程、回执、策略和消息队列；未重启原生客户端。部署记录为 `codex-passive-quota-deployment.json`。

## 2026-10-06 Claude socket 消息缺少发送方权限模式

10:32 从 Codex `gs` 提交到 Claude Claude 示例会话 的消息因 `no-mode-asserted` 暂存，并在 10:37 过期；新版接入已正确清除等待标记。核对时双方均为完整访问／绕过权限，所查用户及项目配置未显式设置 `crossSessionInbound`。剩余问题是发送适配器没有携带发送方权限声明。

发送路径现在在实际写入前读取发送方原生状态，核对会话 ID、工作目录和连接状态，只声明已知权限类别。Codex 的完整访问且不要求审批对应 bypass，受限文件访问对应 prompting；Claude 使用已知实际权限模式，其他或未知状态不猜测。声明放在 socket 接收器识别的原生 `cross-session-message` 封装 `from-mode` 属性中；不会冒用接收方的权限类别，不修改任一客户端设置。排队消息在投递时重新读取，正文中的声明不能覆盖外层声明。

完整测试 **323 项通过，0 失败、跳过或取消**，针对性测试 **42 项通过**。真实本机命名管道模拟接收器验证 framing、认证、消息 ID 和两种权限类别；新增 4 项回归覆盖权限类别、来源核对、封装及排队后的权限变化。提取已安装 Claude 2.1.280 的纯解析与策略函数做离线回放：匹配类别 accept，跨类别 hold/mode-mismatch，缺失类别 hold/no-mode-asserted。该回放使用无标签样例和已知默认接收策略，未调用模型或向真实会话投递消息。

证据：`.cooperation/verification/peer-mode-targeted.txt`、`peer-mode-full-tests.txt`、`peer-mode-native-replay.json`。此次没有重发已过期消息；真实业务投递仍需用户明确授权后核验接收结果。

本地管理服务已于北京时间 10:52 更新，新服务已读取到发送方权限类别。Claude Claude 示例会话 仍为已连接、空闲、待接收 0 条，并已加载接收通知处理；此次发送修复无需再重开客户端。部署记录为 `peer-mode-deployment.json`。

## 2026-10-05 Claude 协作消息过期后的残留等待

Claude 示例会话 的原生会话已经完成上一轮回复，但接入仍报告 `pendingPeerMessages=1`、`activity=unknown`。只读原生扩展日志确认：22:35:57 收到的消息因 `no-mode-asserted` 被暂存，22:40:56 已过期丢弃。接收方使用 `bypassPermissions`，该消息未声明发送方权限模式；Cooperation 忽略了原生 `system/peer_message_hold` 通知，导致待接收标记一直不清除。

接入现处理同一会话、socket 通道、已登记消息 ID 的 held / released / dropped 通知：暂存保留等待，释放仍需原生接收证据，丢弃只移除对应消息的等待标记。其他通道、其他会话、陌生或迟到通知不改变任务状态；真实工作和额度中断继续保留。已确认尚未提交的传输失败带有明确结果，发送方可清除准备标记；发送结果未知时仍保留等待。新增 `peerDeliveryLifecycle` 能力及最小接收状态元数据，页面分别显示等待接收、原生暂存和过期未送达。

完整测试 **319 项通过，0 失败、跳过或取消**；新增 6 项回归，其中 3 项状态回归在修复前失败。实际 Windows wrapper 与协议测试进程验证 held / dropped 通知透传和等待清除；浏览器 **5 组通过 / 0 页面错误**，包含 390px。第一次完整运行有 1 个既有额度接续测试遇到跨进程时间采样偏差：查询时间稍晚于管理进程时钟，严格新鲜度检查正确保留等待。测试改为按真实轮询推进，生产新鲜度条件未放宽；原失败日志保留为 `claude-peer-hold-full-tests-first.txt`。

本次对真实会话只清理已由原生日志确认过期的消息 `example-id-02` 的接入等待标记。前后原生 PID、会话 ID、模型、权限和最后完成轮次均一致，状态恢复为 idle、待接收数为 0；没有重启客户端、改变原生权限、发送或重发业务消息。现场证据为 `.cooperation/verification/claude-peer-hold-live-repair.json`，测试为 `claude-peer-hold-before.txt`、`claude-peer-hold-full-tests.txt`、`claude-peer-hold-browser.json`。

独立无凭据官方 CLI 验证尝试未发布 peer inbox，因此在 peer 投递前退出，未计入原生投递验收；记录保留在 `claude-peer-hold-native.json`。永久通知处理随 wrapper 重开后加载；现有进程无法热加载。原生接收策略保持原样，过期消息不因状态修复而自动重发。

管理服务已于北京时间 23:27 更新；发布后的 Claude 示例会话 状态为 connected=true、idle、pendingPeerMessages=0，现有 Claude 面板尚未加载 `peerDeliveryLifecycle`。两个原有暂停流程、回执、策略和提示词保持不变，部署记录为 `claude-peer-hold-deployment.json`。

## 2026-10-05 后续维护与状态管理检查

修复取消与重试／核对并发时旧结果重新激活流程、暂停维护不刷新连接状态、额度恢复遗漏权限别名兼容、取消后接续确认残留，以及原生权限等待掩盖暂停原因。详细结果及后续优化建议见 [本轮检查记录](AUDIT-2026-10-05.md)。

9 个新回归在修复前全部失败，修复后针对性测试 **98 项通过**，完整测试 **313 项通过，0 失败、跳过或取消**。隔离浏览器 **4 组通过 / 0 页面错误**，包括 390px 布局；没有向真实业务会话发送测试消息、重新压缩或代替用户确认接续。证据为 `.cooperation/verification/audit-oct5-before.txt`、`audit-oct5-targeted.txt`、`audit-oct5-full-tests.txt`、`audit-oct5-browser.json`。

修复已更新到本地管理服务；原暂停流程、回执和策略保持不变，启动后自动刷新暂停会话的实际状态。部署结果为 `audit-oct5-deployment.json`。

## 2026-10-05 Codex 自动审批名称变化误判

两个 Codex 对话均在恢复阶段被误报“思考强度或权限发生变化”。只读核对维护前与恢复轮次的原生记录，模型、思考强度、审批策略、审批人和实际文件权限一致。将桌面端的 `guardian_subagent` 改写为原生返回的 `auto_review`，可精确复现两个事件的前后权限指纹；本机官方桌面代码也将两者识别为同一种自动审批模式。官方当前配置名为 [`auto_review`](https://learn.chatgpt.com/docs/sandboxing/auto-review)。

权限指纹 v3 统一该别名，并按旧指纹版本分别保留兼容值，支持已有 v1/v2 维护记录；不会把 v1 的隐含工作目录规则扩大到 v2。真正改变审批人、审批策略、权限配置、可写目录、网络或临时目录权限仍会停止接续。修复不改写原生设置，也不自动重放已暂停或取消的生产流程。

完整测试 **304 项通过，0 失败、跳过或取消**。新增 5 项回归包括两个真实指纹回放、真实权限变更的反例、正常与超时后的恢复回执、只压缩一次以及回执后按序释放消息。55 项针对性测试通过。生产会话仅做只读核对；恢复接续通过隔离流程验证，没有向两个真实对话发送测试消息或重新执行压缩。

证据：`.cooperation/verification/codex-reviewer-alias-evidence.json`、`codex-reviewer-alias-targeted.txt`、`codex-reviewer-alias-full-tests.txt`。取证脚本只保留权限元数据、哈希及流程标识，不保留对话正文或凭证。

本地管理服务已于北京时间 2026-10-05 21:42 更新，实际服务状态返回权限指纹 v3。更新保留两个暂停流程、已有回执、策略和提示词，更新前待发 outbox 为 0；没有重启原生客户端或代替用户批准接续。服务重启确认按原规则重新生效，报告为 `codex-reviewer-alias-deployment.json`。

## 2026-10-04 Claude 重开后的设置读取与状态说明

修复只收到 initialize 成功回应、尚未发出 system/init 时的额度恢复卡住：启动参数提供明确权限模式，接入通过原生只读 get_settings 获取 applied.model / effort，并继续核对原会话历史。设置读取异步进行，慢响应不会拖住连接状态查询；读取期间的新用户输入或设置变化使旧结果失效。新的设置字段补全不会被误当作旧设置改变，已知设置真正不同时仍不自动继续。

前端区分已连接但暂缓、旧接入需重开和实际离线，说明具体缺少的设置及下一步；接续确认与额度查询时间独立显示。过期额度记录标为待查询。核验期间继续读取额度，不发送继续提示。

本轮完整测试 **299 项通过**，新增 9 项回归覆盖真实启动器在没有 system/init 时的两种启动顺序、只读字段过滤、慢查询与新输入竞态、实际设置变化、核验期间独立查询额度及界面事实。另有 **6 组浏览器检查 / 0 页面错误**，包含 390px 布局。独立运行已安装的官方 Claude 2.1.280，以项目内临时配置、回环假 API 地址和零业务提示验证 initialize/get_settings，返回实际 model / effort；没有启动模型请求、重启或注入生产会话。

证据：`.cooperation/verification/reopen-settings-full-tests.txt`、`reopen-settings-browser.json`、`reopen-settings-native.json`、`reopen-settings-deployment.json`。前期完整检查暴露出查询时序及测试将初始化握手等同于设置就绪的问题；三份失败日志保留为 `reopen-settings-full-tests-first.txt`、`second.txt`、`third.txt` 对应文件。修复读取顺序、迟到结果保护，并让隔离服务按实际异步状态推进后，最终整套通过。

## 2026-10-02 项目重启接续确认

完整测试 **290 项通过**，浏览器 **8 组通过 / 0 页面错误**。实际 wrapper + 隔离管理服务验证两种启动顺序的额度接续和五个维护阶段；确认前无新阶段提交，确认后仍保留回执、未知压缩和未知发送保护。三端队列验证先确认再连接、暂缓、重复重启和旧连接快照不得放行。覆盖服务关闭前、关闭期间和原任务重连后发生额度中断。OpenCode 原生协议验证当前 429 阻止压缩与直接投递，确认不能绕过限流，原会话新轮次恢复后按序投递。

前端验证：三端离线会话、默认焦点“稍后处理”、Esc 和刷新、部分确认、跨标签页、已有页面随服务重启重新确认、过期 boot / CSRF 拒绝及移动端布局。修复了旧轮询结果晚到导致重新显示已处理事项的竞争情况。

证据：`.cooperation/verification/restart-confirmation-full-tests.txt`、`restart-confirmation-browser.json`、`restart-confirmation-deployment.json`。全部隔离进程、数据和浏览器缓存位于项目内；没有重启真实业务客户端或向其注入验证消息。未实测实体电脑断电或真实账户耗尽后的数小时等待。

## Shutdown and startup-order recovery (2026-10-02)

The default full suite passes **275 tests**, with no failures, skips or cancellations. Eleven new regressions first reproduced cancelled quota recovery after native instance changes and stalled maintenance after a manager-only restart. Fixes bind verified failures to new observations, retain uncertain-send holds, persist Claude quota metadata independently of the manager, and repeatedly reconcile the original phase after reconnect.

Isolated tests terminate the actual Windows wrapper executable, reopen its deterministic native child, and restart the management service in both orders. They preserve checkpoint gates and FIFO through writing handoff, awaiting handoff completion, completed compaction, restoring, and awaiting restore completion. A crash after a compact boundary but before its result holds the queue without repeating compaction. Quota failures observed while the manager is absent also survive restart. Actual Codex IPC adapter tests reconnect to a changed deterministic owner and submit one continuation with inherited settings. Same-process manager restarts, settings changes, manual stop, missing history, concurrent input and uncertain dispatch remain covered.

Four browser checks pass with zero page errors: offline waiting, history verification without a live quota marker, changing reasons without an activity change, and mobile layout. No real business client was restarted or messaged, no account quota was exhausted, and no physical power-loss test was performed. Running Claude wrappers load persistence at their next normal restart; missing pre-upgrade evidence requires confirmation.

Evidence: `.cooperation/verification/restart-recovery-full-tests.txt`, `restart-recovery-browser.json`, and `restart-recovery-deployment.json` when deployed. Intermediate logs retain a removed wrapper SQLite-warning dependency and random fixture-port conflicts; HTTP fixtures now use the existing retrying allocator. See [restart behavior](RESTART-RECOVERY.md).

## UI continuity and status-first layout (2026-10-02)

The full regression suite passes **239 tests**, with no failures, skips or cancellations. The published frontend also passes eight browser verification groups with zero page errors.

The Apple-design review reproduced discarded prompt drafts, lost keyboard focus on polling, cleared message-text selections, and quota explanations below the first viewport. The revised interface retains page-local drafts and caret positions, supports undo for reset/discard actions, handles save completion after dialog closure, and reconciles refreshed DOM nodes by stable identity. Current status and required actions now precede context statistics and collapsible thresholds.

An isolated browser exercised the published assets against a real isolated HTTP management service. It verified background status updates and unrelated session discovery during editing, message updates and new arrivals during text selection, Escape/reopen, reset/discard undo, invalid drafts, failed saves, closing during an in-flight save, 44px mobile controls, focus trapping/restoration, rapid drawer reversal, reduced motion, and an actual maintenance action through the test service. Page errors were zero. All browser profiles, caches, temporary files and fixtures stayed inside this repository; copy operations used a page-local clipboard substitute. Mobile verification used a 390px Chrome viewport rather than physical phone hardware.

Evidence: `.cooperation/verification/apple-design-audit.json`, `apple-design-polish-browser.json`, `apple-design-ui-full-tests.txt` and `apple-design-ui-deployment.json`. A full-suite run encountered an unrelated fixed test-port collision; that log is retained as `apple-design-ui-port-collision.txt`, and the affected fixture now uses the existing retrying automatic-port allocator. Publication changes only static frontend assets and preserves saved policies and prompt settings without restarting the service or native clients.

## Quota recovery with folded inputs and mixed native histories (2026-10-02)

The full default test suite passes **239 tests**, with no failures, skips or cancellations. Eight new regressions failed against the preceding implementation before the quota-state fixes. Claude now consumes native command lifecycle evidence instead of promoting local queued inputs into a fictional running turn. Codex orders mixed turn representations using a shared head or native timestamps; an ambiguous head retains quota evidence and blocks native controls until synchronization. Quota polling can proceed while the continuation boundary remains unavailable.

The executable Claude wrapper and isolated management service verified two inputs folded into the same turn, quota failure, read-only quota querying while busy, and one configured continuation in the original process without replaying the folded inputs. The real Codex IPC adapter and deterministic native endpoint verified ambiguous quota detection, polling, synchronization, and exactly one continuation with inherited settings. The browser verified enabled/disabled policy feedback, dated reset information, historical maintenance labeling, client upgrade guidance and the 390px layout, with no page errors.

A reload regression also verifies that a confirmed paused maintenance failure retains its original cause, checkpoint and queued messages. Intermediate full-suite runs exposed Fetch-blocked Windows ephemeral ports and a fixture initialization timeout; their logs were retained. Automatic HTTP allocation for the wrapper and management server now shares the existing OpenCode approach of selecting loopback ports in 20000–65535 with bind retries, without changing system configuration. The final default concurrent suite passed after these changes. Native business sessions were not sent test messages or restarted, and a real account exhaustion/reset cycle was not forced.

Evidence: `.cooperation/verification/quota-state-before.txt`, `quota-state-restart-before.txt`, `quota-state-full-tests.txt`, `quota-state-browser.json`, and the retained `quota-state-intermediate-*.txt` files.

## Reverse peer delivery into quota-limited Codex (2026-10-01)

The full suite passes **225 tests**. Production Codex message delivery now checks the current native state before invoking the App message bridge, so a stale idle snapshot cannot bypass an already observed native quota error. An explicitly unsent delivery remains queued through the same durable deferral path used by Claude.

The reverse-direction regression failed before this guard and passes with it. The isolated test connects the actual Codex IPC adapter to a deterministic native-protocol endpoint and verifies first-message quota detection, two queued followers, no compaction at high context use, one configured native continuation with inherited thread settings, and exactly-once FIFO delivery. It does not exhaust an actual Codex account. Evidence: `.cooperation/verification/codex-peer-quota-before.txt`, `codex-peer-quota-protocol.txt` and `codex-peer-quota-full-tests.txt`.

## Peer delivery into a quota-limited Claude session (2026-10-01)

The full suite passes **224 tests**. Current Cooperation peer-message IDs are registered before native delivery, allowing a peer-triggered quota failure to be associated with the receiving turn even when no IDE input preceded it. Historical peer replay cannot start an observed turn. A final native quota check defers unsent messages back to the durable queue if the monitoring snapshot was stale.

An isolated real wrapper and management service, using a deterministic protocol child in place of the model process, verified a Codex-origin first message triggering Claude's five-hour rejection, two subsequent messages remaining queued, one custom quota-continuation prompt after positive quota availability, and exactly-once FIFO delivery of the waiting messages. The receiving process stayed unchanged. This did not consume or force an actual account quota. Evidence: `.cooperation/verification/peer-quota-native.txt` and `peer-quota-full-tests.txt`.

## Everyday connection guidance and receipt recovery (2026-10-01)

The full suite passes **221 tests**. The regression suite reproduces synthetic Claude messages being treated as a model change, and a ten-minute handoff timeout rejecting receipts while the original control turn remains active. It also verifies safe late-receipt acceptance for Claude and Codex, metadata-only update races, retained user-intervention guards, and rotating credentials on explicit retries.

The real wrapper executable, isolated management HTTP server and deterministic protocol child completed handoff, one compaction, restore and two accepted receipts in the same process. This is a protocol-level acceptance check, not a fault injection into a user's production model session. An isolated browser verified the state-specific command-free connection flow, three-stage maintenance feedback, disclosure controls, diagnostics, cancellation confirmation and desktop/mobile layout. See [implementation and evidence](USER-EXPERIENCE.md).

## Quota interruption and continuation (2026-10-01)

The complete automated suite passes **207 tests**, with no failures, skips or cancellations.

Quota failure is now distinct from idle activity for Codex and Claude. Policy and native control guards block compaction, while a durable continuation record holds queued messages. The manager reads quota without model probes and submits a single continuation only after positive availability and unchanged native identity/settings. Unknown delivery is not retried. Further quota failures back off; disabling automatic management cancels future continuation.

Tests cover both client recovery paths, expired reset timestamps, weekly/model limits, native user/settings races, restart deduplication, unknown delivery, FIFO holds, and failures during maintenance. The executable Claude wrapper test uses a deterministic protocol child to verify `get_usage` with behavior scanning disabled and same-process continuation. An old wrapper cannot perform automatic maintenance until normally reopened with quota support.

The actual Codex App usage endpoint returned public quota windows successfully. An isolated Chrome verified waiting-state display and the new configurable quota prompt on desktop and mobile, with no page errors. No production business session was sent a test prompt, and no real account was exhausted to simulate the five-hour cycle. Real exhaustion-to-restoration acceptance remains unverified. See [quota behavior and evidence](QUOTA-RECOVERY.md).

## Custom message and maintenance prompts (2026-09-30)

The complete suite passes **189 tests**. Project-local prompt settings are revisioned and atomically saved through a CSRF-protected UI endpoint. Tests verify bounded templates, mandatory runtime checkpoint insertion, restart persistence, stale-write rejection, queued-message affix snapshots, per-stage maintenance customization, OpenCode dynamic affixes and duplicate-delivery handling, and Claude presentation-only labels.

An isolated Chrome session verified all six editor categories, actual save/reload, example-only previews, empty affixes, per-category and full default restoration, stale-save drafts, keyboard closing, desktop and 390px mobile layouts, and zero page errors. It posted only to fixture discovery and prompt-settings endpoints. Browser profile, caches and temporary files stayed in the project.

A real isolated OpenCode 1.18.30 backend with a local deterministic model completed soft/hard cycles using customized handoff, restore and continuation templates, plus ordinary peer prefixes/suffixes. Both cycles retained one compaction, two accepted native checkpoints and the nondefault variant. No production business session was prompted for this feature. The production manager was gracefully reloaded at its existing URL when no active maintenance or queued deliveries required it. Native clients were left running; cached native plugin/wrapper code takes this feature on its next normal restart. See [usage and evidence](PROMPT-SETTINGS.md).

## OpenCode maintenance repair (2026-09-30)

The complete suite passes **184 tests**, with zero failures, skips or cancellations. The repair prevents the OpenCode MCP catalog from shadowing native plugin tools, binds explicit restore retries to the verified current input, and preserves the saved model/agent/variant on ordinary peer delivery. Regression coverage includes newer-input rejection and keeping FIFO locked until a valid restored receipt.

The user-designated OpenCode **1.18.33** session completed soft and hard maintenance with the configured external model. Native records confirm one compaction and two accepted checkpoints per cycle, identical handoff/restored document hashes, FIFO A/B delivery and individual replies, and exactly one continuation following the hard cycle's confirmed abort. The soft run required recovery after the original MCP collision and an empty native restore response; its summary was also empty. Those anomalies remain recorded. The hard run produced a nonempty summary and completed automatically. No missing receipt was synthesized and neither cycle repeated compaction.

After plugin reload and a native user turn persisted `max`, two further real peer messages retained the model, agent, variant and permissions. The OpenCode native send tool returned a callback to the initiating Codex chat; the callback was actually received and matched its `opencode-tool-context` audit identity. Final target state: idle, no active cycle, FIFO empty, `max` retained, and automatic maintenance restored to its original off state with 50/80 thresholds. Evidence: `final-live.json`.

An isolated real **1.18.30** backend with a deterministic model also passed soft/hard cycles while the native plugin and a same-named Cooperation MCP were both enabled. Two subsequent peer deliveries retained a nondefault variant. Reports and test log: `.cooperation/verification/opencode-repair-20260930/`. The manager was gracefully reloaded at the same local URL after other active maintenance finished; the user reloaded OpenCode. Existing UI work and unrelated local changes were preserved. See [the repair details](OPENCODE-MAINTENANCE.md).

## Publication checks

The release passes **168 automated tests**. Personal paths and native session identifiers in documentation use generic examples. Local OpenCode configuration, runtime evidence, credentials, dependencies and build outputs are excluded from version control. The tracked `session-lifecycle-cancelled.json` preserves the discontinued lifecycle state in fresh checkouts; regression coverage verifies that no private runtime marker is needed.

## OpenCode automatic maintenance (2026-09-18, current)

The complete suite passes **167 tests**, zero failures. OpenCode now supports per-session soft/hard maintenance policies, native handoff/restored checkpoints bound to ToolContext and the controlling user-message ID, durable control intents, manual native compaction evidence, conditional continuation and FIFO release. New tests cover late/lost responses, forged/wrong-turn receipts, summary errors despite HTTP success, manager/plugin replacement, persisted epochs after history-window truncation, user-input revision conflicts, native settings, permissions and child-session guards. Existing Codex/Claude regressions pass.

An isolated **real OpenCode 1.18.30 backend with a local deterministic model endpoint** completed both soft-idle and hard-running flows. Native write/read tools handled the document; each flow had exactly two completed native checkpoint tool calls and one compaction. Soft maintenance stayed idle; hard maintenance aborted the active generation and continued once. This validates the native protocol, not the reliability of arbitrary external models. Final evidence: `.cooperation/opencode-maintenance-native-result.json`, run root `.cooperation/opencode-maintenance-native-6XPQVE/`.

Isolated Chrome verified capability-gated enablement, threshold autosave, reload persistence, disabling an enabled policy after capability loss, desktop/mobile layout and zero page errors. Evidence: `.cooperation/opencode-maintenance-ui-result.json`, screenshots `.cooperation/opencode-maintenance-ui-Djlxc3/`. Syntax and diff whitespace checks pass.

Native child sessions (including historical children), unresolved permission/question requests and reverted sessions currently block automatic control. Ordinary chat-input coordination is tested; public OpenCode abort has no atomic expected-turn condition, and direct native control paths remain outside a global lock guarantee. New maintenance-specific TUI/desktop-shell rendering and real-provider behavior were not revalidated. Production manager and user native backends were not restarted or upgraded. See [implementation and usage](OPENCODE-MAINTENANCE.md). Earlier test counts and disabled-maintenance descriptions below are historical.

## Lifecycle direction cancelled and external cleanup completed (2026-09-18, current)

The user cancelled proactive native session creation/loading. A 90-file project snapshot and hash manifest preserve the work. The project-local cancellation marker disables lifecycle management capabilities, MCP/OpenCode lifecycle tools, the experimental VS Code bridge and native experiment launch scripts; existing messaging, maintenance receipts and the OpenCode context-display fix remain.

Eighteen attributable external files were backed up, hash-verified and removed: one Claude test transcript, fifteen dedicated VS Code window logs, and two newly created `ext-dev` workspace database files. The original development-host process and its inspector listener no longer exist. Shared VS Code state/cache was not overwritten without a pre-experiment snapshot; no experiment identifiers were found in shared global state. This is not a claim of byte-for-byte rollback of every native runtime artifact.

Eleven isolated regressions for cancellation, messaging, directory guards and context accounting passed. The final check verified all 90 snapshot hashes and 18 backup hashes, no remaining deletion targets, and only `send_message` / `context_checkpoint` in the actual MCP catalog. Syntax checks and `git diff --check` passed. See [cancellation and cleanup record](SESSION-LIFECYCLE-CANCELLED.md). The earlier lifecycle results below are archived progress, not an active development direction or a deployed feature.

## Native lifecycle and OpenCode context display (2026-09-18, latest)

The full suite passes **145 tests**, with zero failures, skips or cancellations. New coverage includes latest-response OpenCode token accounting, actual-model capacity, stale measurements, monitor persistence, authenticated lifecycle tools, CSRF and exact-directory guards, maintenance guards, durable idempotency, conflicting parameters, manager/plugin restart reconciliation, and unknown creation without evidence remaining unknown.

The final identity-case and lifecycle-shutdown guards were followed by **22 passing focused regressions**. The authenticated production status still showed its original PID and start time; exact-project OpenCode discovery returned one session without warnings. All 50 local links in the three handoff/lifecycle documents resolved, and `git diff --check` passed.

An isolated OpenCode **1.18.30** backend created an independent native session with no parentID, returned its address, preserved the operation marker and permission rules, and connected the same ID. Repeated requests did not create duplicates. Restarting only the owned test backend preserved and reconciled that ID. A dedicated prior integration-test session reported **3,962 / 1,000,000 tokens (0.4%)** through the new monitor path. No model was invoked in this lifecycle validation. Evidence: `.cooperation/opencode/lifecycle-validation-result.json`.

Isolated Chrome verified the context number, token counts, model and stale-reading indicator; disabled unsupported creation choices; persistence of an unknown operation across page reload; read-only reconciliation without another create; pre-submission validation allowing correction; and connecting the unchanged native ID. There were no page errors, and the existing cream background was preserved. Evidence: `.cooperation/lifecycle-ui-result.json`, screenshots `.cooperation/lifecycle-ui-PDOn30/`.

Codex/Claude automatic creation and waking unloaded sessions remain unavailable. Their common connect endpoint checks an existing native owner/wrapper without launching or interrupting it. New tool-driven model delegation and new-session TUI/GUI visibility were not exercised. The production manager and current OpenCode plugin were not restarted or hot-updated; deployment remains pending the documented protected-project boundaries. See [lifecycle semantics and next steps](SESSION-LIFECYCLE.md).

## Project drawer and custom workspaces (2026-09-18)

The management UI now uses a compact project sidebar and a selected-project/session workspace. Native clients appear as muted labels on session rows. Selecting a session opens its settings; selecting a project opens its members and aggregate communication scope. Native controls retain their existing endpoints, with accessible switches replacing checkboxes. Phone-sized screens use an overlay navigation drawer and separate message list/detail views.

Named custom projects persist in the management database's `custom-projects-v1` setting. Users select sessions across configured directories, retain offline/missing members, rename groups, and edit membership. A session can belong to multiple groups while keeping one native policy. Mutations require CSRF and expected revision; selected identities resolve from server discovery or that group's existing member snapshots. Deleting a group preserves policies, messages and native sessions. No group operation sends messages or starts maintenance.

All **136 automated tests pass**, with zero failures, skips or cancellations. Four new tests cover database reopen, overlapping cross-directory membership, missing members, exact OpenCode ID case, stale writes/deletes, invalid inputs, HTTP CSRF and communication scope.

The final isolated Chrome run passed 12 interaction checks: flat navigation without checkboxes; session switches and threshold autosave; keyboard member selection preserving order/focus; cross-directory groups; exact communication scope; live message refresh preserving scroll; reload/mode persistence; rename/member edits; connected-only persistence; missing-member behavior; tablet/mobile layout and navigation; group deletion and directory settings. At 1440×960 the sidebar is 292 pixels wide and the workspace occupies the remaining 1148 pixels. The 1024×768 and 390×844 viewports have no document horizontal overflow. No page JavaScript errors occurred. An async button event-lifetime issue found in the first run was fixed and rechecked.

All browser data, profiles, caches and fixture services were project-local. Monitoring was disabled and adapters/runtime were fixtures; no production manager or native business session was started. Report: `.cooperation/workspace-ui-browser-result.json`; final screenshots: `.cooperation/workspace-ui-browser-cbcgU2/`. Pre-change backups, including existing uncommitted OpenCode work, are in `.cooperation/backups/workspace-ui-20260918/`.

## OpenCode communication integration (2026-09-18)

The full suite passes **132 tests**, with no failures, skips or cancellations. Eight new tests cover OpenCode native sender identity, case-sensitive addresses, directory and instance matching, busy transport, durable native IDs across uncertain sends and plugin restart, GUI tree scope, and withholding unsupported maintenance. Source-audit metadata and a concurrent duplicate-submission assertion added afterwards pass all **13 focused regressions**.

Native validation used OpenCode 1.18.30 and official DeepSeek `deepseek-v4-pro`, entirely in project-local data and an isolated manager with monitoring disabled. A 25-second native tool finished normally after a second message was submitted during confirmed busy state. Both markers were acknowledged and the new native message was unique. The formal plugin then completed bidirectional messages between two dedicated sessions, with matching Cooperation/native message IDs.

The **browser GUI** sent a message through its native input and plugin tool; the receiving page displayed the message and response live. Reloading and fully reopening the browser retained the same message without adding native records. The **full TUI** attached through an isolated native PTY to that same backend, displayed existing and live messages, and retained them after closing and reattaching. Restarting the owned test backend preserved the original two mapped native messages. GUI screenshots and terminal output remain in the ignored project-local evidence directory.

The desktop GUI uses the same backend and shared AppInterface; the plugin binds the SDK client supplied by its selected backend, including sidecar authentication. **The desktop application shell, server switching and window reopen have not been exercised.** Its startup includes OS protocol registration, outside this development session's project-only boundary. OpenCode context measurement was added in the latest lifecycle work above; compaction and automatic maintenance remain disabled. See [OpenCode setup and evidence](OPENCODE.md).

Validated on Windows with Node.js 25.2.1, Codex Desktop 26.901.6511.0 / Core 0.153.4, and Claude Code VS Code 2.1.237. These native interfaces may need adaptation after client updates.

## Automated checks

On a fresh Windows clone, build the local launcher before running tests:

```powershell
./scripts/build-claude-wrapper.ps1
node --test test/*.test.mjs
```

The build uses the existing .NET Framework C# compiler. It creates the executable and machine-specific Node/script path file inside the project. Neither generated file is committed. No global installation or configuration change is performed by the build.

61 automated tests passed at the initial delivery. Coverage includes native protocol mocks, Unicode framing, original permission-response forwarding, targeted interruption, context accounting, transactional migration, per-session policy isolation, checkpoint validation, durable locks, FIFO release, restart reconciliation, unknown-delivery handling, and HTTP boundaries. Test files and temporary directories stay inside the checkout.

## Native acceptance

Dedicated existing sessions completed both soft-idle and hard-running maintenance workflows for Codex and Claude: structured handoff acknowledgement, native turn end, native compaction, restore acknowledgement, conditional continuation, and ordered delivery of queued messages.

Each completed workflow had exactly one native compaction. Both acknowledgements and their corresponding native turn ends preceded the next stage. Claude retained the original session and process. Codex retained the original task ID; one hard-trigger test included an owner-instance change during recovery.

The management page was exercised in a real browser for multiple-directory filtering, live status reads, independent threshold changes and persistence after reload. Legacy message migration was verified against a copy before switching to SQLite.

Raw native transcripts, session IDs, local connection files, credentials, machine-specific handoffs and evidence are intentionally excluded from this repository. The automated tests use fixtures and do not invoke the developer's native test sessions.

## Boundaries

- Cooperation queues messages sent through its own entry points. Direct native UI input and third-party direct connections can bypass that queue.
- Native goal, subagent and background-task pause/resume behavior is not fully validated; automatic maintenance is withheld when relevant activity is observed.
- An unloaded Codex task must be opened in the native app before the independent maintenance channel can control it.
- Ordinary messages sent to Codex still use an authorized App Tools bridge environment. Native maintenance control uses an independent local IPC client.
- Native permission checks remain in force. Claude may require a narrowly scoped project-level permission for the checkpoint CLI.
- Ambiguous external outcomes are not automatically retried. Unknown delivery blocks subsequent messages for that recipient until reconciled.

## Dashboard follow-up (2026-09-08)

The current dashboard groups sessions by directory and client, scopes messages to expanded sessions, observes context while automatic compression is off, and saves threshold edits automatically. Startup and shutdown launchers run the project manager without closing native clients.

All 70 automated checks passed. New coverage includes message scope, serialized saves and stale-write rejection, observation without an enabled policy, repeated discovery without nested snapshots, and shutdown waiting for in-flight observation. The live service returned a 9,325-byte monitoring response with no nested snapshots, all automatic policies off, no active cycles and no queued messages.

The initial redesign could not be checked through the available browser connection tool. The later isolated browser verification below covers the current connection guidance and layout; native maintenance acceptance remains a separate record.

## Late Claude compaction completion (2026-09-08)

The manager now continues checking the same Claude compaction request after the wrapper HTTP wait expires, within the maintenance deadline. Restoration requires matching completion evidence and the matching last native turn. Regression tests cover late success, a different request, and intervening native input. The full suite passes 76 tests.


## Automatic Codex connection recovery (2026-09-09)

A project-local private record preserves an already-authorized Codex bridge connection. The manager validates it on startup and before sending, and checks for updated connections in the background. Codex MCP initialization and Codex CLI requests refresh the record; no unrelated conversation identity is discovered or fabricated. The dashboard displays bridge readiness separately from HTTP service availability.

All 83 automated tests passed. A live startup test removed all three Codex connection environment variables and launched the normal Windows startup script: the manager recovered the saved connection and the native message tool was available. The test performed handshake/catalog reads only and sent no message. App restart/connection rotation is covered by simulated MCP registration and reconnect tests; no running native client was restarted for validation.


## Per-directory connection guidance (2026-09-09)

Each directory now shows Claude and Codex connection badges with manual setup guidance. The UI distinguishes directory permission from a live connection, treats stale observations as unconfirmed, and distinguishes Codex message-bridge connectivity from individual loaded tasks. Help provides copyable configuration and a read-only recheck action.

The full suite passes 87 tests. An isolated headless Chrome profile and fixture-only management server verified disconnected and connected directory badges, Claude help, Codex task and bridge guidance, the global connection button, recheck, close and Escape. At 1440 x 900, the document stayed within the viewport and message feed/detail remained side by side. There were no page JavaScript errors; observed POST requests were session-list reads only. No live conversation, user browser profile or real project configuration was changed by browser testing.


## Claude peer-message visibility trial (2026-09-09)

The wrapper now projects only replayed, top-level peer messages whose target session and Cooperation envelope UUID match. It labels the IDE copy and clears its synthetic-display flag; the native input, peer provenance, UUID and original protocol observer remain unchanged. Unmatched traffic stays byte-for-byte intact. Startup switches can disable projection through `COOP_PEER_MESSAGE_VISIBILITY=0` or `peerMessageVisibility: false` in the project wrapper configuration.

Seven new regressions cover source and identity guards, Unicode and partial framing, malformed and oversized passthrough, and busy child-process integration with projection on and both switches off. The isolated fixture proves the original active turn, child PID, permission state and input sequence remain unchanged, and the original work finishes normally. Together with existing wrapper/context tests, 22 checks passed; the full suite passed all 94 tests. No live Claude process was sent a message or restarted. Native VS Code rendering, replay availability and history after reload remain unverified; isolated protocol success is not native acceptance.

The scoped pre-change backup and hash-guarded rollback helper are under `.cooperation/backups/peer-visibility-20260909`. They preserve all changes that existed before this trial. Existing wrapper processes retain their old code until they exit naturally and the panel is reopened.


### Dedicated native follow-up (2026-09-09)

The user reopened only the existing `coop-claude-test` in this project and authorized testing. New wrapper capability `peerMessageVisibility` was confirmed; automatic maintenance was disabled and the mailbox was empty. The first wait-based attempt sent no peer: Claude used PowerShell/background execution, while the observer expected Bash. It is not counted as a visibility success.

The subsequent read-only review test sent one peer message while the original native turn was running. The native queue recorded enqueue at 07:32:37.258Z, then one user record with the same message UUID at 07:32:57.678Z after the original review completed. Claude acknowledged the marker at 07:33:01.755Z. The process and wrapper instance stayed the same and ended idle; no interrupt was sent. The user explicitly confirmed seeing the bubble with the Cooperation title. Desktop automation initialization failed, so visual confirmation is user-observed, not an automated screenshot assertion. Immediate display at enqueue and history after reload remain unverified. Evidence: `.cooperation/peer-visible-native-example-id.json`.


## Unified visible delivery and history restoration (2026-09-12)

Before changing delivery, both idle and busy submissions were retested on the dedicated `coop-claude-test`. Each produced exactly one native peer record and an acknowledgment; the busy review completed without interrupt, in the same process. The user reported both initially visible, but the latter disappearing after reopening. Evidence: `.cooperation/visible-unified-before-example-id.json`. This exposed the extension history loader's isMeta filter; it was not treated as a successful reload test.

All normal service sends now use ClaudeRuntime.sendMessage, which dispatches peer traffic without interrupt, while sendControl delegates maintenance through the same entry with its original idle/expected-state guard. Unsupported visibility is reported separately from transmission outcome. History recovery reads only the matching session transcript and follows current-branch ancestry; original files and model input remain untouched. It restores at most 200 confirmed Cooperation peers, reports truncation and read failures, and defers output to complete protocol lines.

The full automated suite passes 104 tests. New coverage includes two successive isolated wrapper launches restoring the same history with only initialize controls reaching the simulated child; byte-identical original transcript; unknown and stale branch exclusion; live/history UUID deduplication; idle and busy unified peer routing; legacy visibility disclosure; and delayed native completion after interrupt acknowledgment, during which no handoff prompt may be sent. Read-only extraction from the real dedicated transcript recovered both missing test IDs. Native panel reload of this implementation is pending user confirmation; these checks are not a substitute for it.

Rollback to the earlier, live-visible implementation: `.cooperation/backups/unified-visible-20260910/rollback.mjs`. This is a second layer above `.cooperation/backups/peer-visibility-20260909`; apply the newer rollback before the older one when reverting the entire feature. Neither helper restarts running processes.


## Restart-aware maintenance recovery (2026-09-12)

The controller now preserves its lock in waiting_client while a client is offline, unloaded or initializing; offline time does not consume the stage deadline. It polls reconnection and selected legacy attention reasons, but only a changed native instance permits automatic replay of an unfinished control prompt. Same-instance transient disconnects resume their existing state without replay. Manual intervention and evidence-based recovery refusal are preserved across manager restarts.

New-instance adoption requires the same session ID and working directory, idle native state, no observed queued inputs/background work/pending requests, no detected change in available model/effort/permission selections, matching document hash when a receipt exists, and corresponding native input/turn identity. A second native status and cycle revision check prevents overwriting concurrent user input or a late checkpoint. Missing values remain unknown; no account credentials are read. Claude continuity reads only the selected JSONL; completed compaction additionally joins the original wrapper instance/request audit with a native manual compact boundary. Codex uses its latest terminal native turn and compact completion timestamp. Unknown compactions never repeat automatically.

121 automated tests pass. Added regressions cover both clients, offline deadline pause, late receipts, accepted handoff and restore transitions, FIFO/conditional continuation, concurrent checkpoint acceptance, changed documents and models, malformed or changing history, request/instance mismatch, and refusing unknown compaction. These are isolated regression tests; no real account switching or forced production-client restart was performed for acceptance. A safe manager reload is recorded separately under `.cooperation/client-recovery-deployment.json` when performed.

Scoped rollback: `.cooperation/backups/client-recovery-20260912/rollback.mjs --apply`; it verifies current and backup hashes before restoring only this change's files. It neither restarts native clients nor edits their histories.


## Historical replay flood correction (2026-09-12)

The user reported old messages appearing in a burst after VS Code restart, then clarified that their message IDs differ. The previous automatic backfill appended old peer messages at the end of the panel. This was display restoration, not a second model input. The affected business workspace was neither read nor modified, and no native client was restarted or messaged during this correction.

At the user's choice, automatic history backfill is now off by default; live visibility remains on. Disabled backfill reports `visibilityHistory.status=disabled` and `peerHistoryVisibility=false` and does not invoke the history reader. The optional history feature requires a separate explicit setting. A second confirmed defect was also fixed: the wrapper formerly deduplicated live-before-history but forwarded subsequent duplicate native replays. Both directions now use a shared session/UUID ledger with case normalization.

Targeted tests exercise three consecutive isolated wrapper launches with history disabled and with explicit opt-in, repeated native echoes, unchanged transcript bytes, and initialize-only child input. Busy live output still preserves the active turn, process, permissions, and original completion. Two new deduplication tests failed on the old implementation before passing with the fix. These tests do not constitute a visual acceptance of the user's VS Code panel; running native wrappers keep their already loaded code until a normal restart.

The full automated suite passes 124 tests (0 failed, skipped, or cancelled); project-local log: `.cooperation/peer-replay-flood-tests.txt`.
