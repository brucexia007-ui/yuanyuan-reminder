# 私人知识包整理提示词

把本文件与用户有权使用的 PDF、Word、Markdown、TXT 或表格交给 Coding 智能体。智能体只负责在用户本机把资料整理成声明式 JSON；提醒应用本身不解析这些文档，也不联网获取内容。

```text
请将我提供且有权使用的资料整理为本应用支持的 learning-pack v1 JSON。

开始前读取：
- customization/learning/learning-pack.schema.json
- customization/learning/learning-pack.synthetic.example.json

要求：
1. 先询问并原样记录我的权利基础，只能使用 self_authored、public_domain、open_license、authorized、personal_use_only 或 unknown。
2. unknown 必须停止最终制包；personal_use_only 必须令 redistributable=false，不得生成公开分发建议。不要替我作出法律结论。
3. 每张卡必须有稳定 cardId、recall 或 choice、prompt、answer、sourceRefs 和 scheduleEpoch。choice 必须包含正确答案及 1—3 个明确干扰项；无法保证时改为 recall，不要猜测或补造知识。
4. 保留能够定位原资料的 sourceRef；不要把本机绝对路径、账号、姓名或其他私人信息写入包。
5. 不创建脚本、宏、远程 URL 资源、媒体或可执行扩展。未知字段不得保留。
6. 单包最多 20,000 卡、25 MiB；prompt 2,000 字符、answer 4,000 字符、explanation 8,000 字符、标签 32 个。
7. 计算排除 contentSha256 字段后的规范 JSON SHA-256，写入 contentSha256。
8. 运行：node customization/learning/validate-learning-pack.mjs <pack.json>
9. 再运行：node customization/learning/generate-learning-pack-report.mjs <pack.json> --output <report.md>
10. 把包和报告放在 work/personal-learning/<run-id>/；不得放入 Git、public、src-tauri/resources、安装包、Release 或测试日志。

输出时说明：卡片数、recall/choice 数、新增来源、权利声明、内容哈希、验证结论，以及仍需用户人工核对的歧义。不要声称内容由应用官方提供。
```
