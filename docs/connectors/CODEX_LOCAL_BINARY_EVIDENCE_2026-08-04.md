# Codex本机二进制事件词汇证据

采集日期：2026-08-04  
证据等级：本机官方安装包静态字符串；可证明词汇存在，不能证明载荷Schema、触发时机或语义

## 样本

- Windows应用包：`OpenAI.Codex_26.727.6591.0_x64__2p2nqsd0c76g0`
- 包版本：`26.727.6591.0`
- 捆绑程序大小：358,182,192 bytes
- 捆绑程序SHA-256：`ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F`
- 检查方式：只读静态字符串搜索；未启动Codex，未读取或修改用户配置、任务、凭据和内部状态文件

## 观测结果

二进制中存在：

- `agent-turn-complete`
- `SessionStart`
- `SessionEnd`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PermissionRequest`
- `Notification`
- `SubagentStart`
- `SubagentStop`
- `Stop`
- `PreCompact`
- `hook_event_name`

这支持圆圆继续实现对应事件名的合成契约与保守映射。它不支持以下结论：字段名称已经冻结、每次事件都能送达、`Stop`等于成功、`Notification`必然等待用户、项目Hook一定已获信任，或当前桌面包与所有CLI发行版完全一致。

因此当前能力矩阵只把“事件词汇在本机样本中存在”标记为已观察；真实载荷录制、官方文档复核、Hook配置加载和非干预仍是发布阻断项。

