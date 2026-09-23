# PDFium 内部编辑补丁

目标固定到 `../lock.json` 的 PDFium `80fccd7553e5cff9cea6549bc0db2ea93ea6cb2e`。这里锁定的是**候选输入**，不是通过四目标验证的发布组合。

## 0001 · Form 实例隔离与独立流写回

对应 `native/pdf-core/pdfium/form_edit.*`：

1. 校验完整嵌套路径，保留已有解析对象及其图形状态/稳定映射。
2. 自外向内克隆目标 Form stream，并单独克隆可变资源名称表；Font/XObject 等类别即便原来是间接字典也不共用其名称表。
3. 将当前 Form holder 的字典和 stream 一起切换到隔离实例，不重新解析导致丢失继承图形状态。
4. 修改完成后自内向外序列化 Form 自身的 stream，不误写其字典的 `/Contents`。
5. 标记各级父 Form 对象 dirty，最后生成页面内容，使新流进入父 XObject 资源引用。

**已执行：**固定源码 Windows 自编译，项目桥编译链接，真实保存重开测试通过：共享 Form 只改目标页、单标记 ActualText、文本/勾选字段、文楷 TTF 中文子集新增文字。详见 `docs/implementation/pdfium-edit-results.json`。

**尚未执行：**带矩阵/裁剪/透明/跨对象标记的复杂样本、结构事务回滚、WASM/macOS PDFium 和独立阅读器填表。上述小样本通过不代表整个 G02 完成。

此入口是核心事务层的内部操作，不直接暴露给网页。正式接入需要在修改前保存受影响的 stream/dict/resource 逆操作；当前尚未把这些入口接进 EngineAdapter.capabilities。
