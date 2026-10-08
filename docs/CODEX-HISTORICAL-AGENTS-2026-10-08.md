# Codex 历史子任务误阻塞额度接续

公开版本已匿名化本机会话、请求和运行标识；原始材料保留在项目本地的忽略目录中。

目标会话：`codex:example-id-03`（示例研究会话）。

## 原因与修复

17:23 的实际账户额度可用，但旧投影只要历史里出现任何 `collabAgentToolCall` 就设置 `subagentHistoryPresent=true`，并永久关闭自动维护能力。该会话的原生历史含 19 个已完成子任务和 47 个已完成、接收方列表为空的 wait 调用；当前没有子任务、待审批请求或原生目标在运行。

另一个问题是重连被后台工作检查阻塞时，额度恢复逻辑提前返回，不再更新保存的额度解释。于是界面同时展示 10 月 6 日的“额度尚未恢复”和 10 月 8 日的账户可用结果。

现在保留“存在历史子任务”作为诊断信息，单独根据原生生命周期记录判断是否仍有未结束工作。已完成记录不再阻塞；新开始或再次交互的子任务、未完成控制调用、缺失状态和无法确定顺序的混合历史仍需要核对。完成 spawn/wait 调用本身不等于子任务完成，不以此直接放行。旧适配器没有新状态字段时继续使用原有保护。

额度查询与接续就绪检查分开：等待子任务、模型同步等条件时仍刷新额度。界面优先展示当前有效的账户结果，不再拼接过时的“额度耗尽”解释。

## 验证

- 139 项针对性测试通过；全量 385 项通过，0 失败、跳过或取消。
- 4 组实际浏览器检查通过：真实就绪阻塞与可用额度同时说明、完成的历史任务不再产生等待文案、390px 布局、提交继续后转为工作中。
- 实时只读投影确认该会话 `knownAgents=19`、`pendingAgents=0`、`pendingControls=0`、`uncertain=false`，自动接续能力恢复。
- 覆盖重新交互、未完成 spawn、空 wait、重复历史、顺序不明历史和旧适配器；额度恢复经实际 IPC 夹具验证只发送一次。

证据位于 `.cooperation/verification/`：`researcher-quota-before.json`、`researcher-quota-projection.json`、`researcher-quota-targeted.txt`、`researcher-quota-full-tests.txt`、`researcher-quota-browser.json`。

## 上线与实际结果

北京时间 17:47:39 更新管理服务至 PID（本地记录），地址保持 `http://127.0.0.1:<port>`，备份位于 `.cooperation/backups/researcher-quota-<timestamp>`。原维护、策略、回执及队列保持。首次预检发现新增的一条 示例研究会话 待发消息，脚本在停止服务前退出；核对它确实由原生限额失败状态保留且没有在途发送后才更新。

更新后按原规则生成新的接续确认。随后管理记录已为 approved；本次修复没有代替用户调用确认接口。系统在 **17:48:08** 提交一次原失败轮次的继续请求，状态为 submitted，返回原生轮次 `example-id-04`。

排队消息 `example-id-05` 于 **17:48:11** 提交，账本只有一组 dispatch intent/result，队列已清空。17:50 的原生状态显示 示例研究会话 正在新轮次中运行，已发出实际任务进展。随后只读核对确认：原额度继续轮次为 interrupted；该排队消息编号已匹配到新轮次 `example-id-06` 的原生 userMessage，状态为 inProgress。未据此断言原中断原因或原业务已完成，也没有重复继续请求。提交、原生运行与最终业务完成仍分别记录。最终证据：`researcher-quota-deployment.json`、`researcher-quota-after.json`。
