[English](./README.md) | **简体中文**

# docs/ —— 架构图与它的取证

顶层 README 里内嵌的四层架构图放在这里，每种语言四个文件：

| 文件 | 是什么 |
|---|---|
| `omz-architecture.json` | [archify](https://github.com/tt-a1i/archify) 的类型化规格——唯一需要手改的文件 |
| `omz-architecture.html` | 交付后的独立查看器：单文件自包含，不联网、无构建步骤 |
| `omz-architecture.light.png` / `.dark.png` | 图面本体的静态截图，2× 密度，用于内嵌 README |

带 `.zh-CN.` 的是简体中文对应文件。两种语言是**拓扑相同的两份独立规格**，不是同一个文件换字符串：节点尺寸与 viewBox 按语言分别调过，因为 CJK 字形宽度是两倍；查看器自身的 UI 语言随 `meta.locale` 走。

## 为什么要有 HTML 页面，而不是只给图片

PNG 是 GitHub 能内联渲染的那一份。HTML 才是真正的产物：它带四条导览视图（默认 `core` 路径、DAG 调度、语义检索、三条回退链，每条附一句作者注）、点击任一组件聚焦、关系追踪、明暗主题，以及指向本仓库真实文件的 `sources` 引用。共 7 个组件带这类引用——coordinator 的 MCP 入口与 schema、dashboard 的全 GET 接口面、`probeCodegraph`、评审门 agent、八步生命周期命令、状态渲染器。

GitHub 不会内联渲染仓库里的 HTML，所以这个页面得在本地打开：克隆或下载仓库后用浏览器打开 `docs/omz-architecture.zh-CN.html`。它是单个文件，不发任何外部请求。

## 如何重新生成

图由 archify skill 产出。在该 skill 可用的前提下：

```bash
# 1. 按 showcase 质量门校验规格
node bin/archify.mjs validate architecture <repo>/docs/omz-architecture.zh-CN.json \
  --quality showcase --repo-root <repo> --json

# 2. deliver：冻结规格字节 → 渲染 → 检查 → 原子提交 HTML
node bin/archify.mjs deliver architecture <repo>/docs/omz-architecture.zh-CN.json \
  <repo>/docs/omz-architecture.zh-CN.html --quality showcase --repo-root <repo> --json

# 3. 从交付后的 HTML 采集容纳性与可读性证据
node bin/archify.mjs visual-check <repo>/docs/omz-architecture.zh-CN.html --json
```

`visual-check` 会在产物旁写下**整个查看器页面**的 PNG 边车文件与一张对照表；那些是检查证据，不是 README 用图，因此有意不入仓库。README 用图只截图面本体：在查看器的 embed 模式下（`?embed=1`，隐藏工具栏、页头与卡片），按实测的 `<svg>` 矩形裁剪，`deviceScaleFactor: 2`。

## 入仓产物的验证状态

两种语言，均在各自规格 `meta.repository` 记录的 revision 上：

- `validate` / `deliver`：`showcase` profile 下 9/9 artifact 检查通过，0 error、0 warning，仓库取证对 7 处源码引用核实通过。
- `visual-check`：`status: pass`——1440×900、1600×1000、1920×1080、2048×1320 四档均无纵横向溢出，最小投影节点字号不低于 6px 可读下限（最紧一档英文 7.6px、中文 7.8px）。
- 渲染截图的目视复核：逐张看过明暗两版，通过。

`deliver` 的收据，可以拿本仓库的字节直接核对：

| 文件 | SHA-256 | 字节数 |
|---|---|---|
| `omz-architecture.json` | `dc03886c38df7d19c4bf02fb2bd2d98ce898f8dbabeb17b4f5a69259c455417a` | 8555 |
| `omz-architecture.html` | `7cb8881ef826b8d40fac5d9abf5d891792f435b612a8f042e5e928b20621732a` | 737189 |
| `omz-architecture.zh-CN.json` | `12424c54b7bd5569e354989b3de1c0a923fb4e0ae4a825d9758acbcbfb2a7883` | 7218 |
| `omz-architecture.zh-CN.html` | `e57f43867db7adf3f3ea0a2bbc097b359ba74c372f86f77246cba9c6f0c5abf8` | 736591 |

两个 HTML 在 `.gitattributes` 里标了 `-text`：不标的话 `text=auto eol=lf` 会在 checkout 时把它们的 CRLF 规范化成 LF，交付字节就与上面这几个哈希不符了。

`showcase` 通过是关于**构图与容纳性**的机械判据——没有边穿过无关节点、没有标签被遮挡、桌面视口不溢出。它不说明图里的事实对不对；那由 DESIGN §3.1 与 §3.3 负责，本图是照那两节画的。
