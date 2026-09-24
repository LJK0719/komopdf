#ifndef PDF_EDITOR_TEXT_SHAPING_H_
#define PDF_EDITOR_TEXT_SHAPING_H_

#include <stdint.h>

#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace pdf_editor {

enum class TextDirection {
  kAuto,
  kLeftToRight,
  kRightToLeft,
};

struct Utf16Range {
  uint32_t start = 0;
  uint32_t end = 0;
};

struct TextShapingOptions {
  float font_size = 12.0f;
  float letter_spacing = 0.0f;
  TextDirection direction = TextDirection::kAuto;

  // BCP 47 language used by HarfBuzz. Empty means "und".
  std::string language;
};

struct ShapedGlyph {
  uint32_t glyph_id = 0;
  // Index of the font in the caller's shaping style runs (zero for ShapeText).
  uint32_t font_index = 0;
  float x_advance = 0;
  float y_advance = 0;
  float x_offset = 0;
  float y_offset = 0;

  // Logical UTF-16 span represented by the glyph's HarfBuzz cluster. HarfBuzz
  // cluster values identify the start; the end is the next logical cluster
  // start within the run. For a run ending inside a larger cluster, callers
  // must preserve the full run ActualText rather than infer text per glyph.
  Utf16Range cluster;
  uint32_t bidi_run_index = 0;
};

struct BidiVisualRun {
  // The runs are returned in ICU visual order. This range remains in logical
  // UTF-16 coordinates so callers can recover the original text and ActualText.
  Utf16Range logical_range;
  TextDirection direction = TextDirection::kLeftToRight;
  uint8_t embedding_level = 0;
  uint32_t glyph_start = 0;
  uint32_t glyph_count = 0;
  float x_advance = 0;
  float y_advance = 0;
};

struct MissingGlyph {
  uint32_t code_point = 0;
  Utf16Range text_range;
};

struct ShapedText {
  // Exact logical input after strict UTF-8 to UTF-16 conversion. It is not
  // normalized and is required later when emitting ActualText.
  std::u16string logical_text;

  // The first paragraph's resolved base direction. Multi-paragraph input is
  // accepted; each visual run carries its own resolved direction and level.
  TextDirection base_direction = TextDirection::kLeftToRight;

  // ICU extended grapheme boundaries in logical UTF-16 coordinates. Includes
  // both 0 and logical_text.size().
  std::vector<uint32_t> grapheme_boundaries;

  std::vector<BidiVisualRun> visual_runs;
  std::vector<ShapedGlyph> glyphs;

  // Shaping succeeds when a font is incomplete. Every visible .notdef cluster
  // is reported here so the caller can choose and shape with fallback fonts.
  std::vector<MissingGlyph> missing_glyphs;
};

struct ShapingStyleRun {
  Utf16Range range;
  std::span<const uint8_t> sfnt;
  float font_size = 12.0f;
  float letter_spacing = 0;
  uint32_t font_index = 0;
};

// Styles cover the entire UTF-16 input in ascending order. Boundaries must be
// whole graphemes; bidi resolution still runs over the complete logical line.
// The font index is returned on each glyph for separate embedded PDF resources.
bool ShapeStyledText(std::string_view utf8,
                     const TextShapingOptions& options,
                     std::span<const ShapingStyleRun> styles,
                     ShapedText* result,
                     std::string* error_message);

// Shapes a validated standalone SFNT face (TTC faces must already be extracted).
// Glyph metrics are returned in the same point units as font_size and
// letter_spacing. Letter spacing is applied between adjacent shaped clusters
// within each ICU visual run; line/run placement remains the caller's job.
//
// Explicit direction selects the bidi paragraph base level. It does not bypass
// ICU bidi resolution for embedded opposite-direction text.
bool ShapeText(std::span<const uint8_t> sfnt,
               std::string_view utf8,
               const TextShapingOptions& options,
               ShapedText* result,
               std::string* error_message);

}  // namespace pdf_editor

#endif  // PDF_EDITOR_TEXT_SHAPING_H_
