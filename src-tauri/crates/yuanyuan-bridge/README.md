# yuanyuan-bridge

圆圆任务桥的快速路径内核。

当前实现负责：

- 在解析前限制输入大小；
- 把JSON解析成 `yuanyuan-protocol` 事件并执行共享校验；
- 通过 `EventSink` 抽象把合法事件交给后续受限传输；
- 把队列满、主程序不可用和传输错误转换为脱敏结果码；
- 固定Hook调用路径始终返回成功的fail-open契约；
- 提供只接受本机逻辑名称的Windows命名管道客户端；
- 提供1秒连接目标和3秒进程级硬超时常量，以及可独立测试的硬超时看门狗；
- 提供从stdin读取事件的静默CLI入口，所有已知错误路径均保持退出码0且不写stdout/stderr；
- CLI可在显式来源模式下把Codex `notify`/Hooks和Claude Code Hooks原始JSON先交给独立适配层，丢弃敏感内容、生成不透明标识，再使用Credential Manager密钥签名；
- 提供HMAC-SHA-256认证外壳、规范签名消息、5分钟时间窗、密钥解析和原子nonce登记接口；
- 只有认证成功的事件才会进入后续 `EventSink`；
- 提供只读Windows Credential Manager密钥解析器，凭据目标固定在`Yuanyuan/TaskEventKey/`命名空间；
- 提供SQLite nonce存储，使用`key_id + nonce`主键保证重启和并发连接下的首次写入语义；
- 提供单连接Windows命名管道服务端，DACL只允许当前用户SID，并设置`PIPE_REJECT_REMOTE_CLIENTS`；
- 提供受限事件暂存：版本化帧、CRC32C、原子改名、内容去重、跨进程锁、硬容量、隔离区和有序重放；
- 投递失败前只做HMAC预验证且不消费nonce，最终重放接收时才登记nonce并确认删除。

尚未实现：

- 正式受权的Credential Manager密钥创建、轮换、吊销和重置信任产品流程（目前只有受控真实夹具）；
- 真实第二Windows账户、历史签名版本、系统睡眠恢复和24/72小时增长验证；
- 目标Codex/Claude版本的官方Schema复核、脱敏真实载荷和真实Hook非干预测试；
- 配置合并、备份、信任确认和仅撤销圆圆拥有片段的实现；
- CLI诊断文件、签名后的正式文件名和安装包集成。

硬超时看门狗依赖短生命周期Bridge进程在返回后立即退出。它不是用于长期驻留进程中取消任意阻塞线程的通用机制。

在上述边界通过P0验证前，本crate不会加入安装包或连接真实Hook。
