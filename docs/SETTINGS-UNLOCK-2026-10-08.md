# 移除维护设置一致性限制与 OpenCode 消息声明修复

公开版本已匿名化本机会话、请求和运行标识；原始材料保留在项目本地的忽略目录中。

用户明确要求：移除思考强度一致性限制，同时处理消息问题；随后要求权限一致性限制也移除，并覆盖 Codex。

后续按用户要求补齐 OpenCode：原生接入的维护状态版本号不再包含 effort/variant 或权限配置哈希，单独改变这些设置不会使维护请求失效。提示发送使用最终检查读到的当前 variant，避免检查期间的设置变化被旧值覆盖；原生待审批请求、模型/代理变化、新输入、子任务和回滚检查保留。新增 `maintenanceSettingsLockFree` 能力标记用于确认新版接入是否已加载。OpenCode 后端重启后生效，管理服务无需再次重启。本轮 41 项关联测试通过，覆盖设置变化期间的原生请求、压缩后恢复及 FIFO；证据为 `.cooperation/verification/opencode-settings-unlock-targeted.txt`。

## 已生效的项目行为

- Claude、Codex、OpenCode 的维护推进、重连接续、手动核对及补交回执不再比较压缩前后的 effort、permissionMode 或 permissionFingerprint；思考强度或权限元数据缺失也不再单独阻塞维护。
- 额度恢复和 Claude 持久化限额记录使用同样规则。旧记录中的字段继续保留供诊断，但不作为一致性限制。已核实同一失败轮次仅发生这些设置变化时，可以使用当前设置接续。
- 不设置、复制或提升客户端权限。Codex 继续使用 `inheritThreadSettings`，Claude/OpenCode 的提示也沿用当前原生设置。
- 会话与工作目录身份、模型/代理身份、原轮次、真实额度、回执与文档哈希、未知发送结果、重复压缩、新用户输入、人工停止及原生待审批请求的处理保持。
- 项目重启后的接续确认仍按原设置执行。这不是思考强度或权限一致性检查。

## 指定会话与消息的实际证据

目标：`claude:example-id-07`。

| 事件 | 北京时间 | 证据 |
| --- | --- | --- |
| OpenCode 发送会话 提交消息 `example-id-08` | 2026-10-08 12:50:49 | 管理账本的 dispatch intent/result，transport 为 submitted |
| Claude 原生端等待接收超时 | 12:55:50 | 原生 wrapper 的 `peerDelivery.state=dropped`、`outcome=expired` |
| 维护流程 `example-id-09` 开始 | 13:02:08 | cycle 创建记录 |
| 压缩完成 | 13:05:45 | 对应请求 `example-id-10` 的 completed 和 manual boundary |
| 恢复回执及维护完成 | 13:06:05 | 完成状态、回执、恢复轮次结束记录 |

压缩前后模型均为 `claude-opus-5-5`、effort 均为 `xhigh`、权限均为 `bypassPermissions`。查询时该会话没有活动维护锁，本地队列为 0。该消息的过期早于本次压缩，不能归因于压缩前后设置变化。

旧原生状态只留下 expired，没有保留对应 held cause，故不能把某个具体 hold 原因当作已记录事实。代码核对确认了独立缺口：旧发送端只为 Codex/Claude 生成发送方权限声明，OpenCode 始终没有声明。已安装 Claude 2.1.280 原生解析器及默认策略的离线回放确认：bypass 接收端对缺少声明的消息暂存，对真实 prompting 发送方也按原生跨模式规则暂存。

## 消息修复与权限边界

OpenCode 插件现在通过其既有 SDK 的原生 `/agent` 只读接口取得选中 agent 的规则，与会话规则合并，并仅导出 `bypass` / `prompting` / unknown，不保存 agent 提示词或配置内容。只在完整生效规则证明全部允许时声明 bypass；ask、deny、缺失或不支持的规则不会被改写成 bypass。规则次序与 API 路径依据 [OpenCode 权限文档](https://opencode.ai/docs/permissions/) 和 [Server 文档](https://opencode.ai/docs/server/)。

尚不能核实发送方权限时，新的投递明确返回未提交并保留本地队列；相应的接收端 peer intent 会撤销，避免制造“等待消息”的假状态。原生端报告过期时，之后的新版 wrapper 会保留此前的 held cause，方便区分接收策略和维护状态。

Claude 原生的消息接收策略没有被修改；发送声明反映实际发送方模式。不同权限类别是否允许互相发送，由原生客户端的接收设置决定。已过期消息没有自动重发，没有修改其原始传输账本或伪造已接收回执。

生产 OpenCode 后端尚未加载新的 `peerPermissionSelection` 能力，发送端修复需在空闲后重启原 OpenCode 后端。Claude 接入层的额度记录与 held cause 更新在下次原连接重启后加载。管理端的一致性限制移除已上线，Codex 无需重启原生客户端。

## 验证与上线

- 完整自动测试：373 通过，0 失败、跳过或取消。
- 浏览器：3 组通过，0 页面错误。实际点击 Claude/Codex 的“检查并继续”，确认变更后的 effort/permissions 保持原值且只发送一次恢复提示，不重复压缩；包含 390px 布局。
- 真实 socket 夹具确认：发送方模式未知时不写入 socket；核实后使用真实声明投递。
- 原生策略离线回放：OpenCode 完全允许的规则对应 bypass 并接受，受限规则对应 prompting 并按原生规则暂存，unknown 不冒充 bypass。未进行真实消息投递或模型调用。
- 一次全量运行出现 Windows wrapper 启动夹具超时；单独复核和随后全量通过，保留为测试运行现象，不认定为生产缺陷。

证据位于 `.cooperation/verification/`：`settings-unlock-full-tests.txt`、`settings-unlock-browser.json`、`opencode-peer-mode-native-replay.json`、`settings-unlock-deployment.json`。前期 154 项针对性结果为 `effort-unlock-targeted.txt`。

北京时间 13:39:53 更新项目管理服务至 PID（本地记录），地址保持 `http://127.0.0.1:<port>`。备份位于 `.cooperation/backups/settings-unlock-<timestamp>`。更新前后 2 个暂停流程、全部回执、策略和待发/未知发送记录核对一致；没有重启原生客户端，没有替用户确认重启接续，也没有重发该过期消息。
