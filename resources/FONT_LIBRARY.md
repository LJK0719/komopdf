# 中英字体库

当前内置 **39 个字体家族、158 个字形文件**，合计约 522 MiB。只在使用时加载对应字形，并通过带内容哈希的 URL 缓存；不会在打开 PDF 时下载整个字库。

## 中文：10 个家族

| 显示名称 | 字体家族 |
|---|---|
| 思源黑体 | Noto Sans CJK SC |
| 思源宋体 | Noto Serif CJK SC |
| 霞鹜文楷 | LXGW WenKai |
| 朱雀仿宋 | Zhuque Fangsong (technical preview) |
| 马善政楷体 | Ma Shan Zheng |
| 龙藏体 | Long Cang |
| 站酷小薇体 | 站酷小薇体 / ZCOOL XiaoWei |
| 站酷庆科黄油体 | ZCOOL QingKe HuangYou |
| 站酷快乐体 | ZCOOL KuaiLe |
| 志莽行书 | Zhi Mang Xing |

## 英文：29 个家族

- 无衬线：Inter、Roboto、Open Sans、Lato、Montserrat、Source Sans 3、Noto Sans、Nunito、Raleway、PT Sans、Oswald、Ubuntu、IBM Plex Sans、Carlito、Arimo、Liberation Sans。
- 衬线：Source Serif 4、Noto Serif、PT Serif、Merriweather、IBM Plex Serif、Caladea、Liberation Serif。
- 等宽：JetBrains Mono、Source Code Pro、Roboto Mono、IBM Plex Mono、Cousine、Liberation Mono。

## 字形与交互

- 每个家族均提供常规、粗体、斜体／倾斜体、粗斜体；文楷额外保留 Medium 及其倾斜体，因此为 `39 × 4 + 2 = 158`。
- 优先使用上游提供的字形。上游没有粗体时，使用 FreeType 加粗轮廓生成静态字体；没有斜体时，生成倾斜轮廓。不是仅改变 CSS 外观：这些字形会实际嵌入导出的 PDF。
- 变量字体固定为静态字形后接入现有 PDF 内核，确保选择器、页面显示和导出使用相同文件。
- 字体下拉框按家族列出；B/I 操作选择该家族的对应字形。换字体时保留加粗／斜体状态；不能为了精确匹配某个中间字重而跳到无关家族。
- 普通 PDF 文本返回实际字体身份；已应用字体写入 PDF 字体字典，保存重开后不会因为界面丢失身份而回退到“原字体”占位项。
- `fsType` 等标志保留为文件元数据，不作为字体选择、导入、恢复的操作门槛。文件结构与校验和仍须有效。

## 本机字体

微软雅黑、宋体、黑体、楷体、仿宋、Arial、Times New Roman、Calibri 等本机字体，可通过“更多字体 → 浏览本机字体”或导入 TTF/OTF/TTC 使用。系统字体文件没有被混同为上述内置字体，也没有用 Arimo/Carlito/Caladea 冒充 Arial/Calibri/Cambria。浏览器本机字体读取使用系统提供的访问权限。

## 准备与发布

```text
python scripts/prepare-fonts.py
uv run --cache-dir tmp/uv-cache scripts/prepare-font-library.py
pnpm prepare:web-assets
pnpm --filter @pdf-editor/web build
```

字体处理工具依赖由脚本的 PEP 723 元数据固定；也可在项目虚拟环境中安装相同版本的 `fonttools`、`freetype-py` 后运行脚本。共享的准备结果位于 `resources/downloads/fonts/prepared-fonts.json`，网页与桌面都通过 `scripts/stage-fonts.mjs` 装配，不复制第二套源字库。

来源固定在 [font-assets.json](font-assets.json) 和 [font-library.json](font-library.json)，来自 Google Fonts 官方仓库、已有 Noto/LXGW/Liberation 固定来源和朱雀仿宋官方发行包。原文件、版权元数据和随包说明保留，派生字形的生成流程可检查。下载文件和生成缓存不提交 Git。

网页构建会生成字体与引擎文件的 `.gz` 副本；生产 Nginx 用 `gzip_static` 直接发送预压缩文件，避免在请求时消耗服务器 CPU。原始文件保留，以支持不接受 gzip 的客户端。
