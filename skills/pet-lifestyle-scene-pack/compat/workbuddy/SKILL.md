---
name: pet-lifestyle-scene-pack
display_name: 宠物生活场景写真套装
display_name_en: Pet Lifestyle Scene Pack
description: 根据宠物照片、性格和自选场景生成身份统一、富有个性的柔和生活写真
description_zh: 根据猫狗照片、名字、性别、性格与期望场景生成个性化生活写真
description_en: Create individualized pastel lifestyle portraits from cat or dog photos, personality, and requested scenes
category: image
version: 1.1.0
author: brucexia007-ui
disable-model-invocation: false
user-invocable: true
---

# 宠物生活场景写真套装

用户照片决定宠物外形；名字、用户明确提供的性别、性格、习惯和期望场景决定动作与叙事。内置饺饺图片只能提供柔和写真风格和构图灵感，不得复制她的外形、固定表情或性格。

## 执行前读取

- @references/identity-lock.md
- 用户提供性格或自定义场景时读取 @references/personality-and-custom-scenes.md
- 生成预设场景时读取 @references/scene-specs.md
- 写生图指令时读取 @references/prompt-template.md
- 接受或修复结果前读取 @references/qa-and-repair.md
- 内置参考图清单：@references/reference-scenes/manifest.json

## 工作流

1. 检查 3–8 张同一只猫或狗的照片，建立外形身份锁定；缺少关键视角时请用户补充，未知特征不得编造。
2. 将用户给出的性格压缩为能影响目光、耳位、尾势、姿态、动作幅度、道具和环境细节的性格画像。性别未知时保持未知，不使用性别或品种刻板印象。
3. 用户可以选择十三个预设，也可以提出健身、露营、生日等新场景。自定义场景先建立场景卡，不强行照搬饺饺构图。
4. 使用 WorkBuddy 当前可用的图片理解和图片生成/编辑能力。若缺少必要工具，明确说明，不要求用户配置新的付费外部服务。
5. 先生成一张能看清正脸、体态和性格的 3:4 预览，确认后每个场景单独生成一张图片；禁止拼图。
6. 每张图片检查身份、性格、动作、道具方向、肢体数量、文字和水印。失败图只修该张，最多两轮。

用户宠物原图只能用于当前任务，不得写入 Skill、公开目录、日志或分发包。参考图片依 @references/REFERENCE_ASSETS_LICENSE.md 仅限非商业使用。
