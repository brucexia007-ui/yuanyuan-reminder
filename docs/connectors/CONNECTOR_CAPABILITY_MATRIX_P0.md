# P0连接器能力矩阵

更新时间：2026-08-04  
状态：官方 Hook 格式与事件语义已复核；真实版本/载荷/实机证据尚未冻结，不得用于发布声明

## 1. 证据说明

本轮已复核 Codex 当前官方 Hooks/配置参考与 Claude Code 当前官方 Hooks/设置文档，冻结了 JSON/TOML 配置外形、配置来源叠加规则和事件字段语义；这些资料没有替代目标版本真实载荷、实机信任/退出行为，也没有授权改动用户真实 Hook 配置。另对本机官方 Codex 桌面包 `26.727.6591.0` 做过只读静态词汇检查。所有夹具仍标记为 `synthetic_contract`，只证明圆圆在不确定输入下不会泄露内容或干预源任务。

进入发布候选前，必须补齐目标版本号、官方语义复核、脱敏真实录制载荷和实机 Hook 退出行为；完成前界面只能显示“有限兼容”。

## 2. 当前能力矩阵

| 来源 | 接口 | running | waiting_user | succeeded | failed | cancelled | 版本状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Codex | `notify` | 不提供 | 不提供 | `agent-turn-complete`，仅部分证据 | 不提供 | 不提供 | 未冻结真实版本；有限兼容 |
| Codex | Hooks | `SessionStart`、提示提交、工具、压缩、子任务事件，部分证据 | `PermissionRequest`，不返回批准或拒绝 | 暂无可信普通任务终态 | 暂无可信普通任务终态 | 暂无可信普通任务终态 | 官方格式/Schema 已复核；目标版本和真实载荷待冻结 |
| Claude Code | Hooks | `SessionStart`、`TaskCreated`、工具事件等，部分证据 | `PermissionRequest` 与已知 `Notification` 类型 | `TaskCompleted` 事件本身，不读取虚构 status | `StopFailure`，只作为本轮 API 错误的部分失败证据 | 暂无可信普通任务取消事件 | 官方格式/Schema 已复核；目标版本和真实载荷待冻结 |

保守规则：

- 两个来源的 `Stop` 一律映射为 `unknown + provisional`，不证明用户目标成功或失败；Claude `StopFailure` 映射为 `failed + partial`，同时丢弃错误正文；
- Claude `TaskCompleted` 官方没有 `status` / `task_status`；合成载荷中的 `failed/cancelled` 字段不能改变完成语义；
- `PostToolUseFailure` 只说明一次工具调用失败，任务保持 `running`；
- 来源声明未知 schema 版本时，即使事件名看似完成，也只能产生 `unknown + provisional + unknown evidence`；
- 缺少任务、线程、会话等稳定身份时忽略，不使用标题、路径或提示词猜测归组；
- 来源没有可靠顺序号时使用连接器入口分配的单调序号；原始顺序号存在时原样保留，交给统一状态机处理乱序；
- 相同 JSON 即使属性顺序不同，也生成相同载荷摘要和事件 ID。

## 3. 数据边界

进入统一事件的内容只有固定来源标题、用户批准的工作区别名、状态、时间、序号、证据和不可逆标识。以下字段只检查是否存在，随后丢弃：`cwd`、`prompt`、`input_messages`、`last_assistant_message`、`message`、`tool_input`、`tool_response`、`transcript_path`。

当前不生成返回深链，不保存原始载荷引用，也不读取 Codex/Claude 私有数据库。

当前安装发现只检查普通可执行文件、Codex 桌面应用注册/管理位置和 Claude 官方原生用户安装位置；不启动来源程序、不返回绝对路径。设置页把安装、授权、Hook 与事件健康分开显示，始终标记“有限兼容”。详细契约见`CONNECTOR_DISCOVERY_AND_HEALTH_V1.md`。

## 4. 发布阻断项

1. 冻结各来源至少一个最低与最高支持版本，并保存安装包或可复现实验环境；
2. 每种宣称状态至少一份脱敏真实载荷，夹具元数据记录工具版本、触发步骤和敏感字段；
3. 实测 Hook 正常、Bridge 缺失、无效载荷、队列满和超时路径均为空决策、退出码0、不改变源任务结果；
4. 在已冻结格式上实现多事件聚合、无损三方合并、备份、信任确认和仅撤销圆圆片段；
5. 未观测到真实 `failed/cancelled` 权威事件时，产品不得用确定性失败/取消动画或文案。
