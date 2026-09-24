#include "text_shaping.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "hb-icu.h"
#include "hb-ot.h"
#include "hb.h"
#include "unicode/ubidi.h"
#include "unicode/ubrk.h"
#include "unicode/uchar.h"
#include "unicode/uscript.h"
#include "unicode/utypes.h"

namespace pdf_editor {
namespace {

struct DecodedCodePoint {
  uint32_t value = 0;
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
};

struct DecodedText {
  std::u16string logical_text;
  std::vector<uint16_t> harfbuzz_text;
  std::vector<UChar> icu_text;
  std::vector<DecodedCodePoint> code_points;
  std::vector<bool> scalar_boundaries;
};

struct ScriptRun {
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
  UScriptCode script = USCRIPT_COMMON;
};

bool Fail(std::string message, std::string* error_message) {
  if (error_message) {
    *error_message = std::move(message);
  }
  return false;
}

bool DecodeUtf8(std::string_view input,
                DecodedText* output,
                std::string* error_message) {
  output->logical_text.clear();
  output->harfbuzz_text.clear();
  output->icu_text.clear();
  output->code_points.clear();

  size_t index = 0;
  while (index < input.size()) {
    const uint8_t first = static_cast<uint8_t>(input[index]);
    uint32_t code_point = 0;
    size_t length = 0;
    if (first < 0x80) {
      code_point = first;
      length = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      code_point = first & 0x1f;
      length = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      code_point = first & 0x0f;
      length = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      code_point = first & 0x07;
      length = 4;
    } else {
      return Fail("Text shaping requires valid UTF-8.", error_message);
    }
    if (length > input.size() - index) {
      return Fail("Text shaping requires valid UTF-8.", error_message);
    }
    for (size_t offset = 1; offset < length; ++offset) {
      const uint8_t next = static_cast<uint8_t>(input[index + offset]);
      if ((next & 0xc0) != 0x80) {
        return Fail("Text shaping requires valid UTF-8.", error_message);
      }
      code_point = (code_point << 6) | (next & 0x3f);
    }
    if ((length == 2 && code_point < 0x80) ||
        (length == 3 && code_point < 0x800) ||
        (length == 4 && code_point < 0x10000) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      return Fail("Text shaping requires valid UTF-8.", error_message);
    }

    if (output->logical_text.size() >
        static_cast<size_t>(std::numeric_limits<uint32_t>::max()) - 2) {
      return Fail("The text is too large to shape.", error_message);
    }
    DecodedCodePoint decoded;
    decoded.value = code_point;
    decoded.start_utf16 =
        static_cast<uint32_t>(output->logical_text.size());
    if (code_point <= 0xffff) {
      const auto unit = static_cast<uint16_t>(code_point);
      output->logical_text.push_back(static_cast<char16_t>(unit));
      output->harfbuzz_text.push_back(unit);
      output->icu_text.push_back(static_cast<UChar>(unit));
    } else {
      const uint32_t supplementary = code_point - 0x10000;
      const uint16_t high =
          static_cast<uint16_t>(0xd800 + (supplementary >> 10));
      const uint16_t low =
          static_cast<uint16_t>(0xdc00 + (supplementary & 0x3ff));
      output->logical_text.push_back(static_cast<char16_t>(high));
      output->logical_text.push_back(static_cast<char16_t>(low));
      output->harfbuzz_text.push_back(high);
      output->harfbuzz_text.push_back(low);
      output->icu_text.push_back(static_cast<UChar>(high));
      output->icu_text.push_back(static_cast<UChar>(low));
    }
    decoded.end_utf16 = static_cast<uint32_t>(output->logical_text.size());
    output->code_points.push_back(decoded);
    index += length;
  }

  if (output->logical_text.size() >
      static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
    return Fail("The text is too large for ICU and HarfBuzz.", error_message);
  }
  output->scalar_boundaries.assign(output->logical_text.size() + 1, false);
  output->scalar_boundaries[0] = true;
  for (const DecodedCodePoint& code_point : output->code_points) {
    output->scalar_boundaries[code_point.start_utf16] = true;
    output->scalar_boundaries[code_point.end_utf16] = true;
  }
  return true;
}

bool CollectGraphemeBoundaries(const DecodedText& text,
                               std::vector<uint32_t>* boundaries,
                               std::string* error_message) {
  boundaries->clear();
  if (text.icu_text.empty()) {
    boundaries->push_back(0);
    return true;
  }

  UErrorCode status = U_ZERO_ERROR;
  std::unique_ptr<UBreakIterator, decltype(&ubrk_close)> iterator(
      ubrk_open(UBRK_CHARACTER, "en", text.icu_text.data(),
                static_cast<int32_t>(text.icu_text.size()), &status),
      &ubrk_close);
  if (U_FAILURE(status) || !iterator) {
    return Fail(std::string("ICU could not calculate grapheme boundaries: ") +
                    u_errorName(status),
                error_message);
  }
  for (int32_t boundary = ubrk_first(iterator.get()); boundary != UBRK_DONE;
       boundary = ubrk_next(iterator.get())) {
    if (boundary < 0 ||
        boundary > static_cast<int32_t>(text.icu_text.size()) ||
        !text.scalar_boundaries[static_cast<size_t>(boundary)]) {
      return Fail("ICU returned an invalid grapheme boundary.", error_message);
    }
    boundaries->push_back(static_cast<uint32_t>(boundary));
  }
  if (boundaries->empty() || boundaries->front() != 0 ||
      boundaries->back() != text.icu_text.size()) {
    return Fail("ICU returned incomplete grapheme boundaries.", error_message);
  }
  return true;
}

bool IsSpecificScript(UScriptCode script) {
  return script != USCRIPT_COMMON && script != USCRIPT_INHERITED &&
         script != USCRIPT_UNKNOWN && script != USCRIPT_INVALID_CODE;
}

bool BuildScriptRuns(const DecodedText& text,
                     uint32_t start_utf16,
                     uint32_t end_utf16,
                     std::vector<ScriptRun>* runs,
                     std::string* error_message) {
  runs->clear();
  if (start_utf16 >= end_utf16) {
    return true;
  }
  if (end_utf16 > text.logical_text.size() ||
      !text.scalar_boundaries[start_utf16] ||
      !text.scalar_boundaries[end_utf16]) {
    return Fail("ICU split a UTF-16 scalar while resolving bidi runs.",
                error_message);
  }

  std::vector<const DecodedCodePoint*> code_points;
  for (const DecodedCodePoint& code_point : text.code_points) {
    if (code_point.end_utf16 <= start_utf16) {
      continue;
    }
    if (code_point.start_utf16 >= end_utf16) {
      break;
    }
    if (code_point.start_utf16 < start_utf16 ||
        code_point.end_utf16 > end_utf16) {
      return Fail("ICU split a UTF-16 scalar while resolving bidi runs.",
                  error_message);
    }
    code_points.push_back(&code_point);
  }
  if (code_points.empty()) {
    return Fail("A non-empty bidi run contains no Unicode scalars.",
                error_message);
  }

  std::vector<UScriptCode> raw_scripts;
  raw_scripts.reserve(code_points.size());
  for (const DecodedCodePoint* code_point : code_points) {
    UErrorCode status = U_ZERO_ERROR;
    const UScriptCode script =
        uscript_getScript(static_cast<UChar32>(code_point->value), &status);
    if (U_FAILURE(status)) {
      return Fail(std::string("ICU could not resolve Unicode scripts: ") +
                      u_errorName(status),
                  error_message);
    }
    raw_scripts.push_back(script);
  }

  std::vector<std::optional<UScriptCode>> previous(raw_scripts.size());
  std::vector<std::optional<UScriptCode>> next(raw_scripts.size());
  std::optional<UScriptCode> current;
  for (size_t index = 0; index < raw_scripts.size(); ++index) {
    previous[index] = current;
    if (IsSpecificScript(raw_scripts[index])) {
      current = raw_scripts[index];
    }
  }
  current.reset();
  for (size_t index = raw_scripts.size(); index > 0; --index) {
    next[index - 1] = current;
    if (IsSpecificScript(raw_scripts[index - 1])) {
      current = raw_scripts[index - 1];
    }
  }

  std::vector<UScriptCode> effective = raw_scripts;
  for (size_t index = 0; index < effective.size(); ++index) {
    if (IsSpecificScript(effective[index])) {
      continue;
    }
    const UChar32 value = static_cast<UChar32>(code_points[index]->value);
    if (previous[index] && uscript_hasScript(value, *previous[index])) {
      effective[index] = *previous[index];
    } else if (next[index] && uscript_hasScript(value, *next[index])) {
      effective[index] = *next[index];
    } else if (previous[index]) {
      effective[index] = *previous[index];
    } else if (next[index]) {
      effective[index] = *next[index];
    } else {
      effective[index] = USCRIPT_COMMON;
    }
  }

  size_t first = 0;
  while (first < code_points.size()) {
    size_t limit = first + 1;
    while (limit < code_points.size() &&
           effective[limit] == effective[first]) {
      ++limit;
    }
    runs->push_back({code_points[first]->start_utf16,
                     code_points[limit - 1]->end_utf16, effective[first]});
    first = limit;
  }
  return true;
}

bool ShapeScriptRun(hb_font_t* font,
                    hb_language_t language,
                    const DecodedText& text,
                    const ScriptRun& script_run,
                    TextDirection direction,
                    uint32_t bidi_run_index,
                    float unit_scale,
                    uint32_t font_index,
                    std::vector<ShapedGlyph>* glyphs,
                    std::string* error_message) {
  std::unique_ptr<hb_buffer_t, decltype(&hb_buffer_destroy)> buffer(
      hb_buffer_create(), &hb_buffer_destroy);
  if (!buffer || buffer.get() == hb_buffer_get_empty()) {
    return Fail("HarfBuzz could not allocate a shaping buffer.", error_message);
  }

  hb_buffer_set_unicode_funcs(buffer.get(), hb_icu_get_unicode_funcs());
  hb_buffer_set_direction(
      buffer.get(), direction == TextDirection::kRightToLeft
                        ? HB_DIRECTION_RTL
                        : HB_DIRECTION_LTR);
  hb_buffer_set_script(buffer.get(), hb_icu_script_to_script(script_run.script));
  hb_buffer_set_language(buffer.get(), language);
  hb_buffer_set_cluster_level(buffer.get(),
                              HB_BUFFER_CLUSTER_LEVEL_MONOTONE_GRAPHEMES);
  hb_buffer_flags_t flags = HB_BUFFER_FLAG_DEFAULT;
  if (script_run.start_utf16 == 0) {
    flags = static_cast<hb_buffer_flags_t>(flags | HB_BUFFER_FLAG_BOT);
  }
  if (script_run.end_utf16 == text.harfbuzz_text.size()) {
    flags = static_cast<hb_buffer_flags_t>(flags | HB_BUFFER_FLAG_EOT);
  }
  hb_buffer_set_flags(buffer.get(), flags);
  hb_buffer_add_utf16(
      buffer.get(), text.harfbuzz_text.data(),
      static_cast<int>(text.harfbuzz_text.size()), script_run.start_utf16,
      static_cast<int>(script_run.end_utf16 - script_run.start_utf16));
  if (!hb_buffer_allocation_successful(buffer.get())) {
    return Fail("HarfBuzz could not allocate the Unicode shaping buffer.",
                error_message);
  }

  const char* const shapers[] = {"ot", nullptr};
  if (!hb_shape_full(font, buffer.get(), nullptr, 0, shapers) ||
      !hb_buffer_allocation_successful(buffer.get())) {
    return Fail("The pinned HarfBuzz OpenType shaper could not shape the text.",
                error_message);
  }

  unsigned int info_count = 0;
  unsigned int position_count = 0;
  hb_glyph_info_t* infos =
      hb_buffer_get_glyph_infos(buffer.get(), &info_count);
  hb_glyph_position_t* positions =
      hb_buffer_get_glyph_positions(buffer.get(), &position_count);
  if (info_count != position_count || (info_count != 0 && (!infos || !positions))) {
    return Fail("HarfBuzz returned inconsistent glyph data.", error_message);
  }

  std::vector<uint32_t> cluster_starts;
  cluster_starts.reserve(info_count);
  for (unsigned int index = 0; index < info_count; ++index) {
    const uint32_t cluster = infos[index].cluster;
    if (cluster < script_run.start_utf16 ||
        cluster >= script_run.end_utf16 ||
        !text.scalar_boundaries[cluster]) {
      return Fail("HarfBuzz returned an invalid UTF-16 cluster.", error_message);
    }
    cluster_starts.push_back(cluster);
  }
  std::sort(cluster_starts.begin(), cluster_starts.end());
  cluster_starts.erase(
      std::unique(cluster_starts.begin(), cluster_starts.end()),
      cluster_starts.end());

  glyphs->reserve(glyphs->size() + info_count);
  for (unsigned int index = 0; index < info_count; ++index) {
    const uint32_t cluster_start = infos[index].cluster;
    const auto found =
        std::lower_bound(cluster_starts.begin(), cluster_starts.end(),
                         cluster_start);
    if (found == cluster_starts.end() || *found != cluster_start) {
      return Fail("HarfBuzz returned an unresolvable glyph cluster.",
                  error_message);
    }
    const auto following = std::next(found);
    const uint32_t cluster_end =
        following == cluster_starts.end() ? script_run.end_utf16 : *following;
    ShapedGlyph glyph;
    glyph.glyph_id = infos[index].codepoint;
    glyph.font_index = font_index;
    glyph.x_advance = positions[index].x_advance * unit_scale;
    glyph.y_advance = positions[index].y_advance * unit_scale;
    glyph.x_offset = positions[index].x_offset * unit_scale;
    glyph.y_offset = positions[index].y_offset * unit_scale;
    glyph.cluster = {cluster_start, cluster_end};
    glyph.bidi_run_index = bidi_run_index;
    if (!std::isfinite(glyph.x_advance) ||
        !std::isfinite(glyph.y_advance) ||
        !std::isfinite(glyph.x_offset) || !std::isfinite(glyph.y_offset)) {
      return Fail("HarfBuzz returned glyph metrics outside the usable range.",
                  error_message);
    }
    glyphs->push_back(glyph);
  }
  return true;
}

void ApplyLetterSpacing(std::span<const ShapingStyleRun> styles,
                        BidiVisualRun* run,
                        std::vector<ShapedGlyph>* glyphs) {
  const size_t begin = run->glyph_start;
  const size_t end = begin + run->glyph_count;
  size_t first = begin;
  while (first < end) {
    size_t limit = first + 1;
    while (limit < end &&
           (*glyphs)[limit].cluster.start == (*glyphs)[first].cluster.start &&
           (*glyphs)[limit].cluster.end == (*glyphs)[first].cluster.end) {
      ++limit;
    }
    if (limit < end) {
      const uint32_t position = (*glyphs)[first].cluster.start;
      for (const auto& style : styles) {
        if (style.range.start <= position && position < style.range.end) {
          (*glyphs)[limit - 1].x_advance += style.letter_spacing;
          break;
        }
      }
    }
    first = limit;
  }

  run->x_advance = 0;
  run->y_advance = 0;
  for (size_t index = begin; index < end; ++index) {
    run->x_advance += (*glyphs)[index].x_advance;
    run->y_advance += (*glyphs)[index].y_advance;
  }
}

bool IsVisibleCodePoint(uint32_t code_point) {
  if (u_hasBinaryProperty(static_cast<UChar32>(code_point),
                          UCHAR_DEFAULT_IGNORABLE_CODE_POINT) ||
      u_hasBinaryProperty(static_cast<UChar32>(code_point),
                          UCHAR_VARIATION_SELECTOR)) {
    return false;
  }
  const int8_t category = u_charType(static_cast<UChar32>(code_point));
  return category != U_CONTROL_CHAR && category != U_FORMAT_CHAR &&
         category != U_LINE_SEPARATOR && category != U_PARAGRAPH_SEPARATOR;
}

void CollectMissingGlyphs(hb_font_t* font,
                          const DecodedText& text,
                          ShapedText* result) {
  std::set<std::tuple<uint32_t, uint32_t, uint32_t>> seen;
  for (const ShapedGlyph& glyph : result->glyphs) {
    if (glyph.glyph_id != 0) {
      continue;
    }

    bool reported = false;
    const DecodedCodePoint* first_visible = nullptr;
    for (const DecodedCodePoint& code_point : text.code_points) {
      if (code_point.end_utf16 <= glyph.cluster.start) {
        continue;
      }
      if (code_point.start_utf16 >= glyph.cluster.end) {
        break;
      }
      if (!IsVisibleCodePoint(code_point.value)) {
        continue;
      }
      if (!first_visible) {
        first_visible = &code_point;
      }
      hb_codepoint_t nominal_glyph = 0;
      if (!hb_font_get_nominal_glyph(font, code_point.value, &nominal_glyph) ||
          nominal_glyph == 0) {
        const auto key = std::make_tuple(code_point.start_utf16,
                                         code_point.end_utf16,
                                         code_point.value);
        if (seen.insert(key).second) {
          result->missing_glyphs.push_back(
              {code_point.value,
               {code_point.start_utf16, code_point.end_utf16}});
        }
        reported = true;
      }
    }
    if (!reported && first_visible) {
      const auto key =
          std::make_tuple(first_visible->start_utf16, first_visible->end_utf16,
                          first_visible->value);
      if (seen.insert(key).second) {
        result->missing_glyphs.push_back(
            {first_visible->value,
             {first_visible->start_utf16, first_visible->end_utf16}});
      }
    }
  }
  std::sort(result->missing_glyphs.begin(), result->missing_glyphs.end(),
            [](const MissingGlyph& left, const MissingGlyph& right) {
              return std::tie(left.text_range.start, left.text_range.end,
                              left.code_point) <
                     std::tie(right.text_range.start, right.text_range.end,
                              right.code_point);
            });
}

}  // namespace

bool ShapeTextImpl(std::span<const uint8_t> sfnt,
                   std::string_view utf8,
                   const TextShapingOptions& options,
                   std::span<const ShapingStyleRun> styles,
                   ShapedText* result,
                   std::string* error_message) {
  if (error_message) {
    error_message->clear();
  }
  if (!result) {
    return Fail("A text shaping output object is required.", error_message);
  }
  if (styles.empty() &&
      (sfnt.empty() || sfnt.size() > std::numeric_limits<unsigned int>::max())) {
    return Fail("Text shaping requires a standalone SFNT font face.",
                error_message);
  }
  if (!std::isfinite(options.font_size) || options.font_size <= 0 ||
      !std::isfinite(options.letter_spacing)) {
    return Fail("Font size must be positive and shaping metrics must be finite.",
                error_message);
  }
  if (options.language.size() >
      static_cast<size_t>(std::numeric_limits<int>::max())) {
    return Fail("The shaping language tag is too large.", error_message);
  }

  DecodedText decoded;
  if (!DecodeUtf8(utf8, &decoded, error_message)) {
    return false;
  }

  std::vector<ShapingStyleRun> default_styles;
  if (styles.empty() && !decoded.logical_text.empty()) {
    default_styles.push_back({{0, static_cast<uint32_t>(decoded.logical_text.size())},
                              sfnt, options.font_size, options.letter_spacing, 0});
    styles = default_styles;
  }
  struct ShapingFont {
    std::unique_ptr<hb_blob_t, decltype(&hb_blob_destroy)> blob{nullptr, &hb_blob_destroy};
    std::unique_ptr<hb_face_t, decltype(&hb_face_destroy)> face{nullptr, &hb_face_destroy};
    std::unique_ptr<hb_font_t, decltype(&hb_font_destroy)> font{nullptr, &hb_font_destroy};
    float scale = 0;
  };
  std::vector<ShapingFont> fonts;
  fonts.reserve(styles.size());
  uint32_t next_start = 0;
  for (const ShapingStyleRun& style : styles) {
    if (style.range.start != next_start || style.range.end <= next_start ||
        style.range.end > decoded.logical_text.size() ||
        !std::isfinite(style.font_size) || style.font_size <= 0 ||
        !std::isfinite(style.letter_spacing) || style.sfnt.empty() ||
        style.sfnt.size() > std::numeric_limits<unsigned int>::max()) {
      return Fail("Shaping styles must cover whole ordered UTF-16 ranges with valid fonts and sizes.", error_message);
    }
    next_start = style.range.end;
    ShapingFont item;
    item.blob.reset(hb_blob_create_or_fail(
        reinterpret_cast<const char*>(style.sfnt.data()),
        static_cast<unsigned int>(style.sfnt.size()),
        HB_MEMORY_MODE_READONLY, nullptr, nullptr));
    item.face.reset(item.blob ? hb_face_create_or_fail(item.blob.get(), 0) : nullptr);
    if (!item.face || hb_face_get_glyph_count(item.face.get()) == 0 ||
        hb_face_get_upem(item.face.get()) == 0) {
      return Fail("HarfBuzz could not create a usable SFNT face.", error_message);
    }
    item.font.reset(hb_font_create(item.face.get()));
    if (!item.font || item.font.get() == hb_font_get_empty()) {
      return Fail("HarfBuzz could not create a font for shaping.", error_message);
    }
    hb_ot_font_set_funcs(item.font.get());
    const unsigned int upem = hb_face_get_upem(item.face.get());
    hb_font_set_scale(item.font.get(), static_cast<int>(upem), static_cast<int>(upem));
    hb_font_set_ptem(item.font.get(), style.font_size);
    item.scale = style.font_size / upem;
    fonts.push_back(std::move(item));
  }
  if (next_start != decoded.logical_text.size()) {
    return Fail("Shaping styles must cover the entire logical text.", error_message);
  }

  const hb_language_t language =
      options.language.empty()
          ? hb_language_from_string("und", -1)
          : hb_language_from_string(options.language.data(),
                                    static_cast<int>(options.language.size()));

  ShapedText shaped;
  shaped.logical_text = decoded.logical_text;
  if (!CollectGraphemeBoundaries(decoded, &shaped.grapheme_boundaries,
                                 error_message)) {
    return false;
  }
  for (const ShapingStyleRun& style : styles) {
    if (!std::binary_search(shaped.grapheme_boundaries.begin(),
                            shaped.grapheme_boundaries.end(), style.range.start) ||
        !std::binary_search(shaped.grapheme_boundaries.begin(),
                            shaped.grapheme_boundaries.end(), style.range.end)) {
      return Fail("Shaping style boundaries must preserve complete graphemes.", error_message);
    }
  }
  if (decoded.icu_text.empty()) {
    shaped.base_direction =
        options.direction == TextDirection::kRightToLeft
            ? TextDirection::kRightToLeft
            : TextDirection::kLeftToRight;
    *result = std::move(shaped);
    return true;
  }

  UErrorCode status = U_ZERO_ERROR;
  std::unique_ptr<UBiDi, decltype(&ubidi_close)> bidi(
      ubidi_openSized(static_cast<int32_t>(decoded.icu_text.size()), 0, &status),
      &ubidi_close);
  if (U_FAILURE(status) || !bidi) {
    return Fail(std::string("ICU could not allocate bidi state: ") +
                    u_errorName(status),
                error_message);
  }
  UBiDiLevel paragraph_level = UBIDI_DEFAULT_LTR;
  if (options.direction == TextDirection::kLeftToRight) {
    paragraph_level = UBIDI_LTR;
  } else if (options.direction == TextDirection::kRightToLeft) {
    paragraph_level = UBIDI_RTL;
  }
  status = U_ZERO_ERROR;
  ubidi_setPara(bidi.get(), decoded.icu_text.data(),
                static_cast<int32_t>(decoded.icu_text.size()), paragraph_level,
                nullptr, &status);
  if (U_FAILURE(status)) {
    return Fail(std::string("ICU could not resolve bidirectional text: ") +
                    u_errorName(status),
                error_message);
  }
  shaped.base_direction = (ubidi_getParaLevel(bidi.get()) & 1U)
                              ? TextDirection::kRightToLeft
                              : TextDirection::kLeftToRight;

  status = U_ZERO_ERROR;
  const int32_t run_count = ubidi_countRuns(bidi.get(), &status);
  if (U_FAILURE(status) || run_count < 0) {
    return Fail(std::string("ICU could not enumerate bidi visual runs: ") +
                    u_errorName(status),
                error_message);
  }
  shaped.visual_runs.reserve(static_cast<size_t>(run_count));
  for (int32_t visual_index = 0; visual_index < run_count; ++visual_index) {
    int32_t logical_start = 0;
    int32_t logical_length = 0;
    const UBiDiDirection icu_direction = ubidi_getVisualRun(
        bidi.get(), visual_index, &logical_start, &logical_length);
    if (logical_start < 0 || logical_length <= 0 ||
        logical_start > static_cast<int32_t>(decoded.icu_text.size()) -
                            logical_length) {
      return Fail("ICU returned an invalid bidi visual run.", error_message);
    }
    const uint32_t start_utf16 = static_cast<uint32_t>(logical_start);
    const uint32_t end_utf16 =
        static_cast<uint32_t>(logical_start + logical_length);
    if (!decoded.scalar_boundaries[start_utf16] ||
        !decoded.scalar_boundaries[end_utf16]) {
      return Fail("ICU split a UTF-16 scalar in a bidi visual run.",
                  error_message);
    }
    const TextDirection direction =
        icu_direction == UBIDI_RTL ? TextDirection::kRightToLeft
                                   : TextDirection::kLeftToRight;

    BidiVisualRun visual_run;
    visual_run.logical_range = {start_utf16, end_utf16};
    visual_run.direction = direction;
    visual_run.embedding_level = ubidi_getLevelAt(bidi.get(), logical_start);
    visual_run.glyph_start = static_cast<uint32_t>(shaped.glyphs.size());

    std::vector<ScriptRun> script_runs;
    if (!BuildScriptRuns(decoded, start_utf16, end_utf16, &script_runs,
                         error_message)) {
      return false;
    }
    std::vector<std::pair<ScriptRun, size_t>> styled_runs;
    for (const ScriptRun& script_run : script_runs) {
      uint32_t cursor = script_run.start_utf16;
      for (size_t index = 0; index < styles.size() && cursor < script_run.end_utf16; ++index) {
        const auto& style = styles[index];
        if (style.range.end <= cursor || style.range.start >= script_run.end_utf16) continue;
        const uint32_t end = std::min(script_run.end_utf16, style.range.end);
        styled_runs.push_back({{cursor, end, script_run.script}, index});
        cursor = end;
      }
      if (cursor != script_run.end_utf16) {
        return Fail("A script run is missing a font style.", error_message);
      }
    }
    if (direction == TextDirection::kRightToLeft) {
      std::reverse(styled_runs.begin(), styled_runs.end());
    }
    for (const auto& [script_run, index] : styled_runs) {
      const auto& style = styles[index];
      if (!ShapeScriptRun(fonts[index].font.get(), language, decoded, script_run,
                          direction, static_cast<uint32_t>(visual_index),
                          fonts[index].scale, style.font_index, &shaped.glyphs,
                          error_message)) {
        return false;
      }
    }
    const size_t glyph_count = shaped.glyphs.size() - visual_run.glyph_start;
    if (glyph_count > std::numeric_limits<uint32_t>::max()) {
      return Fail("The shaped glyph result is too large.", error_message);
    }
    visual_run.glyph_count = static_cast<uint32_t>(glyph_count);
    ApplyLetterSpacing(styles, &visual_run, &shaped.glyphs);
    shaped.visual_runs.push_back(visual_run);
  }

  // A .notdef is surfaced to the paragraph caller together with its exact
  // UTF-16 cluster; fonts can differ on either side of a style boundary.
  if (styles.size() == 1) {
    CollectMissingGlyphs(fonts[0].font.get(), decoded, &shaped);
  } else for (const ShapedGlyph& glyph : shaped.glyphs) {
    if (glyph.glyph_id != 0) continue;
    for (const DecodedCodePoint& point : decoded.code_points) {
      if (point.start_utf16 >= glyph.cluster.end) break;
      if (point.end_utf16 > glyph.cluster.start && IsVisibleCodePoint(point.value)) {
        shaped.missing_glyphs.push_back({point.value, {point.start_utf16, point.end_utf16}});
        break;
      }
    }
  }
  *result = std::move(shaped);
  return true;
}

bool ShapeText(std::span<const uint8_t> sfnt,
               std::string_view utf8,
               const TextShapingOptions& options,
               ShapedText* result,
               std::string* error_message) {
  return ShapeTextImpl(sfnt, utf8, options, {}, result, error_message);
}

bool ShapeStyledText(std::string_view utf8,
                     const TextShapingOptions& options,
                     std::span<const ShapingStyleRun> styles,
                     ShapedText* result,
                     std::string* error_message) {
  if (styles.empty()) {
    return Fail("Styled shaping requires a font for every character.", error_message);
  }
  return ShapeTextImpl({}, utf8, options, styles, result, error_message);
}

}  // namespace pdf_editor
