# ADR-0002：任务事件协议v1与兼容规则

状态：Accepted for P0<br>
日期：2026-08-03<br>
对应实现：`src-tauri/crates/yuanyuan-protocol`<br>
对应方案：最终设计13.2、开发方案P0-E03/P1-E02

## 背景

Codex、Claude Code和本地命令提供不同事件字段、时序与证据能力。稳定核心不能直接依赖任一来源的原始Hook格式，也不能把进程存在或模型摘要误认为任务成功。

## 决策

所有来源先由版本化连接器转换成统一 `TaskEventEnvelope`，再进入认证、持久化和状态机。协议v1由无Tauri依赖的 `yuanyuan-protocol` crate定义。

协议核心包含：

- `protocol_version`：当前为1，不支持的版本在状态更新前拒绝；
- `event_id/connector_id/source_instance/task_id/run_id/external_id`：去重、归组和多实例隔离；
- `source`：小写命名空间，例如 `openai.codex`；
- `state`：queued、running、waiting_user、succeeded、failed、cancelled、stalled、unknown；
- `evidence_type/evidence_level`：区分Hook、API、退出码、进程存在、用户和推断，以及权威、部分、仅存在、未知证据；
- `sequence` 与时间字段：处理乱序、迟到和重放；
- `finality`：provisional、terminal、corrected；
- `return_action`：产品注册动作标识和不透明目标，不接受任意URI或命令；
- `payload_digest/raw_payload_ref`：用于审计和受控本地引用，原始载荷不直接进入模型。

## 验证与兼容规则

- JSON新增未知字段默认忽略，以支持同版本前向扩展；
- 删除字段、改变字段含义、增加必填字段或改变状态/终态规则必须升级协议版本；
- 非终态只能是provisional；成功、失败、取消不能是provisional；
- `waiting_user` 必须有非空 `attention_reason`；
- progress必须是0—1之间的有限数；
- 标识、标题、工作区、摘要和原始载荷引用有显式长度上限；
- `return_action.action_id` 只接受小写字母、数字、点、下划线和连字符；实际动作和目标仍需稳定核心注册表二次校验；
- 任务不能把自身声明为父任务；父关系允许首次补全，同一运行内不得静默改挂；
- 序号在同一任务生命周期内跨运行单调递增；活动运行不能被另一运行替换，曾经实际生效的旧运行不能回流；
- 非权威终态不会锁死任务，允许后续运行事件或更强证据更新；只有权威终态变更才要求`corrected`；
- 未支持协议、无效来源、超长载荷和非法终态在持久化和UI更新前拒绝，并记录脱敏诊断。

## 信任边界

协议校验不等于来源认证。Bridge后续仍必须验证按来源实例隔离的HMAC密钥、`key_id`、nonce、时间窗和事件去重。CRC32C只证明落盘完整性，不替代HMAC。

协议事件也不等于用户可见事实。任务状态机结合证据等级和连接器能力矩阵决定显示“完成”“失败”“可能停住”或“状态未知”。`waiting_user/succeeded/failed/cancelled`只有权威证据才进入确定表达，其余统一投影为`unknown`，详见`protocol/TASK_STATE_RESOLUTION_V1.md`。

## 当前实现证据

协议crate已经覆盖：

- 合法权威运行事件；
- 未知JSON字段前向兼容；
- 不支持协议版本；
- 非法progress；
- 终态/finality矛盾；
- `waiting_user`缺少理由；
- 无命名空间来源；
- URI式返回动作；
- 超长摘要；
- 重复、乱序、序号碰撞和新运行；
- 活动运行替换拒绝、已经生效的旧运行回流阻断，以及提前拒绝后允许合法新运行；
- 终态重复、权威终态显式修正、非权威终态继续运行/增强证据和非法状态回退；
- 父子任务乱序到达、父关系补全/保留/禁止改挂；
- 同一任务转换过程中工作区或身份字段变化，以及数据库层跨工作区隔离。

HMAC、命名管道、状态持久化和连接器原始载荷解析已分别进入Bridge、AI任务库和连接器crate，并有组合测试；真实签名Hook、目标版本载荷和长期运行证据仍属于P0-E04/P1-E05—E06/P1-E11门禁，不能由合成契约替代。

## 后续变更要求

任何协议变更必须同时更新：Rust类型、Schema、兼容表、Codex/Claude夹具、Bridge测试、状态机测试和本ADR。未知协议不能猜测映射，必须拒绝状态更新并安全降级。
