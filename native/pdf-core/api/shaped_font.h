#ifndef PDF_EDITOR_SHAPED_FONT_H_
#define PDF_EDITOR_SHAPED_FONT_H_

#include <stdint.h>

#include <span>
#include <string>

#include "font_runtime.h"

namespace pdf_editor {

struct ShapedFontMapping {
  // PDF character codes are caller-owned resource codes, not glyph IDs. Code 0
  // is reserved; the same glyph with different cluster text must use a distinct
  // character code.
  uint16_t character_code = 0;
  uint32_t glyph_id = 0;

  // Exact logical UTF-16 cluster represented by this code. Multi-code-point and
  // supplementary-plane clusters are written verbatim to ToUnicode.
  std::u16string cluster_text;
};

// Loads a shaped composite PDF font without treating glyph IDs as Unicode.
// TrueType uses CIDToGIDMap; OpenType/CFF (including a prepared, default-axis
// static instance of a CFF2 source) uses a custom Encoding CMap. Raw CFF2 must
// not be embedded as if it were CFF1. Both use independent PDF character codes
// and multi-code-point ToUnicode.
// This function does not place text objects or emit ActualText. Bidi and
// multi-glyph-cluster extraction still requires the caller to wrap placed runs
// or clusters with the exact ShapedText logical text.
FPDF_FONT LoadShapedFontFace(
    FPDF_DOCUMENT document,
    const FontFaceInfo& info,
    std::span<const uint8_t> sfnt,
    std::span<const ShapedFontMapping> mappings,
    std::string* error_message);

FPDF_FONT LoadShapedFontFace(
    FPDF_DOCUMENT document,
    const PreparedFontFace& face,
    std::span<const ShapedFontMapping> mappings,
    std::string* error_message);

}  // namespace pdf_editor

#endif  // PDF_EDITOR_SHAPED_FONT_H_
