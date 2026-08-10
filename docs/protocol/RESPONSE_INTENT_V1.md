# response_intent v1

状态：P0协议与稳定核心消费门已实现；真实模型用户回应路径未接入；协议版本：`1`。

`response_intent` 只表达圆圆应该采用哪一类非语言回应，不携带台词、动画名、CSS、资源路径、工具名或任意动作参数。模型输出必须先由 `YuanyuanAI.exe` 校验，稳定核心再把意图映射到产品内置动作和道具。

## 载荷

```json
{
  "schema_version": 1,
  "intent": "stay_close",
  "priority": "normal"
}
```

大小上限为 8 KiB。v1 意图枚举：

| intent | 产品语义 |
| --- | --- |
| `quiet_presence` | 安静存在，不主动打断 |
| `acknowledge` | 表示听见或理解 |
| `approach` | 靠近用户 |
| `stay_close` | 留在附近陪伴 |
| `celebrate` | 轻量庆祝 |
| `needs_attention` | 请求用户注意 |
| `present_information` | 拨动信息工具展示内容 |
| `request_formal_decision` | 请求用户在正式界面做明确决定 |

优先级枚举为 `background`、`normal`、`important`、`formal`。优先级不能越过提醒冲突规则、专注降级、权限门或正式确认流程。

## 兼容与失败规则

- 未知 `schema_version`：降级为 `quiet_presence/background`；
- 未知或缺失 `intent`：降级为 `quiet_presence/background`；
- 已知意图但未知优先级：按 `normal` 处理；
- 额外字段：v1 解析器忽略，不能改变动作；
- 非法 JSON 或超过大小限制：拒绝整份输出；
- 自由文本和动画名永远不能从该协议进入宠物界面。

协议解析位于`src-tauri/crates/yuanyuan-protocol/src/content.rs`；稳定核心消费、N3信息文档门和N4正式确认卡门位于`src-tauri/src/companion_core.rs`。真实Provider输出仍未进入正式宠物运行路径。
