#ifndef PDF_EDITOR_TEXT_PARAGRAPH_H_
#define PDF_EDITOR_TEXT_PARAGRAPH_H_

#include <stdint.h>

#include <span>
#include <string>
#include <vector>

#include "font_runtime.h"
#include "text_shaping.h"

namespace pdf_editor {

enum class ParagraphAlignment {
  kLeft,
  kCenter,
  kRight,
};

struct ParagraphColor {
  float red = 0;
  float green = 0;
  float blue = 0;
};

struct ParagraphBounds {
  // Local page-style coordinates: x grows right, y grows down from the Form's
  // top edge. The Form's PDF BBox remains [0 0 width height].
  float x = 0;
  float y = 0;
  float width = 0;
  float height = 0;
};

struct ParagraphLine {
  ParagraphBounds bounds;
  Utf16Range text_range;
};

struct ParagraphStyleRun {
  Utf16Range range;
  uint32_t font_index = 0;
  float font_size = 12.0f;
  float letter_spacing = 0;
  ParagraphColor color;
  bool underline = false;
};

struct ParagraphFont {
  std::string id;
  FontFaceInfo info;
  std::span<const uint8_t> sfnt;
};

struct ParagraphRequest {
  std::string utf8;
  float width = 0;
  float height = 0;
  float font_size = 12.0f;
  float line_height = 1.2f;
  float letter_spacing = 0;
  ParagraphColor color;
  // Paint a vector underline along each non-empty visual line inside the Form.
  bool underline = false;
  ParagraphAlignment alignment = ParagraphAlignment::kLeft;
  TextDirection direction = TextDirection::kAuto;
  std::string language;
  // Empty means one default style. Otherwise contiguous resolved UTF-16 runs;
  // font_index selects fonts[0] (base) or another embedded font resource.
  std::vector<ParagraphStyleRun> styles;
};

struct ParagraphResult {
  // On success the caller owns this unattached Form page object. Inserting it
  // into a page transfers ownership according to PDFium's public API; otherwise
  // release it with FPDFPageObj_Destroy(). The object starts with identity
  // placement and a local PDF BBox of [0 0 request.width request.height].
  FPDF_PAGEOBJECT object = nullptr;
  bool overflow = false;
  std::vector<ParagraphLine> lines;
  std::u16string logical_text;
};

// Creates one real Form XObject in `document`. Its font, ToUnicode, glyph map,
// resources, content stream, and /KomoParagraph metadata all belong to that
// same document. TTC input must already be a standalone prepared SFNT face.
//
// Glyphs are emitted with caller-independent PDF character codes, never glyph
// IDs. Operators stay in logical cluster order while absolute text matrices keep
// their HarfBuzz visual positions. Each cluster has one direct /Span /ActualText
// mark, and only its first PDF code participates in the final ToUnicode CMap, so
// continuation glyph codes remain renderable without duplicating extraction.
// Together those marks preserve each line's complete logical UTF-16 order. The
// result's logical_text remains the exact unwrapped source, while ordinary
// PDF extraction may represent visual wrapping with line separators. Empty
// explicit lines consume line height but emit no glyph operators.
//
// Layout uses ICU line/grapheme boundaries and HarfBuzz metrics. Each wrapped
// line is reshaped independently. Missing glyphs are an error; this function
// does not choose fallback fonts, place the Form on a page, or edit source text.
bool CreateTextParagraph(FPDF_DOCUMENT document,
                         std::span<const ParagraphFont> fonts,
                         const ParagraphRequest& request,
                         ParagraphResult* result,
                         std::string* error_message);

bool CreateTextParagraph(FPDF_DOCUMENT document,
                         const FontFaceInfo& font_info,
                         std::span<const uint8_t> sfnt,
                         const ParagraphRequest& request,
                         ParagraphResult* result,
                         std::string* error_message);

}  // namespace pdf_editor

#endif  // PDF_EDITOR_TEXT_PARAGRAPH_H_
