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

- **PNG** —— 内置纯 JS 解码器（无原生依赖），支持全部颜色类型、
  1/2/4/8/16 位深、Adam7 隔行扫描。解出的 RGBA 与 PIL 逐字节一致。
- **JPEG / WebP** —— 需要额外的解码器。DSH 的 attachments 服务内部用 sharp，
  但没有把解码能力暴露给插件，所以这两种格式目前**跳过不进库**（不报错，只记 debug 日志）。

以后想做的话，两条路：给 attachments 服务加一个「解码成 RGBA」的方法，
或者插件里自带的解码器走 `setImageDecoder()` 注入。

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
node --test test/      # 25 个测试
```

测试覆盖：哈希一致性 / 最近邻 / 远邻、双门禁、PNG 三种编码解码一致、
存储层增删改查、插件接线（pre-step → 注入 → 工具调用）。

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
