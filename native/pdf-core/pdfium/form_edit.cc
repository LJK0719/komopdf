#include "form_edit.h"

#include "core/fpdfapi/edit/cpdf_pagecontentgenerator.h"
#include "core/fpdfapi/page/cpdf_form.h"
#include "core/fpdfapi/page/cpdf_formobject.h"
#include "core/fpdfapi/page/cpdf_pageobject.h"
#include "core/fpdfapi/page/cpdf_pageobjectholder.h"

namespace pdf_editor {
std::optional<PreparedFormPath> PrepareFormPath(
    CPDF_PageObjectHolder* page, std::span<const std::size_t> indices) {
  if (!page || !page->IsPage() || indices.empty()) return std::nullopt;
  PreparedFormPath result{page, {}};
  auto* holder = page;
  // 先解析整个实例路径，避免发现后段路径无效时已开始修改。
  for (auto index : indices) {
    if (index >= holder->GetPageObjectCount()) return std::nullopt;
    auto* object = holder->GetPageObjectByIndex(index);
    auto* form = object ? object->AsForm() : nullptr;
    if (!form) return std::nullopt;
    result.ancestors.push_back(form);
    holder = form->form();
  }
  for (auto* object : result.ancestors) {
    object->form()->DetachStreamForEditing();
  }
  return result;
}

void GeneratePreparedFormPath(const PreparedFormPath& path) {
  // 调用方先完成目标文字/图片修改，并保存事务逆操作。
  for (auto it = path.ancestors.rbegin(); it != path.ancestors.rend(); ++it) {
    auto* object = *it;
    CPDF_PageContentGenerator generator(object->form());
    generator.GenerateFormContentForEditing(object->form());
    object->CalcBoundingBox();
    object->SetDirty(true);
  }
  CPDF_PageContentGenerator(path.root).GenerateContent();
}
}  // namespace pdf_editor
