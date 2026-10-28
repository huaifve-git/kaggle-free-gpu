# 提示词手册：SDXL 配方

## 基本结构

```
<主体> + <环境/光线> + <材质/细节> + <镜头/画质>
```

按这个顺序写，权重从高到低。示例：

```
Photorealistic rime ice forest at sunrise, every birch branch coated in thick
white hoarfrost, untouched deep snow, blue mist between trunks, warm golden
light rays, sparkling frost crystals, ultra detailed, 35mm photo
```

**硬约束**：整条 ≤ 77 CLIP token。英文单词数 × 1.3 + 标点 ≈ token 数，控制在 45 词以内比较安全。

## 通用负向提示词

```
lowres, blurry, jpeg artifacts, watermark, signature, text, extra fingers,
deformed hands, bad anatomy, extra limbs, oversaturated, cartoon, cgi, plastic skin
```

人像再追加：`asymmetric eyes, cross-eyed, mutated hands, fused fingers, long neck`。
风景再追加：`people, buildings, power lines, distorted horizon`。

## 配方：自然风景

- 关键在**具体名词**而不是形容词。写 `birch`、`hoarfrost`、`blue mist`，不要写 `beautiful nature`。
- 光线词决定成片气质：`sunrise` / `overcast` / `blue hour` / `golden light rays`。
- 加 `35mm photo` 或 `wide angle landscape photograph` 拉真实感，比堆 `8k uhd` 有效。
- 需要留白（后期加字）时补 `minimal composition, negative space at top`。

## 配方：人像

- 焦段 + 光圈是性价比最高的两个词：`85mm lens, shallow depth of field`。
- 皮肤质感写 `natural skin texture`，并负向压 `plastic skin`，否则容易蜡像感。
- 光照写 `soft daylight` / `window light` / `overcast light`，避免 `studio flash` 的硬阴影。
- 服装和环境要写清楚，模型会自行补全没描述的部分。

## 未成年人肖像的硬规则

生成未成年人图像时，**必须**同时满足：

- 主体描述含 `fully clothed, modest, age appropriate`；
- 负向提示词必带 `nsfw, nude, shirtless, underwear, swimwear`；
- 场景选日常向（户外、校园、家庭、运动），避免任何身体特写或暗示性姿势；
- 出图后人工过一眼，任何不符合上述要求的直接重跑，不交付。

## 种子策略

- **复现**：固定 `seed`，其它参数不动，改动只会来自提示词。
- **挑图**：同一条提示词跑 3–4 个不同种子，人工选最优，再回填选中种子。
- **探索**：`seed: -1`，脚本会随机取种并把实际用的种子写进 `manifest.json`。

## 分辨率

SDXL 原生 1024×1024。非方形用接近百万像素的组合，避免构图崩坏：

| 用途 | 尺寸 |
| --- | --- |
| 方形头像/封面 | 1024×1024 |
| 竖版人像/手机壁纸 | 832×1216 |
| 横版风景/桌面壁纸 | 1216×832 |
| 宽幅横幅 | 1344×768 |

不要直接跑 2048 —— SDXL 会在该尺寸重复生成主体（多头多手），需要高清化就走
`StableDiffusionUpscalePipeline` 或 img2img 二次采样。
