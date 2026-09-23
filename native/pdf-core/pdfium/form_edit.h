#pragma once

#include <cstddef>
#include <optional>
#include <span>
#include <vector>

class CPDF_PageObjectHolder;
class CPDF_FormObject;

namespace pdf_editor {
// 指针只存在于原生核心的一次事务内，不发送到 UI，也不保存到恢复日志。
struct PreparedFormPath {
  CPDF_PageObjectHolder* root;
  std::vector<CPDF_FormObject*> ancestors;
};

std::optional<PreparedFormPath> PrepareFormPath(
    CPDF_PageObjectHolder* page, std::span<const std::size_t> indices);
void GeneratePreparedFormPath(const PreparedFormPath& path);
}  // namespace pdf_editor
