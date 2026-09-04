# 性格画像与自定义场景

本文件用于避免所有宠物都变成同一种“饺饺式可爱”。外形身份来自照片，性格只来自用户描述和用户确认的日常习惯。

## 收集和整理

优先使用用户主动提供的信息；不要求用户填写复杂表格。将内容压缩为一份短画像：

```text
Name: <name or unnamed>
Sex: <user-provided value or unknown>
Core temperament: <2–4 adjectives>
Energy: low | medium | high
Social style: reserved | independent | affectionate | outgoing | unknown
Confidence/curiosity: <short description>
Typical habits or gestures: <user-provided details>
Likes/dislikes: <relevant details only>
Humor level: subtle | playful | exaggerated
Must not portray: <traits that contradict the pet>
```

性别未知时保持未知；不要从照片推断。性别不自动决定配色、蝴蝶结、服装或动作。用户只给出“可爱、活泼”等宽泛形容时，用自然物种肢体语言表达，不添加未经确认的独特习惯。

## 从性格到画面

- 活泼、外向：更大的动作幅度、向前重心、明亮目光、互动性道具；不要固定张嘴吐舌。
- 安静、温柔：柔和目光、收拢姿态、低动作幅度、舒适材质和留白。
- 高冷、独立：稳定坐姿、克制目光、抬头或侧视、简洁道具；不要变成愤怒。
- 好奇、机灵：头部轻微倾斜、耳朵朝向目标、前爪探索道具、视线有明确落点。
- 慵懒、佛系：靠坐、趴卧、慢节奏互动和柔软支撑；需要运动时可表现“勉强但配合”，不能失去安全合理的动作。
- 胆小、谨慎：紧凑姿态、温和侧视、靠近安全物；避免惊恐、受伤或痛苦。
- 亲人、黏人：目光更接近镜头或熟悉物品，身体放松；不要凭空增加人物或第二只宠物。

同一性格在不同场景中应有不同表达。例如好奇可以是研究羽毛球、观察手机或探索行李箱，而不是每张图都使用同样歪头动作。

## 自定义场景卡

用户提出预设以外的场景时，先在内部建立场景卡，再写入 ImageGen 提示词：

```text
Scene name: <user-facing name>
Filename: custom-<two digits>-<english-slug>.png
Narrative intent: <what this says about the pet>
Location/background: <simple, safe setting>
Primary action: <one clear action compatible with cat/dog anatomy>
Personality expression: <gaze, ears, tail, posture, energy>
Required props: <only essential props>
Paw/prop interaction: <exact contact and orientation>
Depth order: <foreground / pet / background>
Palette and materials: <adapted to coat and user preference>
Must avoid: <scene-specific anatomy, direction, text, or safety failures>
```

## 例：健身场景的个性化

- 活泼型：在粉彩健身房做伸展或追随轻量敏捷道具，重心向前，尾巴积极但符合物种结构。
- 安静型：在瑜伽垫上做稳定拉伸，表情专注，环境简洁。
- 高冷型：端正站在器械旁，神态克制，使用低饱和配色和整齐构图。
- 慵懒型：坐在垫子上轻碰小哑铃或弹力带，表现“慢悠悠参与”，不得让器械漂浮或使用人手。

不要把健身固定成参考图中的举爪动作；根据性格和宠物身体比例选择更自然的伸展、平衡、慢跑或道具互动。危险、高温、高空或不适合动物的真实活动，应改写为安全的摄影棚布景或玩具化道具。
