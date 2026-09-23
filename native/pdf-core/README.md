# 共享 PDF 核心

`include/pdf_editor` 与 `src` 为项目自有 C++ 核心基础。当前实现规范化坐标和撤销/恢复日志生命周期，不是另一套 PDF 渲染器。

- `geometry`：MediaBox/CropBox 交集、旋转、UserUnit、左上角 point、正逆变换。
- `frame`：native IPC 小端帧头、分配前长度限制，与 TypeScript 使用相同固定字节测试。
- `session_history`：核心成功提交后记录命令与逆操作；最近 100 步撤销独立于完整恢复日志。保存不截断日志，undo/redo 也产生单调递增版本。
- `CommittedEdit.resource_ids` 指向不可变恢复资源。日志中的命令不得包含密码；实际持久化与不可变源副本由平台桥完成。

本机 Windows 构建（已核实的 VS Build Tools 2026 路径）：

```powershell
& "scripts/build-native-foundation.cmd"
```

其他已配置 C++20 工具链可以直接 `cmake -S native/pdf-core -B native/pdf-core/build/<target> -G Ninja`，然后 build/ctest。此处命令不代表其他平台已验证。WebAssembly 需已配置的 Emscripten，PDFium 内部桥还要进入固定 PDFium 源码的 GN 构建。

## Windows 实际 PDF 写回探针

```powershell
python scripts/prepare-probe-font.py
python scripts/prepare-native.py --build-only --edit-probe
```

前提是固定 PDFium 及依赖已准备好。该命令用同一 Chromium Clang/libc++ 编译 PDFium 和项目内部桥，不把 MSVC foundation 静态库混链接到不同 C++ ABI。

已通过：单标记 ActualText 的画面/提取同步、共享 Form 单实例保存、真文本/勾选字段保存重开、文楷 TrueType 子集从“旧文”替换为“新字测试”。后一项两个 PDF 分别 3782/5177 字节；新字可提取且旧对象已移除。

证据：`docs/implementation/pdfium-edit-results.json`。`FPDF_SUBSET_NEW_FONTS` 当前只对该已核验且允许子集的 TTF 样本使用，不把它外推为混合许可字体或 CFF 的通用策略。

**这些小样本不等于 G01/G02 全部通过。**跨对象标记、复杂 Form 图形状态、CFF/完整排版、结构回滚/持久化恢复、独立阅读器与其他编译目标仍需验证。
