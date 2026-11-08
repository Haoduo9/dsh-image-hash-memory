# dsh-image-hash-memory

让 DSH 记住「这张图我见过」。

跨会话、跨模型切换、跨重启都认得出来：给模型的每张图算一遍感知哈希，
查本地 SQLite 库，命中就把**这张图首次出现的时间、发过几次、当时聊了什么**
注入回上下文。零 token 成本（纯本地位运算），单次检索毫秒级。

> 这是 [image-hash-memory](https://github.com/Haoduo9/image-hash-memory)（Hermes Agent 版）
> 的 DSH 重写：算法一致，宿主层按 Cordis 的接口重做。

---

## 它解决什么

多模态模型的「视觉失忆」有三个典型症状：

1. **会话被压缩后** —— 图片本身还在上下文里，但图下面的解释没了；
2. **换模型 / 重启后** —— 同一个截图再发一次，重新识别、重新计费；
3. **重复截图** —— 用户自己都忘了发过，模型更不知道。

这个插件在**图片层面**建索引：像素上相似 = 同一张图，不管文件名、
不管在哪台机器、不管隔了多久。

---

## 怎么实现的

### 三层感知哈希（各 64 bit）

| 哈希 | 抗什么 | 说明 |
|---|---|---|
| **dHash** | 裁剪、比例变化 | 8×9 灰度梯度差，看「亮暗怎么变化」 |
| **aHash** | 轻微缩放 | 8×8 灰度均值二值化，最便宜的一档 |
| **pHash** | 滤镜、调色、对比度 | 32×32 → 2D DCT 取低频 8×8 |

### 综合双门禁（默认）

```yaml
hammingThreshold: 24   # dHash 距离上限
phashThreshold: 12     # pHash 距离上限
verificationMode: composite   # 两道都要过
```

只看 dHash 时，「构图一样、颜色被极端调过」的两张图会被误判成同一张。
pHash 拿 DCT 低频能量兜第二道，误判率大幅下降。
想放宽就改成 `verificationMode: dhash`。

### 匹配流程

```
本轮用户消息
  └─ 有 ImageBlock？ ──否──> 清掉上一轮的注入，结束
        │是
        ├─ 向 attachments 服务要字节
        ├─ 算 dHash / aHash / pHash
        ├─ 查库（dHash ≤ 24 且 pHash ≤ 12）
        ├─ 命中 → 次数 +1，把历史上下文拼进 systemPrompt.context
        └─ 未命中 → 入库，等助手说完话回填摘要
```

---

## 安装

```bash
# 在 DSH 里
plugin_manager install_bundle /path/to/dsh-image-hash-memory
```

或者装进 profile：

```bash
dsh plugin install /path/to/dsh-image-hash-memory
```

装完在「设置 → 插件」里就能看到 **图片感知记忆**。

要求：**Node >= 22.5**（用到内置的 `node:sqlite`）。

---

## 配置

全部配置项都会自动出现在设置页的表单里。

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `hammingThreshold` | `24` | dHash 距离上限，越小越严 |
| `enablePhash` | `true` | 是否启用 pHash 第二道门禁 |
| `phashThreshold` | `12` | pHash 距离上限 |
| `verificationMode` | `composite` | `composite` 双门禁 / `dhash` 只看 dHash |
| `autoRecall` | `true` | 自动注入命中的记忆 |
| `autoRecord` | `true` | 首次见到的图自动入库 |
| `maxInject` | `3` | 每轮最多注入几条 |
| `maxInjectChars` | `1200` | 注入文本上限 |
| `dbPath` | `''` | 空则用 `~/.dsh/state/image-hash-memory.db` |
| `debug` | `false` | 往 `~/.dsh/state/image-hash-memory.log` 写诊断行 |

---

## image_memory 工具

模型可以主动操作视觉记忆库：

| action | 参数 | 作用 |
|---|---|---|
| `search` | `query` | 用关键词找以前见过的图 |
| `lookup` | `path` | 给一张本地 PNG，查库里的相似记录 |
| `remember` | `path`, `note` | 把图连同说明写进库 |
| `stats` | — | 库存量、带摘要条数、总命中数 |
| `forget` | `id` | 按 id 删一条 |

---

## 注入长什么样

```
## 视觉记忆（image-hash-memory 自动检索）
- 图1：与历史图片高度相似（dHash 距离 0，pHash 距离 0）
  首次出现于 2026-11-02 23:06，最近一次 2026-11-08 09:12，累计 2 次
  当时用户说的是：看看这张报错截图
  上次的分析记录：这是 pnpm 版本冲突导致的安装失败……
以上是本地感知哈希库的检索结果；与当前图片明显不符时以当前图片为准。
```

最后那行免责是故意加的口子 ——
感知哈希只看像素，不保证语义，模型有判断权。

---

## 支持的图片格式

两种格式都用**内置的纯 JS 解码器**，不依赖任何原生模块：

- **PNG** —— 支持全部颜色类型（灰度 / RGB / 调色板 / 灰度+alpha / RGBA）、
  1/2/4/8/16 位深、Adam7 隔行扫描。解出的 RGBA 与 PIL **逐字节一致**。
- **JPEG** —— 顺序 DCT（baseline / extended sequential），支持任意采样因子
  （4:4:4 / 4:2:2 / 4:2:0 / 4:1:1）、优化 Huffman 表、restart marker、
  灰度与 YCbCr 及 Adobe RGB 色彩变换。色度上采样用双线性。

**实测精度**：同一张图存成 PNG 再存成 JPEG，三种哈希距离分别是
dHash 5 位、aHash 1 位、pHash 3 位——远低于 24 / 12 的门禁，所以
「PNG 入库、JPEG 再发」能被正确认出是同一张。

**不支持**：渐进式 JPEG（会明确报错而不是静默解出错数据）、算术编码、
WebP、GIF。遇到这几种格式，插件跳过该图并继续处理同一轮的其他图，
不打断对话。

### 为什么不用现成的 JPEG 库

profile 里恰好有 `jpeg-js`（`@jimp/js-jpeg` 的依赖），但那是 **0.4.4**、
2019 年之后没再维护，而且它只是碰巧在那个位置——不是我们声明的依赖，
换台机器未必解析得到。自己写一个 600 行的 baseline 解码器，换来零依赖和可控性。

---

## 存储

单文件 SQLite（`node:sqlite`），WAL 模式：

```
~/.dsh/state/image-hash-memory.db
```

表结构与 Python 版 `image_memory.db` 对齐，方便以后迁移。

---

## 开发

```bash
node --test test/      # 37 个测试
```

测试覆盖：哈希一致性 / 最近邻 / 远邻、双门禁、PNG 三种编码解码一致、
JPEG 各种采样与灰度、格式嗅探与分发、存储层增删改查、
插件接线（pre-step → 注入 → 工具调用）。

---

## 设置页（预留）

配置 schema 已经就位，设置页会自动生成。以后要做自定义 UI 时：

1. 客户端加一个 `dsh.client` 半，注册到设置页的 Slot；
2. 宿主侧 `ctx.inject(['settings'], scope => scope.settings.configure({ auto: false }))`
   关掉自动表单，换成自己的页面；
3. 配置字段不用改 —— 读写都走同一套 schema。

---

## License

MIT © Haoduo9
