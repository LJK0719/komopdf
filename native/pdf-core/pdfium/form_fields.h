#pragma once

#include "core/fxcrt/fx_coordinates.h"
#include "core/fxcrt/retain_ptr.h"
#include "core/fxcrt/widestring.h"

class CPDF_Dictionary;
class CPDF_Document;
class CPDF_Page;

namespace pdf_editor {
// 调用方持有结构事务；坐标已从规范化页面 point 转回 PDF 页面坐标。
// font 为 FontManager 已验证许可并装入同一文档的字体，不使用平台系统字体。
RetainPtr<CPDF_Dictionary> CreateTextField(
    CPDF_Document* document, CPDF_Page* page, const WideString& name,
    const CFX_FloatRect& pdf_rect, RetainPtr<CPDF_Dictionary> font);
RetainPtr<CPDF_Dictionary> CreateCheckboxField(
    CPDF_Document* document, CPDF_Page* page, const WideString& name,
    const CFX_FloatRect& pdf_rect, bool checked);
}  // namespace pdf_editor
