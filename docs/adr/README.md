# 圆圆智能陪伴架构决策记录

本目录保存 P0 起影响多个模块、数据边界或发布兼容性的架构决策。

状态约定：

- Proposed：正在验证，不得作为正式依赖；
- Accepted for P0：已足以指导P0/P1实现，仍需用阶段质量门验证；
- Accepted：已通过对应阶段质量门；
- Superseded：被后续ADR替代，保留历史原因；
- Rejected：经评审明确不采用。

当前记录：

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [0001](0001-process-fault-domains.md) | 稳定核心、智能进程与任务桥故障域 | Accepted for P0 |
| [0002](0002-task-event-protocol-v1.md) | 任务事件协议v1与兼容规则 | Accepted for P0 |
| [0003](0003-bridge-fail-open-contract.md) | Bridge快速路径与fail-open契约 | Accepted for P0 |
| [0004](0004-task-event-authentication.md) | 任务事件HMAC认证与重放防护 | Accepted for P0 |
| [0005](0005-bounded-event-spool.md) | 受限事件暂存、损坏隔离与安全重放 | Accepted for P0 |
| [0006](0006-ai-task-database-commit-boundary.md) | AI任务数据库与确认提交边界 | Accepted for P0 |
| [0007](0007-ai-process-supervision.md) | AI进程健康、退避与熔断监督 | Accepted for P0 |
| [0008](0008-return-action-registry.md) | 返回原工具的注册动作与目标校验 | Accepted for P0 |
| [0009](0009-ai-backup-and-portable-export.md) | AI本机备份、便携导出与墓碑恢复顺序 | Accepted for P0 |

协议、进程边界、数据库归属、权限、网络出口、备份密钥或危机安全资源的变更必须新增或更新ADR，不能只修改代码。
