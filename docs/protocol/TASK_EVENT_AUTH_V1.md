# 圆圆任务事件认证协议v1

状态：P0冻结候选<br>
日期：2026-08-03<br>
实现：`src-tauri/crates/yuanyuan-protocol`、`src-tauri/crates/yuanyuan-bridge`

## 目标与边界

本协议让本机连接器向圆圆证明任务事件来自持有对应密钥的已登记实例，并抵抗载荷篡改、跨实例冒充、短时间重放和JSON字段顺序差异。它不证明源工具本身可信，也不把Hook事件自动提升为用户可见事实。

密钥正文必须保存在Windows Credential Manager，不进入SQLite、配置、日志、崩溃报告或备份。P0已实现固定目标命名空间、正式创建/轮换/吊销、连接器身份绑定、SQLite nonce唯一约束和最终AI数据库原子提交；生命周期细节见 `CONNECTOR_TRUST_LIFECYCLE_V1.md`。真实Hook安装、信任审核和连续认证失败停用仍未完成。

## JSON外壳

认证事件保持原任务事件字段，不复制或Base64包装载荷，因此仍受Bridge解析前64KiB总输入上限约束：

```json
{
  "auth": {
    "auth_version": 1,
    "key_id": "codex.installation-1",
    "nonce": "CQkJCQkJCQkJCQkJCQkJCQ",
    "signed_at_unix_ms": 1775212800000,
    "mac": "3y03HYFlVZeqmQ6lhk0ekmYGpIpZOUxu_I4LxCmVWFQ"
  },
  "protocol_version": 1,
  "event": {}
}
```

- `key_id`：1—64字节，只允许小写ASCII字母、数字、点、下划线和连字符；
- `nonce`：16个随机字节的Base64URL无填充编码，每个事件必须唯一；
- `signed_at_unix_ms`：UTC Unix毫秒；验证窗口为本机当前时间前后各5分钟；
- `mac`：32字节HMAC-SHA-256的Base64URL无填充编码；
- HMAC密钥至少32字节；未知或已吊销`key_id`必须拒绝。

## HMAC消息

所有整数使用大端序，字符串使用UTF-8。HMAC输入严格依次为：

1. 固定ASCII前缀`yuanyuan.bridge.authentication.v1`和一个NUL字节；
2. `auth_version`：u16；
3. `key_id`：u16字节长度＋正文；
4. `nonce`：u16字节长度＋16字节正文；
5. `signed_at_unix_ms`：有符号i64的二进制补码；
6. 规范任务事件消息：u32字节长度＋正文。

规范任务事件消息不依赖JSON文本形式。其前缀为`yuanyuan.task-event.protocol.v1`和一个NUL字节，随后为u16 `protocol_version`，再按以下固定顺序编码已知字段：

`event_id`、`connector_id`、`source_instance`、`task_id`、`run_id`、`parent_task_id`、`source`、`external_id`、`title`、`workspace`、`state`、`progress`、`summary`、`attention_reason`、`evidence_type`、`evidence_level`、`sequence`、`occurred_at`、`received_at`、`started_at`、`updated_at`、`completed_at`、`finality`、`return_action`、`payload_digest`、`raw_payload_ref`。

编码规则：

- 必填字符串：u32字节长度＋UTF-8正文；
- 可选值：不存在为字节0，存在为字节1后跟对应值；
- `progress`：存在标志＋IEEE-754 f32位模式的大端u32；
- `sequence`：大端u64；
- `return_action`：存在标志＋`action_id`必填字符串＋`target`可选字符串；
- `state`：queued=0、running=1、waiting_user=2、succeeded=3、failed=4、cancelled=5、stalled=6、unknown=7；
- `evidence_type`：hook=0、api=1、exit_code=2、process=3、user=4、inferred=5；
- `evidence_level`：authoritative=0、partial=1、presence_only=2、unknown=3；
- `finality`：provisional=0、terminal=1、corrected=2。

同一认证版本内不得调整上述顺序、整数宽度、枚举编码或字段语义。新增有语义字段时必须升级认证版本，不能让未签名字段影响状态机或工具调用。

## 验证顺序

1. 在JSON解析前执行64KiB上限；
2. 验证认证版本、字段形状和5分钟时间窗；
3. 解析任务事件并执行协议校验；
4. 使用事件内的`connector_id + source_instance`、`key_id`、签名时间和当前时间查询信任权限，授权后才从Credential Manager取钥并以常量时间校验HMAC；
5. HMAC成功后，以原子“仅首次写入”方式登记`key_id + nonce`；
6. nonce已存在、密钥存储不可用或nonce存储不可用时一律拒绝事件；
7. 认证失败不进入任务状态机、不写原始载荷日志，并保持Hook退出码0。

## 冻结测试向量

实现中的固定向量使用：32字节`0x42`密钥、`key_id=codex.installation-1`、16字节`0x09` nonce、`signed_at_unix_ms=1775212800000`以及测试夹具中的完整任务事件。

- nonce：`CQkJCQkJCQkJCQkJCQkJCQ`
- mac：`3y03HYFlVZeqmQ6lhk0ekmYGpIpZOUxu_I4LxCmVWFQ`

任何连接器SDK只有同时通过该向量及篡改、过期、未来时间、未知密钥和重放用例，才能声明兼容认证协议v1。
