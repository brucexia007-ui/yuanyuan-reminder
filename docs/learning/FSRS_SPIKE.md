# LRN-003：FSRS Rust 调度刺探

状态：算法选择与生产适配器已冻结；最终安装包体积、外部向量与 NOTICE 门待闭环<br>
日期：2026-08-10<br>
运行目标：仅本地调度，不训练个性化参数，不引入安装后网络或外部运行时

## 候选证据

| 项目 | `rs-fsrs` 1.2.1 | `fsrs` 6.6.1（fsrs-rs） |
| --- | --- | --- |
| 组织 | Open Spaced Repetition | Open Spaced Repetition |
| 许可证 | MIT（license-file） | BSD-3-Clause |
| 参数模型 | 19 个参数 | 21 个参数 |
| 遗忘曲线 decay | 固定 `0.5` | FSRS-6 默认 `0.1542`，作为第 21 参数 |
| 运行 API | 完整 Card/Rating 调度 | `MemoryState + next_states` |
| 优化器 | 无 | crate 内包含，但圆圆不调用 |
| 圆圆依赖树增量 | 未进入最终选择 | 相对默认 feature 增加 22 个唯一 normal package |

`rs-fsrs` 的 API 更直接、依赖更轻，但当前 1.2.1 源码仍是 19 参数和旧 decay。`fsrs` 6.6.1 使用 21 参数 FSRS-6 默认模型，调度一致性优先于 API 便利和初始体积，因此圆圆选择后者，并用薄适配器隔离。

## 冻结合同

- crate：`fsrs = 6.6.1`，仅由 Cargo `learning` feature 引入；
- 参数：第一版使用 crate 的 FSRS-6 默认参数；
- 目标保持率：`0.9`；
- 映射：`忘了 → Again(1)`、`模糊 → Hard(2)`、`记得 → Good(3)`；不向用户暴露 Easy；
- 时间：数据库保存 UTC Unix 毫秒；elapsed days 只由后端计算；系统时间回拨直接拒绝评分；
- 间隔：算法浮点天数四舍五入并限制为 `1..=36500` 天；
- 用户状态：至少 3 次复习且 stability ≥ 21 天时，才显示“相对稳定”；这只是调度状态，不是考试掌握证明；
- 第一版不训练用户参数，不调用 simulation/training/optimizer API。

## 冻结向量

固定当前时间 `1800000000000`：

- 新卡 Again stability `0.212`；
- 新卡 Hard stability `1.2931`；
- 新卡 Good stability `2.3065`；
- 连续五次按到期日选择 Good，间隔为 `[2, 11, 46, 163, 497]` 天；
- 部分 memory state、非有限值、计数矛盾和时钟回拨全部关闭失败。

向量由 `learning::scheduler_adapter::tests` 固定，依赖升级必须显式更新报告并重新评审，不能只更新 `Cargo.lock`。

## 尚未关闭的发布门

1. 分别构建 default/learning release EXE，记录净体积和冷启动增量；当前手动评分生产路径已经调用适配器，因此后续测量不再受“适配器未链接”干扰；
2. BSD-3-Clause 许可证进入 `THIRD_PARTY_NOTICES.md`、生成的第三方许可证清单与 SBOM；
3. 与冻结的 Anki/FSRS-6 外部参考向量做第二来源一致性验证；
4. 若体积或冷启动超过新版本冻结阈值，先评估拆出 scheduler-only 上游能力，不得静默降级回旧算法。

以上任一项未完成时，学习模块可以继续在实验 feature 下开发，但不得进入正式安装包。
