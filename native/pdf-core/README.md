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

## 当前段落与字符接口（ABI4）

- `PdeEditCommand` 保留原12个标量/指针字段，将数值部分扩为14个 double；wasm32 stride 为160字节，前10项位置不变。新增4项为首行缩进、固定行距、段前距、段后距，单位为 PDF point。原生与 WASM 必须配套更新，不能把旧 worker 与新命令记录混用。
- `TextBlock.characters` 提供逻辑 UTF-16 范围、实际页面字符边界与方向，供前端命中/选区使用；提取时按页建立对象文字索引，避免逐个对象重复扫描整页。
- HarfBuzz shaping 与 ICU 换行保留混合字体。正常非负字距先用完整段落字形 advance 定位候选断点，再重塑校正各行；负 advance/负字距保持完整查找，避免误用单调假设。
- 未建立跨页流且原框可容纳的段落直接更新；超出可用区域后，`paragraph_flow.h` 创建关联续页，不缩小字号、不移动下方无关对象。全文/样式存于共享的 `Flow` 字典，各物理片只保存自己的文字范围。重排、插页和撤销属于原有同一候选事务。
- 缩短/清空只回收本段自动生成且不含其他对象、批注、书签/链接引用的空页；复制对象会解除复制片的原流关联。旋转/缩放后的文本框不被自动强行恢复成水平框。
- 页面提取/复制/导入仅在完整且唯一地包含整条流时保留全文关联；部分选取会在隔离源上解除关联并移除旧全文载荷。显式删除部分页或片段后，剩余片成为独立可编辑段落，不复活已删文字。
- 同一事务内文字片迁页后，后续样式/替换命令按本事务记录的迁移位置定位。WASM 在安装候选、修改 revision/undo 历史之前检查真实页数（单文档200、会话400），包含隐式续页；桌面不加此网页限制。
- 恢复读取兼容旧 ABI3 日志；新版日志写入 ABI4。历史探针结果仍保留在下文，不等同于所有平台的新版本验收。

## Windows 实际 PDF 写回探针

```powershell
python scripts/prepare-probe-font.py
python scripts/prepare-native.py --build-only --edit-probe
```

前提是固定 PDFium 及依赖已准备好。该命令用同一 Chromium Clang/libc++ 编译 PDFium 和项目内部桥，不把 MSVC foundation 静态库混链接到不同 C++ ABI。

已通过：单标记 ActualText 的画面/提取同步、共享 Form 单实例保存、真文本/勾选字段保存重开、文楷 TrueType 子集从“旧文”替换为“新字测试”。后一项两个 PDF 分别 3782/5177 字节；新字可提取且旧对象已移除。

证据：`docs/implementation/pdfium-edit-results.json`。`FPDF_SUBSET_NEW_FONTS` 当前只对该已核验且允许子集的 TTF 样本使用，不把它外推为混合许可字体或 CFF 的通用策略。

**这些小样本不等于 G01/G02 全部通过。**跨对象标记、复杂 Form 图形状态、CFF/完整排版、结构回滚/持久化恢复、独立阅读器与其他编译目标仍需验证。
