#include "text_paragraph.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <ostream>
#include <set>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "core/fpdfapi/edit/cpdf_contentstream_write_utils.h"
#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_form.h"
#include "core/fpdfapi/page/cpdf_formobject.h"
#include "core/fpdfapi/page/cpdf_pageobject.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_boolean.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fxcrt/fx_coordinates.h"
#include "core/fxcrt/fx_string.h"
#include "core/fxcrt/fx_string_wrappers.h"
#include "core/fxcrt/span_util.h"
#include "core/fxcrt/widestring.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "shaped_font.h"
#include "hb-ot.h"
#include "hb.h"
#include "unicode/ubrk.h"
#include "unicode/utypes.h"

namespace pdf_editor {
namespace {

constexpr float kLayoutEpsilon = 0.0001f;
bool Fail(std::string message, std::string* error_message);

std::string FontResourceName(size_t index) {
  return "F" + std::to_string(index);
}

std::vector<ParagraphStyleRun> ResolvedStyles(const ParagraphRequest& request,
                                              uint32_t length) {
  if (!request.styles.empty()) return request.styles;
  return {{{0, length}, 0, request.font_size, request.letter_spacing,
           request.color, request.underline}};
}

bool BuildShapingStyles(const std::vector<ParagraphFont>& fonts,
                        const std::vector<ParagraphStyleRun>& styles,
                        uint32_t start,
                        uint32_t end,
                        std::vector<ShapingStyleRun>* shaped,
                        std::string* error_message) {
  shaped->clear();
  for (const auto& style : styles) {
    const uint32_t first = std::max(style.range.start, start);
    const uint32_t last = std::min(style.range.end, end);
    if (first >= last) continue;
    if (style.font_index >= fonts.size()) {
      return Fail("A paragraph style selects an unavailable font.", error_message);
    }
    shaped->push_back({{first - start, last - start},
                       fonts[style.font_index].sfnt, style.font_size,
                       style.letter_spacing, style.font_index});
  }
  return true;
}

class ScopedFont {
 public:
  explicit ScopedFont(FPDF_FONT font) : font_(font) {}
  ~ScopedFont() {
    if (font_) {
      FPDFFont_Close(font_);
    }
  }

  ScopedFont(const ScopedFont&) = delete;
  ScopedFont& operator=(const ScopedFont&) = delete;
  ScopedFont(ScopedFont&& other) noexcept : font_(std::exchange(other.font_, nullptr)) {}
  ScopedFont& operator=(ScopedFont&& other) noexcept {
    if (this != &other) {
      if (font_) FPDFFont_Close(font_);
      font_ = std::exchange(other.font_, nullptr);
    }
    return *this;
  }

  FPDF_FONT get() const { return font_; }

 private:
  FPDF_FONT font_;
};

struct LayoutLine {
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
  ShapedText shaped;
  std::vector<uint16_t> character_codes;
  float ascent = 0;
  float descent = 0;
  float min_x = 0;
  float max_x = 0;
  float width = 0;
  float x = 0;
  float top = 0;
  float bounds_y = 0;
  float bounds_height = 0;
  float baseline = 0;
};

struct UnderlineMetrics {
  float offset = 0;  // PDF y-up distance from the text baseline.
  float thickness = 0;  // Zero means a PDF hairline (device-dependent).
};

struct MappingKey {
  uint32_t glyph_id = 0;
  std::u16string cluster_text;
  bool emits_unicode = true;

  bool operator<(const MappingKey& other) const {
    return std::tie(glyph_id, cluster_text, emits_unicode) <
           std::tie(other.glyph_id, other.cluster_text,
                    other.emits_unicode);
  }
};

bool Fail(std::string message, std::string* error_message) {
  if (error_message) {
    *error_message = std::move(message);
  }
  return false;
}

bool IsFinitePositive(float value) {
  return std::isfinite(value) && value > 0;
}

bool ValidateRequest(const ParagraphRequest& request,
                     std::string* error_message) {
  if (!IsFinitePositive(request.width) ||
      !IsFinitePositive(request.height) ||
      !IsFinitePositive(request.font_size) ||
      !IsFinitePositive(request.line_height) ||
      !std::isfinite(request.letter_spacing)) {
    return Fail("Paragraph dimensions, font size, and line height must be "
                "positive and all layout values must be finite.",
                error_message);
  }
  for (float component : {request.color.red, request.color.green,
                          request.color.blue}) {
    if (!std::isfinite(component) || component < 0 || component > 1) {
      return Fail("Paragraph RGB components must be finite values from 0 to 1.",
                  error_message);
    }
  }
  if (request.language.find('\0') != std::string::npos) {
    return Fail("The paragraph language tag contains an embedded null byte.",
                error_message);
  }
  const float line_step = request.font_size * request.line_height;
  if (!std::isfinite(line_step) || line_step <= 0) {
    return Fail("The paragraph line advance is outside the usable range.",
                error_message);
  }
  return true;
}

void AppendUtf8(uint32_t code_point, std::string* output) {
  if (code_point <= 0x7f) {
    output->push_back(static_cast<char>(code_point));
  } else if (code_point <= 0x7ff) {
    output->push_back(static_cast<char>(0xc0 | (code_point >> 6)));
    output->push_back(static_cast<char>(0x80 | (code_point & 0x3f)));
  } else if (code_point <= 0xffff) {
    output->push_back(static_cast<char>(0xe0 | (code_point >> 12)));
    output->push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3f)));
    output->push_back(static_cast<char>(0x80 | (code_point & 0x3f)));
  } else {
    output->push_back(static_cast<char>(0xf0 | (code_point >> 18)));
    output->push_back(static_cast<char>(0x80 | ((code_point >> 12) & 0x3f)));
    output->push_back(static_cast<char>(0x80 | ((code_point >> 6) & 0x3f)));
    output->push_back(static_cast<char>(0x80 | (code_point & 0x3f)));
  }
}

bool Utf16RangeToUtf8(const std::u16string& text,
                      uint32_t start,
                      uint32_t end,
                      std::string* output,
                      std::string* error_message) {
  if (start > end || end > text.size()) {
    return Fail("A paragraph layout range is outside the logical text.",
                error_message);
  }
  output->clear();
  for (uint32_t index = start; index < end; ++index) {
    uint32_t code_point = static_cast<uint16_t>(text[index]);
    if (code_point >= 0xd800 && code_point <= 0xdbff) {
      if (index + 1 >= end) {
        return Fail("A paragraph layout range split a UTF-16 scalar.",
                    error_message);
      }
      const uint32_t low = static_cast<uint16_t>(text[++index]);
      if (low < 0xdc00 || low > 0xdfff) {
        return Fail("The paragraph contains invalid UTF-16.", error_message);
      }
      code_point =
          0x10000 + ((code_point - 0xd800) << 10) + (low - 0xdc00);
    } else if (code_point >= 0xdc00 && code_point <= 0xdfff) {
      return Fail("The paragraph contains invalid UTF-16.", error_message);
    }
    AppendUtf8(code_point, output);
  }
  return true;
}

std::string MissingGlyphMessage(const MissingGlyph& missing,
                                uint32_t range_offset) {
  char code_point[16];
  std::snprintf(code_point, sizeof(code_point), "U+%04X",
                static_cast<unsigned int>(missing.code_point));
  return std::string("The selected font is missing ") + code_point +
         " at UTF-16 range [" +
         std::to_string(range_offset + missing.text_range.start) + ", " +
         std::to_string(range_offset + missing.text_range.end) + ").";
}

void ApplySpacingAcrossVisualRuns(const std::vector<ParagraphStyleRun>& styles,
                                  uint32_t offset,
                                  ShapedText* shaped) {
  std::vector<size_t> nonempty_runs;
  for (size_t index = 0; index < shaped->visual_runs.size(); ++index) {
    if (shaped->visual_runs[index].glyph_count != 0) {
      nonempty_runs.push_back(index);
    }
  }
  for (size_t index = 0; index + 1 < nonempty_runs.size(); ++index) {
    BidiVisualRun& run = shaped->visual_runs[nonempty_runs[index]];
    const size_t glyph_index =
        static_cast<size_t>(run.glyph_start) + run.glyph_count - 1;
    if (glyph_index < shaped->glyphs.size()) {
      const uint32_t position = offset + shaped->glyphs[glyph_index].cluster.start;
      for (const auto& style : styles) {
        if (style.range.start <= position && position < style.range.end) {
          shaped->glyphs[glyph_index].x_advance += style.letter_spacing;
          run.x_advance += style.letter_spacing;
          break;
        }
      }
    }
  }
}

bool ShapeRange(const std::vector<ParagraphFont>& fonts,
                const std::vector<ParagraphStyleRun>& styles,
                const std::u16string& logical_text,
                uint32_t start,
                uint32_t end,
                const ParagraphRequest& request,
                TextDirection resolved_direction,
                LayoutLine* line,
                std::string* error_message) {
  std::string utf8;
  if (!Utf16RangeToUtf8(logical_text, start, end, &utf8, error_message)) {
    return false;
  }

  TextShapingOptions options;
  options.font_size = request.font_size;
  options.letter_spacing = request.letter_spacing;
  options.direction = resolved_direction;
  options.language = request.language;
  ShapedText shaped;
  std::vector<ShapingStyleRun> shaping_styles;
  if (!BuildShapingStyles(fonts, styles, start, end, &shaping_styles,
                          error_message) ||
      !ShapeStyledText(utf8, options, shaping_styles, &shaped, error_message)) {
    return false;
  }
  if (!shaped.missing_glyphs.empty()) {
    return Fail(MissingGlyphMessage(shaped.missing_glyphs.front(), start),
                error_message);
  }
  for (const ShapedGlyph& glyph : shaped.glyphs) {
    if (glyph.glyph_id == 0) {
      return Fail("HarfBuzz produced a .notdef glyph for UTF-16 range [" +
                      std::to_string(start + glyph.cluster.start) + ", " +
                      std::to_string(start + glyph.cluster.end) + ").",
                  error_message);
    }
  }
  if (shaped.logical_text.size() != end - start) {
    return Fail("The reshaped line did not preserve its logical UTF-16 range.",
                error_message);
  }

  ApplySpacingAcrossVisualRuns(styles, start, &shaped);
  float pen_x = 0;
  float min_x = 0;
  float max_x = 0;
  for (const ShapedGlyph& glyph : shaped.glyphs) {
    const float origin_x = pen_x + glyph.x_offset;
    const float advance_x = pen_x + glyph.x_advance;
    if (!std::isfinite(origin_x) || !std::isfinite(advance_x)) {
      return Fail("A shaped paragraph line exceeds the usable coordinate range.",
                  error_message);
    }
    min_x = std::min({min_x, origin_x, advance_x});
    max_x = std::max({max_x, origin_x, advance_x});
    pen_x = advance_x;
  }
  if (!std::isfinite(min_x) || !std::isfinite(max_x) || max_x < min_x) {
    return Fail("A shaped paragraph line has invalid metrics.", error_message);
  }

  line->start_utf16 = start;
  line->end_utf16 = end;
  line->shaped = std::move(shaped);
  line->min_x = min_x;
  line->max_x = max_x;
  line->width = max_x - min_x;
  return true;
}

bool CollectLineBreaks(const std::u16string& logical_text,
                       const std::string& language,
                       std::vector<bool>* line_breaks,
                       std::vector<bool>* hard_breaks,
                       std::string* error_message) {
  line_breaks->assign(logical_text.size() + 1, false);
  hard_breaks->assign(logical_text.size() + 1, false);
  (*line_breaks)[0] = true;
  if (logical_text.empty()) {
    return true;
  }
  if (logical_text.size() >
      static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
    return Fail("The paragraph is too large for ICU line breaking.",
                error_message);
  }

  std::vector<UChar> text;
  text.reserve(logical_text.size());
  for (char16_t unit : logical_text) {
    text.push_back(static_cast<UChar>(unit));
  }
  const char* locale = language.empty() ? "und" : language.c_str();
  UErrorCode status = U_ZERO_ERROR;
  std::unique_ptr<UBreakIterator, decltype(&ubrk_close)> iterator(
      ubrk_open(UBRK_LINE, locale, text.data(), static_cast<int32_t>(text.size()),
                &status),
      &ubrk_close);
  if (U_FAILURE(status) || !iterator) {
    return Fail(std::string("ICU could not calculate paragraph line breaks: ") +
                    u_errorName(status),
                error_message);
  }
  for (int32_t boundary = ubrk_first(iterator.get()); boundary != UBRK_DONE;
       boundary = ubrk_next(iterator.get())) {
    if (boundary < 0 || boundary > static_cast<int32_t>(text.size())) {
      return Fail("ICU returned an invalid paragraph line boundary.",
                  error_message);
    }
    (*line_breaks)[static_cast<size_t>(boundary)] = true;
    const int32_t rule_status = ubrk_getRuleStatus(iterator.get());
    if (rule_status >= UBRK_LINE_HARD &&
        rule_status < UBRK_LINE_HARD_LIMIT) {
      (*hard_breaks)[static_cast<size_t>(boundary)] = true;
    }
  }
  (*line_breaks)[logical_text.size()] = true;
  return true;
}

bool IsHardBreakUnit(char16_t unit) {
  return unit == u'\r' || unit == u'\n' || unit == u'\v' || unit == u'\f' ||
         unit == static_cast<char16_t>(0x0085) ||
         unit == static_cast<char16_t>(0x2028) ||
         unit == static_cast<char16_t>(0x2029);
}

uint32_t HardBreakStart(const std::u16string& text,
                        uint32_t paragraph_start,
                        uint32_t boundary) {
  uint32_t result = boundary;
  while (result > paragraph_start && IsHardBreakUnit(text[result - 1])) {
    --result;
  }
  return result;
}

bool DetermineParagraphDirection(const std::vector<ParagraphFont>& fonts,
                                 const std::vector<ParagraphStyleRun>& styles,
                                 const std::u16string& logical_text,
                                 uint32_t start,
                                 uint32_t end,
                                 const ParagraphRequest& request,
                                 TextDirection* direction,
                                 std::string* error_message) {
  if (request.direction != TextDirection::kAuto) {
    *direction = request.direction;
    return true;
  }
  if (start == end) {
    *direction = TextDirection::kLeftToRight;
    return true;
  }

  std::string utf8;
  if (!Utf16RangeToUtf8(logical_text, start, end, &utf8, error_message)) {
    return false;
  }
  TextShapingOptions options;
  options.font_size = request.font_size;
  options.letter_spacing = request.letter_spacing;
  options.direction = TextDirection::kAuto;
  options.language = request.language;
  ShapedText shaped;
  std::vector<ShapingStyleRun> shaping_styles;
  if (!BuildShapingStyles(fonts, styles, start, end, &shaping_styles,
                          error_message) ||
      !ShapeStyledText(utf8, options, shaping_styles, &shaped, error_message)) {
    return false;
  }
  if (!shaped.missing_glyphs.empty()) {
    return Fail(MissingGlyphMessage(shaped.missing_glyphs.front(), start),
                error_message);
  }
  *direction = shaped.base_direction;
  return true;
}

bool WrapParagraph(const std::vector<ParagraphFont>& fonts,
                   const std::vector<ParagraphStyleRun>& styles,
                   const std::u16string& logical_text,
                   uint32_t paragraph_start,
                   uint32_t paragraph_end,
                   const std::vector<uint32_t>& grapheme_boundaries,
                   const std::vector<bool>& line_breaks,
                   const ParagraphRequest& request,
                   std::vector<LayoutLine>* lines,
                   bool* overflow,
                   std::string* error_message) {
  if (paragraph_start == paragraph_end) {
    LayoutLine empty;
    empty.start_utf16 = paragraph_start;
    empty.end_utf16 = paragraph_end;
    lines->push_back(std::move(empty));
    return true;
  }

  TextDirection paragraph_direction;
  if (!DetermineParagraphDirection(fonts, styles, logical_text, paragraph_start,
                                   paragraph_end, request,
                                   &paragraph_direction, error_message)) {
    return false;
  }

  uint32_t line_start = paragraph_start;
  while (line_start < paragraph_end) {
    std::optional<LayoutLine> first_grapheme;
    std::optional<LayoutLine> furthest_fit;
    std::optional<LayoutLine> preferred_break;
    for (uint32_t boundary : grapheme_boundaries) {
      if (boundary <= line_start) {
        continue;
      }
      if (boundary > paragraph_end) {
        break;
      }
      LayoutLine candidate;
      if (!ShapeRange(fonts, styles, logical_text, line_start, boundary, request,
                      paragraph_direction, &candidate, error_message)) {
        return false;
      }
      if (!first_grapheme) {
        first_grapheme = candidate;
      }
      if (candidate.width <= request.width + kLayoutEpsilon) {
        furthest_fit = candidate;
        if (line_breaks[boundary]) {
          preferred_break = candidate;
        }
      }
    }

    std::optional<LayoutLine> chosen;
    if (furthest_fit && furthest_fit->end_utf16 == paragraph_end) {
      chosen = std::move(furthest_fit);
    } else if (preferred_break) {
      chosen = std::move(preferred_break);
    } else if (furthest_fit) {
      chosen = std::move(furthest_fit);
    } else if (first_grapheme) {
      chosen = std::move(first_grapheme);
      *overflow = true;
    } else {
      return Fail("Unicode grapheme boundaries could not advance paragraph "
                  "layout.",
                  error_message);
    }
    if (chosen->end_utf16 <= line_start) {
      return Fail("Paragraph wrapping did not advance the logical text.",
                  error_message);
    }
    if (chosen->width > request.width + kLayoutEpsilon) {
      *overflow = true;
    }
    line_start = chosen->end_utf16;
    lines->push_back(std::move(*chosen));
  }
  return true;
}

float AlignedX(ParagraphAlignment alignment,
               float paragraph_width,
               float line_width) {
  switch (alignment) {
    case ParagraphAlignment::kLeft:
      return 0;
    case ParagraphAlignment::kCenter:
      return (paragraph_width - line_width) / 2;
    case ParagraphAlignment::kRight:
      return paragraph_width - line_width;
  }
  return 0;
}

bool PositionLines(const ParagraphRequest& request,
                   const std::vector<ParagraphStyleRun>& styles,
                   const std::vector<FPDF_FONT>& fonts,
                   std::vector<LayoutLine>* lines,
                   ParagraphResult* result,
                   std::string* error_message) {
  result->lines.clear();
  result->lines.reserve(lines->size());
  float top = 0;
  for (LayoutLine& line : *lines) {
    float ascent = 0, descent = 0;
    float line_step = request.font_size * request.line_height;
    bool has_metrics = false;
    for (const auto& style : styles) {
      if (line.shaped.glyphs.empty()
              ? !(style.range.start <= line.start_utf16 && line.start_utf16 <= style.range.end)
              : (style.range.end <= line.start_utf16 || style.range.start >= line.end_utf16)) continue;
      float run_ascent = 0, run_descent = 0;
      if (style.font_index >= fonts.size() || !fonts[style.font_index] ||
          !FPDFFont_GetAscent(fonts[style.font_index], style.font_size, &run_ascent) ||
          !FPDFFont_GetDescent(fonts[style.font_index], style.font_size, &run_descent)) {
        return Fail("PDFium could not read a paragraph font's metrics.", error_message);
      }
      ascent = std::max(ascent, run_ascent);
      descent = std::min(descent, run_descent);
      line_step = std::max(line_step, style.font_size * request.line_height);
      has_metrics = true;
    }
    if (!has_metrics) {
      if (!FPDFFont_GetAscent(fonts[0], request.font_size, &ascent) ||
          !FPDFFont_GetDescent(fonts[0], request.font_size, &descent)) {
        return Fail("PDFium could not read the paragraph font metrics.", error_message);
      }
    }
    const float font_height = ascent - descent;
    if (!std::isfinite(ascent) || !std::isfinite(descent) ||
        !std::isfinite(line_step) || !std::isfinite(font_height) || font_height <= 0) {
      return Fail("The shaped paragraph font metrics are invalid.", error_message);
    }
    const float leading = std::max(0.0f, line_step - font_height) / 2;
    line.ascent = ascent;
    line.descent = descent;
    line.x = AlignedX(request.alignment, request.width, line.width);
    line.top = top;
    top += line_step;
    line.bounds_y = line.top + leading;
    line.bounds_height = font_height;
    line.baseline = request.height - line.bounds_y - ascent;
    if (!std::isfinite(line.x) || !std::isfinite(line.top) ||
        !std::isfinite(line.bounds_y) ||
        !std::isfinite(line.bounds_height) ||
        !std::isfinite(line.baseline)) {
      return Fail("The paragraph line positions exceed the usable range.",
                  error_message);
    }

    ParagraphLine public_line;
    public_line.bounds =
        {line.x, line.bounds_y, line.width, line.bounds_height};
    public_line.text_range = {line.start_utf16, line.end_utf16};
    result->lines.push_back(public_line);

    if (line.x < -kLayoutEpsilon ||
        line.x + line.width > request.width + kLayoutEpsilon ||
        line.bounds_y < -kLayoutEpsilon ||
        line.bounds_y + line.bounds_height >
            request.height + kLayoutEpsilon) {
      result->overflow = true;
    }
  }
  return true;
}

bool BuildFontMappings(const std::u16string& logical_text,
                       size_t font_count,
                       std::vector<LayoutLine>* lines,
                       std::vector<std::vector<ShapedFontMapping>>* mappings,
                       std::vector<std::set<uint16_t>>* unicode_codes,
                       std::string* error_message) {
  std::vector<std::map<MappingKey, uint16_t>> codes(font_count);
  std::vector<uint32_t> next_code(font_count, 1);
  mappings->assign(font_count, {});
  unicode_codes->assign(font_count, {});
  for (LayoutLine& line : *lines) {
    line.character_codes.clear();
    line.character_codes.reserve(line.shaped.glyphs.size());
    for (size_t index = 0; index < line.shaped.glyphs.size(); ++index) {
      const ShapedGlyph& glyph = line.shaped.glyphs[index];
      if (glyph.cluster.start > glyph.cluster.end ||
          glyph.cluster.end > line.end_utf16 - line.start_utf16) {
        return Fail("A shaped glyph cluster is outside its paragraph line.",
                    error_message);
      }
      const bool first_in_cluster =
          index == 0 ||
          line.shaped.glyphs[index - 1].cluster.start != glyph.cluster.start ||
          line.shaped.glyphs[index - 1].cluster.end != glyph.cluster.end;
      const uint32_t cluster_start = line.start_utf16 + glyph.cluster.start;
      const uint32_t cluster_end = line.start_utf16 + glyph.cluster.end;
      MappingKey key;
      key.glyph_id = glyph.glyph_id;
      key.cluster_text = logical_text.substr(
          cluster_start, static_cast<size_t>(cluster_end - cluster_start));
      key.emits_unicode = first_in_cluster;
      if (glyph.font_index >= font_count) {
        return Fail("A shaped paragraph glyph has no font resource.", error_message);
      }
      auto& font_codes = codes[glyph.font_index];
      auto found = font_codes.find(key);
      if (found == font_codes.end()) {
        if (next_code[glyph.font_index] > std::numeric_limits<uint16_t>::max()) {
          return Fail("The paragraph requires more than 65,535 distinct PDF "
                      "character mappings for one font.", error_message);
        }
        const uint16_t code = static_cast<uint16_t>(next_code[glyph.font_index]++);
        found = font_codes.emplace(key, code).first;
        (*mappings)[glyph.font_index].push_back({code, glyph.glyph_id, key.cluster_text});
        if (first_in_cluster) (*unicode_codes)[glyph.font_index].insert(code);
      }
      line.character_codes.push_back(found->second);
    }
  }
  if (std::all_of(mappings->begin(), mappings->end(),
                  [](const auto& value) { return value.empty(); })) {
    return Fail("A paragraph must contain at least one renderable glyph; empty "
                "lines alone cannot create a font resource.",
                error_message);
  }
  return true;
}

void AppendHexUnit(uint16_t value, std::ostream* output) {
  constexpr char kHex[] = "0123456789ABCDEF";
  output->put(kHex[(value >> 12) & 0x0f]);
  output->put(kHex[(value >> 8) & 0x0f]);
  output->put(kHex[(value >> 4) & 0x0f]);
  output->put(kHex[value & 0x0f]);
}

void AppendPdfCharacterCode(uint16_t value, std::ostream* output) {
  output->put('<');
  AppendHexUnit(value, output);
  output->put('>');
}

void AppendPdfUnicodeHex(const std::u16string& value, std::ostream* output) {
  output->put('<');
  AppendHexUnit(0xfeff, output);
  for (char16_t unit : value) {
    AppendHexUnit(static_cast<uint16_t>(unit), output);
  }
  output->put('>');
}

void AppendCMapUtf16Hex(const std::u16string& value, std::ostream* output) {
  output->put('<');
  for (char16_t unit : value) {
    AppendHexUnit(static_cast<uint16_t>(unit), output);
  }
  output->put('>');
}

bool InstallParagraphToUnicode(
    CPDF_Document* document,
    CPDF_Font* font,
    const std::vector<ShapedFontMapping>& mappings,
    const std::set<uint16_t>& unicode_codes,
    std::string* error_message) {
  if (!document || !font || unicode_codes.empty()) {
    return Fail("The paragraph has no primary Unicode cluster mappings.",
                error_message);
  }
  std::vector<const ShapedFontMapping*> selected;
  selected.reserve(unicode_codes.size());
  for (const ShapedFontMapping& mapping : mappings) {
    if (unicode_codes.contains(mapping.character_code)) {
      selected.push_back(&mapping);
    }
  }
  if (selected.size() != unicode_codes.size()) {
    return Fail("The paragraph Unicode cluster map is incomplete.",
                error_message);
  }
  std::sort(selected.begin(), selected.end(),
            [](const ShapedFontMapping* left,
               const ShapedFontMapping* right) {
              return left->character_code < right->character_code;
            });

  fxcrt::ostringstream cmap;
  cmap << "/CIDInit /ProcSet findresource begin\n"
          "12 dict begin\n"
          "begincmap\n"
          "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) "
          "/Supplement 0 >> def\n"
          "/CMapName /KomoParagraph-ToUnicode def\n"
          "/CMapType 2 def\n"
          "1 begincodespacerange\n"
          "<0000> <FFFF>\n"
          "endcodespacerange\n";
  constexpr size_t kEntriesPerBlock = 100;
  for (size_t first = 0; first < selected.size();
       first += kEntriesPerBlock) {
    const size_t count =
        std::min(kEntriesPerBlock, selected.size() - first);
    cmap << count << " beginbfchar\n";
    for (size_t offset = 0; offset < count; ++offset) {
      const ShapedFontMapping& mapping = *selected[first + offset];
      AppendPdfCharacterCode(mapping.character_code, &cmap);
      cmap << ' ';
      AppendCMapUtf16Hex(mapping.cluster_text, &cmap);
      cmap << '\n';
    }
    cmap << "endbfchar\n";
  }
  cmap << "endcmap\n"
          "CMapName currentdict /CMap defineresource pop\n"
          "end\n"
          "end\n";
  const fxcrt::string data = cmap.str();
  RetainPtr<CPDF_Stream> stream =
      document->NewIndirect<CPDF_Stream>(pdfium::as_byte_span(data));
  RetainPtr<CPDF_Dictionary> font_dict = font->GetMutableFontDict();
  if (!font_dict) {
    return Fail("The paragraph font dictionary is unavailable.",
                error_message);
  }
  font_dict->SetNewFor<CPDF_Reference>("ToUnicode", document,
                                       stream->GetObjNum());
  return true;
}

bool ReadUnderlineMetrics(std::span<const uint8_t> sfnt,
                          float font_size,
                          float descent,
                          UnderlineMetrics* metrics,
                          std::string* error_message) {
  std::unique_ptr<hb_blob_t, decltype(&hb_blob_destroy)> blob(
      hb_blob_create_or_fail(reinterpret_cast<const char*>(sfnt.data()),
                             static_cast<unsigned int>(sfnt.size()),
                             HB_MEMORY_MODE_READONLY, nullptr, nullptr),
      &hb_blob_destroy);
  if (!blob) {
    return Fail("HarfBuzz could not read the underline font face.",
                error_message);
  }
  std::unique_ptr<hb_face_t, decltype(&hb_face_destroy)> face(
      hb_face_create_or_fail(blob.get(), 0), &hb_face_destroy);
  if (!face || hb_face_get_upem(face.get()) == 0) {
    return Fail("HarfBuzz could not read the underline font metrics.",
                error_message);
  }
  std::unique_ptr<hb_font_t, decltype(&hb_font_destroy)> font(
      hb_font_create(face.get()), &hb_font_destroy);
  if (!font || font.get() == hb_font_get_empty()) {
    return Fail("HarfBuzz could not create the underline font.", error_message);
  }
  const unsigned int upem = hb_face_get_upem(face.get());
  hb_font_set_scale(font.get(), static_cast<int>(upem),
                    static_cast<int>(upem));
  const float scale = font_size / upem;
  hb_position_t position = 0;
  hb_position_t thickness = 0;
  if (hb_ot_metrics_get_position(font.get(),
                                 HB_OT_METRICS_TAG_UNDERLINE_OFFSET,
                                 &position)) {
    metrics->offset = position * scale;
  } else {
    // The PDFium descent is a real font metric, not an underline position.
    // Mid-descent is only an approximation when the face has no post metric.
    if (!std::isfinite(descent) || descent >= 0) {
      return Fail("The font has neither an underline position nor a usable "
                  "descent for positioning a fallback underline.",
                  error_message);
    }
    metrics->offset = descent / 2;
  }
  if (hb_ot_metrics_get_position(font.get(),
                                 HB_OT_METRICS_TAG_UNDERLINE_SIZE,
                                 &thickness) && thickness > 0) {
    metrics->thickness = thickness * scale;
  } else {
    // No thickness can be inferred from ascent/descent. PDF's zero-width
    // stroke is a visible vector hairline, but its width varies by device.
    metrics->thickness = 0;
  }
  if (!std::isfinite(metrics->offset) ||
      !std::isfinite(metrics->thickness)) {
    return Fail("The underline font metrics exceed the usable range.",
                error_message);
  }
  return true;
}

const ParagraphStyleRun* StyleAt(const std::vector<ParagraphStyleRun>& styles,
                                 uint32_t position) {
  for (const auto& style : styles) {
    if (style.range.start <= position && position < style.range.end) return &style;
  }
  return nullptr;
}

bool BuildContentStream(const ParagraphRequest& request,
                        const std::vector<ParagraphStyleRun>& styles,
                        const std::vector<LayoutLine>& lines,
                        const std::vector<UnderlineMetrics>& underlines,
                        fxcrt::string* content,
                        std::string* error_message) {
  fxcrt::ostringstream output;
  output << "q\nBT\n";
  const ParagraphStyleRun* previous_style = nullptr;

  for (const LayoutLine& line : lines) {
    if (line.character_codes.size() != line.shaped.glyphs.size()) {
      return Fail("A paragraph line has incomplete PDF character mappings.",
                  error_message);
    }
    if (line.shaped.glyphs.empty()) {
      continue;
    }
    struct PlacedGlyph {
      size_t index = 0;
      uint32_t cluster_start = 0;
      uint32_t cluster_end = 0;
      float x = 0;
      float y = 0;
    };
    std::vector<PlacedGlyph> placed;
    placed.reserve(line.shaped.glyphs.size());
    float pen_x = 0;
    float pen_y = 0;
    for (size_t index = 0; index < line.shaped.glyphs.size(); ++index) {
      const ShapedGlyph& glyph = line.shaped.glyphs[index];
      const float x = line.x - line.min_x + pen_x + glyph.x_offset;
      const float y = line.baseline + pen_y + glyph.y_offset;
      if (!std::isfinite(x) || !std::isfinite(y)) {
        return Fail("A paragraph glyph position exceeds the usable range.",
                    error_message);
      }
      placed.push_back(
          {index, glyph.cluster.start, glyph.cluster.end, x, y});
      pen_x += glyph.x_advance;
      pen_y += glyph.y_advance;
    }
    // Painting uses absolute text matrices, so operators can stay in logical
    // cluster order without changing the visual placement. Readers that ignore
    // ActualText therefore still see bidi clusters in logical order.
    std::stable_sort(placed.begin(), placed.end(),
                     [](const PlacedGlyph& left, const PlacedGlyph& right) {
                       return left.cluster_start < right.cluster_start;
                     });
    for (size_t first = 0; first < placed.size();) {
      size_t limit = first + 1;
      while (limit < placed.size() &&
             placed[limit].cluster_start == placed[first].cluster_start &&
             placed[limit].cluster_end == placed[first].cluster_end) {
        ++limit;
      }
      if (placed[first].cluster_start > placed[first].cluster_end ||
          placed[first].cluster_end > line.shaped.logical_text.size()) {
        return Fail("A placed paragraph cluster is outside its logical line.",
                    error_message);
      }
      output << "/Span << /ActualText ";
      AppendPdfUnicodeHex(
          line.shaped.logical_text.substr(
              placed[first].cluster_start,
              placed[first].cluster_end - placed[first].cluster_start),
          &output);
      output << " >> BDC\n";
      for (size_t index = first; index < limit; ++index) {
        const PlacedGlyph& glyph = placed[index];
        const auto* style = StyleAt(styles, line.start_utf16 + glyph.cluster_start);
        if (!style) return Fail("A painted cluster is missing its text style.", error_message);
        if (previous_style != style) {
          output << '/' << FontResourceName(style->font_index) << ' ';
          WriteFloat(output, style->font_size) << " Tf\n";
          WriteFloat(output, style->color.red) << ' ';
          WriteFloat(output, style->color.green) << ' ';
          WriteFloat(output, style->color.blue) << " rg\n";
          previous_style = style;
        }
        output << "1 0 0 1 ";
        WriteFloat(output, glyph.x) << ' ';
        WriteFloat(output, glyph.y) << " Tm ";
        AppendPdfCharacterCode(line.character_codes[glyph.index], &output);
        output << " Tj\n";
      }
      output << "EMC\n";
      first = limit;
    }
  }
  output << "ET\n/Artifact BMC\n";
  for (const LayoutLine& line : lines) {
    float pen_x = 0;
    const ParagraphStyleRun* active = nullptr;
    float left = 0, right = 0;
    auto flush = [&]() {
      if (!active || right <= left) return;
      const UnderlineMetrics& metrics = underlines[active->font_index];
      WriteFloat(output, active->color.red) << ' ';
      WriteFloat(output, active->color.green) << ' ';
      WriteFloat(output, active->color.blue) << " RG\n";
      WriteFloat(output, metrics.thickness * active->font_size) << " w\n";
      const float y = line.baseline + metrics.offset * active->font_size;
      WriteFloat(output, left) << ' ';
      WriteFloat(output, y) << " m ";
      WriteFloat(output, right) << ' ';
      WriteFloat(output, y) << " l S\n";
    };
    for (const ShapedGlyph& glyph : line.shaped.glyphs) {
      const auto* style = StyleAt(styles, line.start_utf16 + glyph.cluster.start);
      if (!style) return Fail("An underlined glyph is missing its text style.", error_message);
      const float start = line.x - line.min_x + pen_x + glyph.x_offset;
      const float end = line.x - line.min_x + pen_x + glyph.x_advance;
      const float glyph_left = std::min(start, end), glyph_right = std::max(start, end);
      if (!std::isfinite(glyph_left) || !std::isfinite(glyph_right)) {
        return Fail("A paragraph underline exceeds the usable coordinate range.", error_message);
      }
      if (!style->underline || style != active || glyph_left > right + kLayoutEpsilon) {
        flush();
        active = style->underline ? style : nullptr;
        left = glyph_left;
        right = glyph_right;
      } else {
        left = std::min(left, glyph_left);
        right = std::max(right, glyph_right);
      }
      pen_x += glyph.x_advance;
    }
    flush();
  }
  output << "EMC\nQ\n";
  *content = output.str();
  return true;
}

WideString WideStringFromUtf16(const std::u16string& value) {
  std::vector<uint8_t> bytes;
  bytes.reserve(value.size() * 2);
  for (char16_t unit : value) {
    const uint16_t word = static_cast<uint16_t>(unit);
    bytes.push_back(static_cast<uint8_t>(word));
    bytes.push_back(static_cast<uint8_t>(word >> 8));
  }
  return WideString::FromUTF16LE(bytes);
}

const char* AlignmentName(ParagraphAlignment alignment) {
  switch (alignment) {
    case ParagraphAlignment::kLeft:
      return "Left";
    case ParagraphAlignment::kCenter:
      return "Center";
    case ParagraphAlignment::kRight:
      return "Right";
  }
  return "Left";
}

const char* DirectionName(TextDirection direction) {
  switch (direction) {
    case TextDirection::kAuto:
      return "Auto";
    case TextDirection::kLeftToRight:
      return "LTR";
    case TextDirection::kRightToLeft:
      return "RTL";
  }
  return "Auto";
}

void SetParagraphMetadata(CPDF_Document* document,
                          CPDF_Dictionary* stream_dict,
                          const std::vector<CPDF_Font*>& fonts,
                          const std::vector<ParagraphFont>& font_faces,
                          const std::vector<ParagraphStyleRun>& styles,
                          const ParagraphRequest& request,
                          const std::u16string& logical_text) {
  RetainPtr<CPDF_Dictionary> metadata =
      stream_dict->SetNewFor<CPDF_Dictionary>("KomoParagraph");
  metadata->SetNewFor<CPDF_Number>("Version", 1);
  const WideString text = WideStringFromUtf16(logical_text);
  metadata->SetNewFor<CPDF_String>("Text", text.AsStringView());
  metadata->SetNewFor<CPDF_Number>("Width", request.width);
  metadata->SetNewFor<CPDF_Number>("Height", request.height);
  metadata->SetNewFor<CPDF_Number>("FontSize", request.font_size);
  metadata->SetNewFor<CPDF_Number>("LineHeight", request.line_height);
  metadata->SetNewFor<CPDF_Number>("LetterSpacing", request.letter_spacing);
  if (request.underline) {
    metadata->SetNewFor<CPDF_Boolean>("Underline", true);
  }
  metadata->SetNewFor<CPDF_Name>("Alignment",
                                 AlignmentName(request.alignment));
  metadata->SetNewFor<CPDF_Name>("Direction",
                                 DirectionName(request.direction));
  const WideString language =
      WideString::FromUTF8(ByteStringView(request.language));
  metadata->SetNewFor<CPDF_String>("Language", language.AsStringView());
  auto color = metadata->SetNewFor<CPDF_Array>("Color");
  color->AppendNew<CPDF_Number>(request.color.red);
  color->AppendNew<CPDF_Number>(request.color.green);
  color->AppendNew<CPDF_Number>(request.color.blue);
  metadata->SetNewFor<CPDF_Reference>("Font", document,
                                      fonts[0]->GetFontDictObjNum());
  metadata->SetNewFor<CPDF_Name>("FontResource", ByteString("F0"));
  const WideString base_id = WideString::FromUTF8(ByteStringView(font_faces[0].id));
  metadata->SetNewFor<CPDF_String>("RegisteredFontId", base_id.AsStringView());
  if (!request.styles.empty()) {
    metadata->SetNewFor<CPDF_Number>("Version", 2);
    auto runs = metadata->SetNewFor<CPDF_Array>("StyleRuns");
    for (const auto& style : styles) {
      auto run = pdfium::MakeRetain<CPDF_Dictionary>();
      run->SetNewFor<CPDF_Number>("Start", static_cast<int>(style.range.start));
      run->SetNewFor<CPDF_Number>("End", static_cast<int>(style.range.end));
      run->SetNewFor<CPDF_Reference>("Font", document,
          fonts[style.font_index]->GetFontDictObjNum());
      const WideString id = WideString::FromUTF8(ByteStringView(font_faces[style.font_index].id));
      run->SetNewFor<CPDF_String>("RegisteredFontId", id.AsStringView());
      run->SetNewFor<CPDF_Number>("FontSize", style.font_size);
      run->SetNewFor<CPDF_Number>("LetterSpacing", style.letter_spacing);
      run->SetNewFor<CPDF_Boolean>("Underline", style.underline);
      auto rgb = run->SetNewFor<CPDF_Array>("Color");
      rgb->AppendNew<CPDF_Number>(style.color.red);
      rgb->AppendNew<CPDF_Number>(style.color.green);
      rgb->AppendNew<CPDF_Number>(style.color.blue);
      runs->Append(std::move(run));
    }
  }
}

FPDF_PAGEOBJECT CreateFormObject(CPDF_Document* document,
                                 const std::vector<CPDF_Font*>& fonts,
                                 const std::vector<ParagraphFont>& font_faces,
                                 const std::vector<ParagraphStyleRun>& styles,
                                 const ParagraphRequest& request,
                                 const std::u16string& logical_text,
                                 const fxcrt::string& content,
                                 std::string* error_message) {
  if (!document || fonts.empty()) {
    Fail("The paragraph requires embedded font resources.", error_message);
    return nullptr;
  }
  for (CPDF_Font* font : fonts) {
    if (!font || font->GetDocument() != document ||
        font->GetFontDictObjNum() == 0) {
      Fail("A paragraph font has no resource in the target document.", error_message);
      return nullptr;
    }
  }

  RetainPtr<CPDF_Stream> stream =
      document->NewIndirect<CPDF_Stream>(pdfium::as_byte_span(content));
  RetainPtr<CPDF_Dictionary> stream_dict = stream->GetMutableDict();
  stream_dict->SetNewFor<CPDF_Name>("Type", "XObject");
  stream_dict->SetNewFor<CPDF_Name>("Subtype", "Form");
  stream_dict->SetNewFor<CPDF_Number>("FormType", 1);
  stream_dict->SetRectFor("BBox",
                          CFX_FloatRect(0, 0, request.width, request.height));

  RetainPtr<CPDF_Dictionary> resources =
      stream_dict->SetNewFor<CPDF_Dictionary>("Resources");
  RetainPtr<CPDF_Dictionary> font_resources =
      resources->SetNewFor<CPDF_Dictionary>("Font");
  for (size_t index = 0; index < font_faces.size(); ++index) {
    font_resources->SetNewFor<CPDF_Reference>(ByteString(FontResourceName(index).c_str()),
                                               document, fonts[index]->GetFontDictObjNum());
  }
  SetParagraphMetadata(document, stream_dict.Get(), fonts,
                       font_faces, styles, request, logical_text);

  auto form = std::make_unique<CPDF_Form>(document, nullptr, stream, nullptr);
  form->ParseContent();
  if (!form->HasPageObjects()) {
    Fail("PDFium could not parse the paragraph Form content.", error_message);
    return nullptr;
  }
  auto form_object = std::make_unique<CPDF_FormObject>(
      CPDF_PageObject::kNoContentStream, std::move(form), CFX_Matrix());
  form_object->SetRect(
      CFX_FloatRect(0, 0, request.width, request.height));
  form_object->SetDirty(true);
  return FPDFPageObjectFromCPDFPageObject(form_object.release());
}

}  // namespace

bool CreateTextParagraph(FPDF_DOCUMENT document,
                         std::span<const ParagraphFont> font_faces,
                         const ParagraphRequest& request,
                         ParagraphResult* result,
                         std::string* error_message) {
  if (error_message) {
    error_message->clear();
  }
  if (!result) {
    return Fail("A paragraph output object is required.", error_message);
  }
  CPDF_Document* native_document = CPDFDocumentFromFPDFDocument(document);
  if (!native_document) {
    return Fail("A valid target PDF document is required.", error_message);
  }
  if (font_faces.empty() || font_faces[0].sfnt.empty()) {
    return Fail("A standalone prepared SFNT font face is required.",
                error_message);
  }
  std::vector<ParagraphFont> fonts(font_faces.begin(), font_faces.end());
  if (!ValidateRequest(request, error_message)) {
    return false;
  }

  TextShapingOptions whole_options;
  whole_options.font_size = request.font_size;
  whole_options.letter_spacing = request.letter_spacing;
  whole_options.direction = request.direction;
  whole_options.language = request.language;
  ShapedText whole_text;
  if (!ShapeText(fonts[0].sfnt, request.utf8, whole_options, &whole_text,
                 error_message)) {
    return false;
  }
  const auto styles = ResolvedStyles(request,
      static_cast<uint32_t>(whole_text.logical_text.size()));
  uint32_t next = 0;
  for (const auto& style : styles) {
    if (style.range.start != next || style.range.end <= next ||
        style.range.end > whole_text.logical_text.size() ||
        style.font_index >= fonts.size() || fonts[style.font_index].sfnt.empty() ||
        !IsFinitePositive(style.font_size) || !std::isfinite(style.letter_spacing)) {
      return Fail("Paragraph styles must cover ordered UTF-16 ranges with valid fonts.", error_message);
    }
    for (float component : {style.color.red, style.color.green, style.color.blue}) {
      if (!std::isfinite(component) || component < 0 || component > 1) {
        return Fail("Paragraph style RGB values must be between 0 and 1.", error_message);
      }
    }
    next = style.range.end;
  }
  if (next != whole_text.logical_text.size()) {
    return Fail("Paragraph styles do not cover the logical text.", error_message);
  }
  if (!request.styles.empty()) {
    std::vector<ShapingStyleRun> shaping_styles;
    if (!BuildShapingStyles(fonts, styles, 0, next, &shaping_styles, error_message) ||
        !ShapeStyledText(request.utf8, whole_options, shaping_styles, &whole_text,
                         error_message)) return false;
  }
  if (!whole_text.missing_glyphs.empty()) {
    return Fail(MissingGlyphMessage(whole_text.missing_glyphs.front(), 0),
                error_message);
  }

  std::vector<bool> line_breaks;
  std::vector<bool> hard_breaks;
  if (!CollectLineBreaks(whole_text.logical_text, request.language, &line_breaks,
                         &hard_breaks, error_message)) {
    return false;
  }

  std::vector<LayoutLine> lines;
  bool overflow = false;
  uint32_t paragraph_start = 0;
  for (uint32_t boundary = 1; boundary < hard_breaks.size(); ++boundary) {
    if (!hard_breaks[boundary]) {
      continue;
    }
    const uint32_t paragraph_end =
        HardBreakStart(whole_text.logical_text, paragraph_start, boundary);
    if (!WrapParagraph(fonts, styles, whole_text.logical_text, paragraph_start,
                       paragraph_end, whole_text.grapheme_boundaries,
                       line_breaks, request, &lines, &overflow,
                       error_message)) {
      return false;
    }
    paragraph_start = boundary;
  }
  if (!WrapParagraph(fonts, styles, whole_text.logical_text, paragraph_start,
                     static_cast<uint32_t>(whole_text.logical_text.size()),
                     whole_text.grapheme_boundaries, line_breaks, request,
                     &lines, &overflow, error_message)) {
    return false;
  }

  std::vector<std::vector<ShapedFontMapping>> mappings;
  std::vector<std::set<uint16_t>> unicode_codes;
  if (!BuildFontMappings(whole_text.logical_text, fonts.size(), &lines,
                         &mappings, &unicode_codes, error_message)) return false;
  std::vector<ScopedFont> loaded;
  std::vector<FPDF_FONT> handles;
  std::vector<CPDF_Font*> native_fonts;
  loaded.reserve(fonts.size());
  for (size_t index = 0; index < fonts.size(); ++index) {
    if (mappings[index].empty()) {
      return Fail("A paragraph font has no paintable glyphs; select a font used by its text.", error_message);
    }
    loaded.emplace_back(LoadShapedFontFace(document, fonts[index].info,
                                            fonts[index].sfnt, mappings[index],
                                            error_message));
    FPDF_FONT handle = loaded.back().get();
    CPDF_Font* native_font = handle ? CPDFFontFromFPDFFont(handle) : nullptr;
    if (!native_font) return Fail("PDFium could not load a paragraph shaped font.", error_message);
    if (!InstallParagraphToUnicode(native_document, native_font, mappings[index],
                                   unicode_codes[index], error_message)) return false;
    handles.push_back(handle);
    native_fonts.push_back(native_font);
  }

  ParagraphResult output;
  output.overflow = overflow;
  output.logical_text = whole_text.logical_text;
  if (!PositionLines(request, styles, handles, &lines, &output, error_message)) {
    return false;
  }

  std::vector<UnderlineMetrics> underlines(fonts.size());
  for (const auto& style : styles) {
    if (!style.underline) continue;
    float descent = 0;
    if (!FPDFFont_GetDescent(handles[style.font_index], 1, &descent) ||
        !ReadUnderlineMetrics(fonts[style.font_index].sfnt, 1, descent,
                              &underlines[style.font_index], error_message)) return false;
  }
  fxcrt::string content;
  if (!BuildContentStream(request, styles, lines, underlines, &content,
                          error_message)) return false;
  output.object = CreateFormObject(native_document, native_fonts, fonts, styles,
                                   request, whole_text.logical_text, content,
                                   error_message);
  if (!output.object) {
    return false;
  }

  *result = std::move(output);
  return true;
}

bool CreateTextParagraph(FPDF_DOCUMENT document,
                         const FontFaceInfo& font_info,
                         std::span<const uint8_t> sfnt,
                         const ParagraphRequest& request,
                         ParagraphResult* result,
                         std::string* error_message) {
  const ParagraphFont font{"", font_info, sfnt};
  return CreateTextParagraph(document, std::span<const ParagraphFont>(&font, 1),
                             request, result, error_message);
}

}  // namespace pdf_editor
