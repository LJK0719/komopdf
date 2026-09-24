#include "pdf_editor_api.h"

#include "font_runtime.h"
#include "recovery_codec.h"
#include "native_file_path.h"
#include "text_paragraph.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <type_traits>
#include <utility>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/edit/cpdf_pagecontentgenerator.h"
#include "core/fpdfapi/page/cpdf_contentmarkitem.h"
#include "core/fpdfapi/page/cpdf_docpagedata.h"
#include "core/fpdfapi/page/cpdf_form.h"
#include "core/fpdfapi/page/cpdf_formobject.h"
#include "core/fpdfapi/page/cpdf_image.h"
#include "core/fpdfapi/page/cpdf_imageobject.h"
#include "core/fpdfapi/page/cpdf_page.h"
#include "core/fpdfapi/page/cpdf_pageobject.h"
#include "core/fpdfapi/page/cpdf_pageobjectholder.h"
#include "core/fpdfapi/page/cpdf_path.h"
#include "core/fpdfapi/page/cpdf_pathobject.h"
#include "core/fpdfapi/page/cpdf_textobject.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_object.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_stream_acc.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfapi/parser/fpdf_parser_decode.h"
#include "core/fpdfdoc/cpdf_formcontrol.h"
#include "core/fpdfdoc/cpdf_formfield.h"
#include "core/fpdfdoc/cpdf_interactiveform.h"
#include "core/fxcrt/bytestring.h"
#include "core/fxcrt/fileaccess_iface.h"
#include "core/fxcrt/retain_ptr.h"
#include "core/fxcrt/widestring.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "pdf_editor_bridge/form_edit.h"
#include "pdf_editor_bridge/document_tools.h"
#include "public/fpdf_annot.h"
#include "public/fpdf_doc.h"
#include "public/fpdf_formfill.h"
#include "public/fpdf_edit.h"
#include "public/fpdf_ppo.h"
#include "public/fpdf_save.h"
#include "public/fpdf_signature.h"
#include "public/fpdf_text.h"
#include "public/fpdf_transformpage.h"
#include "public/fpdfview.h"
#include "unicode/ubrk.h"

namespace {

constexpr uint32_t kAbiVersion = 3;
constexpr size_t kCopyChunkSize = 64 * 1024;
constexpr size_t kMaxObjectDepth = 64;
constexpr size_t kUndoLimit = 100;
constexpr uint32_t kMaxEditCount = 4096;
constexpr uint32_t kMaxFontBytes = 64 * 1024 * 1024;
constexpr size_t kMaxTextBytes = 16 * 1024 * 1024;
constexpr uint32_t kKnownStyleFlags = 1U | 2U | 4U | 8U;
constexpr uint32_t kTextStyleRangeFlag = 16U;
constexpr uint32_t kTextStyleUnderlineFlag = 32U;
constexpr uint32_t kTextInsertLineHeightFlag = 16U;
constexpr uint32_t kTextInsertCenterFlag = 32U;
constexpr uint32_t kTextInsertRightFlag = 64U;
constexpr uint32_t kTextInvisibleFlag = 128U;
constexpr uint32_t kTextFitBoundsFlag = 256U;
constexpr uint32_t kTextOcrFlag = 512U;
constexpr uint32_t kTextParagraphFlag = 1024U;
constexpr uint32_t kTextUnderlineFlag = 2048U;
constexpr uint32_t kKnownTextInsertFlags =
    kKnownStyleFlags | kTextInsertLineHeightFlag | kTextInsertCenterFlag |
    kTextInsertRightFlag | kTextInvisibleFlag | kTextFitBoundsFlag |
    kTextOcrFlag | kTextParagraphFlag | kTextUnderlineFlag;
constexpr double kDefaultLineHeight = 1.2;
constexpr double kLayoutEpsilon = 0.01;
constexpr double kMatrixEpsilon = 1e-12;
constexpr std::string_view kCapabilitiesJson =
    "[\"text.replace\",\"text.style\",\"text.insert\","
    "\"objects.transform\",\"objects.delete\",\"pages.rotate\","
    "\"pages.delete\",\"pages.reorder\",\"pages.insert\","
    "\"image.insert\",\"content.insert\",\"pages.duplicate\","
    "\"pages.import\",\"image.replace\",\"image.crop\","
    "\"objects.copy\",\"annotation.add\",\"form.fill\",\"form.create\",\"text.reflow\",\"objects.align\",\"annotation.update\",\"annotation.delete\",\"objects.distribute\",\"pages.crop\",\"objects.group\",\"objects.ungroup\",\"form.update\"]";

struct Matrix {
  double a = 1;
  double b = 0;
  double c = 0;
  double d = 1;
  double e = 0;
  double f = 0;

  Matrix Then(const Matrix& next) const {
    return {
        next.a * a + next.c * b,          next.b * a + next.d * b,
        next.a * c + next.c * d,          next.b * c + next.d * d,
        next.a * e + next.c * f + next.e, next.b * e + next.d * f + next.f,
    };
  }

  std::array<double, 2> Apply(double x, double y) const {
    return {a * x + c * y + e, b * x + d * y + f};
  }
};

bool IsFiniteMatrix(const Matrix& matrix) {
  return std::isfinite(matrix.a) && std::isfinite(matrix.b) &&
         std::isfinite(matrix.c) && std::isfinite(matrix.d) &&
         std::isfinite(matrix.e) && std::isfinite(matrix.f);
}

std::optional<Matrix> InverseMatrix(const Matrix& matrix) {
  const double determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!std::isfinite(determinant) || std::abs(determinant) <= kMatrixEpsilon) {
    return std::nullopt;
  }
  return Matrix{matrix.d / determinant,
                -matrix.b / determinant,
                -matrix.c / determinant,
                matrix.a / determinant,
                (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
                (matrix.b * matrix.e - matrix.a * matrix.f) / determinant};
}

struct Rect {
  double x = 0;
  double y = 0;
  double width = 0;
  double height = 0;
};

struct TextLayoutLine {
  Rect bounds;
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
};

struct TextInsertLayoutResult {
  Rect bounds;
  bool overflow = false;
  std::vector<TextLayoutLine> lines;
};

struct TextStyleData {
  std::optional<std::string> font_id;
  std::optional<double> font_size;
  std::optional<std::array<double, 3>> color;
  std::optional<double> character_spacing;
  std::optional<int> weight;
  std::optional<bool> italic;
  std::optional<bool> underline;
};

struct StyledRunData {
  std::string text;
  TextStyleData style;
};

struct TextBlockData {
  std::string id;
  std::string page_id;
  std::string source_id;
  std::string object_id;
  std::string text;
  TextStyleData style;
  std::vector<StyledRunData> runs;
  Rect bounds;
  Matrix transform;
  std::string editability = "direct";
  bool is_ocr = false;
  bool is_paragraph = false;
};

struct ObjectData {
  std::string id;
  std::string page_id;
  std::string type;
  Rect bounds;
  Matrix transform;
  std::vector<uint32_t> container_path;
  uint32_t object_index = 0;
  std::optional<TextBlockData> text_block;
};

struct PageData {
  std::string id;
  double width_pt = 0;
  double height_pt = 0;
  int rotation = 0;
  std::vector<ObjectData> objects;
  std::vector<TextBlockData> text_blocks;
};

struct FontResource {
  std::string id;
  std::vector<uint8_t> original_bytes;
  std::vector<uint8_t> extracted_sfnt;
  pdf_editor::FontFaceInfo face;

  std::span<const uint8_t> SfntBytes() const {
    return extracted_sfnt.empty() ? std::span<const uint8_t>(original_bytes)
                                  : std::span<const uint8_t>(extracted_sfnt);
  }
};

struct ImageResource {
  std::string id;
  uint32_t width = 0;
  uint32_t height = 0;
  std::vector<uint8_t> rgba;
};

struct PdfResource {
  std::string id;
  std::vector<uint8_t> bytes;
  uint32_t page_count = 0;
};

enum class EditType : uint32_t {
  kTextReplace = 1,
  kTextStyle = 2,
  kTextInsert = 3,
  kObjectsTransform = 4,
  kObjectsDelete = 5,
  kPagesRotate = 6,
  kPagesDelete = 7,
  kPagesReorder = 8,
  kPagesInsert = 9,
  kImageInsert = 10,
  kContentInsert = 11,
  kPagesDuplicate = 12,
  kPagesImport = 13,
  kImageReplace = 14,
  kImageCrop = 15,
  kObjectsCopy = 16,
  kAnnotationAdd = 17,
  kFormFill = 18,
  kFormCreate = 19,
  kTextReflow = 20,
  kObjectsAlign = 21,
  kAnnotationUpdate = 22,
  kAnnotationDelete = 23,
  kObjectsDistribute = 24,
  kPagesCrop = 25,
  kObjectsGroup = 26,
  kObjectsUngroup = 27,
  kFormUpdate = 28,
};

struct EditCommand {
  EditType type = EditType::kTextReplace;
  std::string page_id;
  std::string target_id;
  std::string resource_id;
  std::string text;
  std::string font_id;
  std::string transaction_id;
  uint32_t transaction_index = 0;
  std::vector<std::string> ids;
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
  uint32_t flags = 0;
  uint32_t resource_page_index = 0;
  std::array<double, 10> values{};
};

struct EditTransaction {
  std::string id;
  std::vector<EditCommand> commands;
};

struct ObjectIdentity {
  std::string id;
  std::string text_block_id;
  std::vector<ObjectIdentity> children;
};

struct PageIdentity {
  std::string id;
  std::vector<ObjectIdentity> objects;
};

struct CandidateMetadata {
  std::vector<PageIdentity> pages;
};

#if defined(__wasm32__) || defined(__EMSCRIPTEN__)
static_assert(sizeof(PdeEditCommand) == 128,
              "PdeEditCommand must be 128 bytes on wasm32");
static_assert(offsetof(PdeEditCommand, values) == 48,
              "PdeEditCommand values must start at byte 48 on wasm32");
#endif

struct Document {
  ~Document() {
    if (pdf) {
      FPDF_CloseDocument(pdf);
    }
  }

  uint32_t handle = 0;
  uint64_t session_id = 0;
  std::string document_id;
  std::string source_id;
  std::vector<uint8_t> memory_source;
  std::unique_ptr<FileAccessIface> file_source;
  std::string source_path;
  std::string source_password;
  int64_t source_size = 0;
  FPDF_DOCUMENT pdf = nullptr;
  bool editing_allowed = false;
  uint32_t revision = 0;
  uint32_t saved_revision = 0;
  size_t undoable_count = 0;
  CandidateMetadata source_metadata;
  CandidateMetadata metadata;
  std::vector<EditTransaction> transactions;
  std::vector<EditTransaction> redo_transactions;
  std::set<std::string> transaction_ids;
  std::set<std::string> reserved_ids;
  std::map<std::string, std::shared_ptr<const FontResource>> font_resources;
  std::map<std::string, std::shared_ptr<const ImageResource>> image_resources;
  std::map<std::string, std::shared_ptr<const PdfResource>> pdf_resources;
};

class ScopedDocument {
 public:
  explicit ScopedDocument(FPDF_DOCUMENT document) : document_(document) {}
  ~ScopedDocument() {
    if (document_) {
      FPDF_CloseDocument(document_);
    }
  }

  FPDF_DOCUMENT get() const { return document_; }
  FPDF_DOCUMENT release() { return std::exchange(document_, nullptr); }

 private:
  FPDF_DOCUMENT document_;
};

class ScopedPage {
 public:
  explicit ScopedPage(FPDF_PAGE page) : page_(page) {}
  ScopedPage(const ScopedPage&) = delete;
  ScopedPage& operator=(const ScopedPage&) = delete;
  ScopedPage(ScopedPage&& other) noexcept
      : page_(std::exchange(other.page_, nullptr)) {}
  ScopedPage& operator=(ScopedPage&& other) noexcept {
    if (this != &other) {
      if (page_) {
        FPDF_ClosePage(page_);
      }
      page_ = std::exchange(other.page_, nullptr);
    }
    return *this;
  }
  ~ScopedPage() {
    if (page_) {
      FPDF_ClosePage(page_);
    }
  }
  FPDF_PAGE get() const { return page_; }

 private:
  FPDF_PAGE page_;
};

class ScopedTextPage {
 public:
  explicit ScopedTextPage(FPDF_TEXTPAGE page) : page_(page) {}
  ~ScopedTextPage() {
    if (page_) {
      FPDFText_ClosePage(page_);
    }
  }
  FPDF_TEXTPAGE get() const { return page_; }

 private:
  FPDF_TEXTPAGE page_;
};

class ScopedBitmap {
 public:
  explicit ScopedBitmap(FPDF_BITMAP bitmap) : bitmap_(bitmap) {}
  ~ScopedBitmap() {
    if (bitmap_) {
      FPDFBitmap_Destroy(bitmap_);
    }
  }
  FPDF_BITMAP get() const { return bitmap_; }

 private:
  FPDF_BITMAP bitmap_;
};

bool g_initialized = false;
uint32_t g_next_handle = 1;
uint64_t g_next_session_id = 1;
std::map<uint32_t, std::unique_ptr<Document>> g_documents;
std::map<std::string, std::shared_ptr<const FontResource>> g_fonts;
std::string g_result;
std::vector<uint8_t> g_binary;
std::string g_error_code;
std::string g_error_message;

void ReleaseOutputs() {
  std::string().swap(g_result);
  std::vector<uint8_t>().swap(g_binary);
}

void BeginOperation() {
  ReleaseOutputs();
  g_error_code.clear();
  g_error_message.clear();
}

void SetError(std::string code, std::string message) {
  ReleaseOutputs();
  g_error_code = std::move(code);
  g_error_message = std::move(message);
}

void SetUnexpectedError() {
  SetError("CORE_UNAVAILABLE",
           "The PDF core could not complete the operation.");
}

void SetAllocationError() {
  SetError("RESOURCE_LIMIT", "The operation exceeded available memory.");
}

template <typename Result, typename Function>
Result Guard(Result failure, Function&& function) {
  try {
    return function();
  } catch (const std::bad_alloc&) {
    SetAllocationError();
  } catch (...) {
    SetUnexpectedError();
  }
  return failure;
}

bool RequireInitialized() {
  if (g_initialized) {
    return true;
  }
  SetError("CORE_UNAVAILABLE", "The PDF core is not initialized.");
  return false;
}

bool IsValidUtf8(std::string_view value) {
  size_t index = 0;
  while (index < value.size()) {
    const uint8_t first = static_cast<uint8_t>(value[index]);
    if (first < 0x80) {
      ++index;
      continue;
    }

    size_t count = 0;
    uint32_t code_point = 0;
    if ((first & 0xe0) == 0xc0) {
      count = 2;
      code_point = first & 0x1f;
      if (code_point < 2) {
        return false;
      }
    } else if ((first & 0xf0) == 0xe0) {
      count = 3;
      code_point = first & 0x0f;
    } else if ((first & 0xf8) == 0xf0) {
      count = 4;
      code_point = first & 0x07;
      if (code_point > 4) {
        return false;
      }
    } else {
      return false;
    }

    if (index + count > value.size()) {
      return false;
    }
    for (size_t offset = 1; offset < count; ++offset) {
      const uint8_t next = static_cast<uint8_t>(value[index + offset]);
      if ((next & 0xc0) != 0x80) {
        return false;
      }
      code_point = (code_point << 6) | (next & 0x3f);
    }
    if ((count == 3 && code_point < 0x800) ||
        (count == 4 && code_point < 0x10000) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      return false;
    }
    index += count;
  }
  return true;
}

bool DecodeUtf8(std::string_view value, std::vector<uint32_t>* code_points) {
  code_points->clear();
  size_t index = 0;
  while (index < value.size()) {
    const uint8_t first = static_cast<uint8_t>(value[index]);
    uint32_t code_point = 0;
    size_t count = 0;
    if (first < 0x80) {
      code_point = first;
      count = 1;
    } else if ((first & 0xe0) == 0xc0) {
      code_point = first & 0x1f;
      count = 2;
    } else if ((first & 0xf0) == 0xe0) {
      code_point = first & 0x0f;
      count = 3;
    } else if ((first & 0xf8) == 0xf0) {
      code_point = first & 0x07;
      count = 4;
    } else {
      return false;
    }
    if (index + count > value.size()) {
      return false;
    }
    for (size_t offset = 1; offset < count; ++offset) {
      const uint8_t next = static_cast<uint8_t>(value[index + offset]);
      if ((next & 0xc0) != 0x80) {
        return false;
      }
      code_point = (code_point << 6) | (next & 0x3f);
    }
    if ((count == 2 && code_point < 0x80) ||
        (count == 3 && code_point < 0x800) ||
        (count == 4 && code_point < 0x10000) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff) {
      return false;
    }
    code_points->push_back(code_point);
    index += count;
  }
  return true;
}

struct LayoutCodePoint {
  uint32_t value = 0;
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
};

struct LayoutText {
  std::vector<UChar> utf16;
  std::vector<size_t> byte_offsets;
  std::vector<LayoutCodePoint> code_points;
};

bool DecodeLayoutText(std::string_view value, LayoutText* output) {
  output->utf16.clear();
  output->byte_offsets.clear();
  output->code_points.clear();
  output->byte_offsets.push_back(0);
  size_t index = 0;
  while (index < value.size()) {
    const uint8_t first = static_cast<uint8_t>(value[index]);
    uint32_t code_point = 0;
    size_t count = 0;
    if (first < 0x80) {
      code_point = first;
      count = 1;
    } else if ((first & 0xe0) == 0xc0) {
      code_point = first & 0x1f;
      count = 2;
    } else if ((first & 0xf0) == 0xe0) {
      code_point = first & 0x0f;
      count = 3;
    } else if ((first & 0xf8) == 0xf0) {
      code_point = first & 0x07;
      count = 4;
    } else {
      return false;
    }
    if (index + count > value.size()) {
      return false;
    }
    for (size_t offset = 1; offset < count; ++offset) {
      const uint8_t next = static_cast<uint8_t>(value[index + offset]);
      if ((next & 0xc0) != 0x80) {
        return false;
      }
      code_point = (code_point << 6) | (next & 0x3f);
    }
    if ((count == 2 && code_point < 0x80) ||
        (count == 3 && code_point < 0x800) ||
        (count == 4 && code_point < 0x10000) ||
        (code_point >= 0xd800 && code_point <= 0xdfff) ||
        code_point > 0x10ffff ||
        output->utf16.size() > std::numeric_limits<uint32_t>::max() - 2ULL) {
      return false;
    }

    LayoutCodePoint decoded;
    decoded.value = code_point;
    decoded.start_utf16 = static_cast<uint32_t>(output->utf16.size());
    if (code_point <= 0xffff) {
      output->utf16.push_back(static_cast<UChar>(code_point));
      output->byte_offsets.push_back(index + count);
    } else {
      const uint32_t supplementary = code_point - 0x10000;
      output->utf16.push_back(
          static_cast<UChar>(0xd800 + (supplementary >> 10)));
      output->byte_offsets.push_back(std::numeric_limits<size_t>::max());
      output->utf16.push_back(
          static_cast<UChar>(0xdc00 + (supplementary & 0x3ff)));
      output->byte_offsets.push_back(index + count);
    }
    decoded.end_utf16 = static_cast<uint32_t>(output->utf16.size());
    output->code_points.push_back(decoded);
    index += count;
  }
  return true;
}

bool CollectUnicodeBreaks(UBreakIteratorType type,
                          const std::vector<UChar>& text,
                          std::vector<bool>* boundaries) {
  boundaries->assign(text.size() + 1, false);
  if (text.empty()) {
    (*boundaries)[0] = true;
    return true;
  }
  if (text.size() > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
    SetError("RESOURCE_LIMIT", "The inserted text is too large to lay out.");
    return false;
  }
  UErrorCode status = U_ZERO_ERROR;
  std::unique_ptr<UBreakIterator, decltype(&ubrk_close)> iterator(
      ubrk_open(type, "en", text.data(), static_cast<int32_t>(text.size()),
                &status),
      &ubrk_close);
  if (U_FAILURE(status) || !iterator) {
    SetError("CORE_UNAVAILABLE",
             std::string("Unicode text boundaries could not be calculated: ") +
                 u_errorName(status));
    return false;
  }
  for (int32_t boundary = ubrk_first(iterator.get()); boundary != UBRK_DONE;
       boundary = ubrk_next(iterator.get())) {
    if (boundary >= 0 &&
        boundary <= static_cast<int32_t>(text.size())) {
      (*boundaries)[static_cast<size_t>(boundary)] = true;
    }
  }
  return true;
}

bool Utf8ToPdfWide(std::string_view value,
                   std::vector<FPDF_WCHAR>* output,
                   uint32_t* utf16_length) {
  std::vector<uint32_t> code_points;
  if (!DecodeUtf8(value, &code_points)) {
    return false;
  }
  output->clear();
  output->reserve(code_points.size() + 1);
  for (uint32_t code_point : code_points) {
    if (code_point <= 0xffff) {
      output->push_back(static_cast<FPDF_WCHAR>(code_point));
    } else {
      code_point -= 0x10000;
      output->push_back(static_cast<FPDF_WCHAR>(0xd800 + (code_point >> 10)));
      output->push_back(static_cast<FPDF_WCHAR>(0xdc00 + (code_point & 0x3ff)));
    }
  }
  if (output->size() > std::numeric_limits<uint32_t>::max()) {
    return false;
  }
  *utf16_length = static_cast<uint32_t>(output->size());
  output->push_back(0);
  return true;
}

uint32_t Utf16Length(std::string_view value) {
  std::vector<FPDF_WCHAR> ignored;
  uint32_t length = 0;
  return Utf8ToPdfWide(value, &ignored, &length) ? length : 0;
}

bool ContainsUnsupportedLineBreak(std::string_view value) {
  return value.find('\n') != std::string_view::npos ||
         value.find('\r') != std::string_view::npos;
}

bool ValidateId(const char* value, const char* label) {
  if (!value || !value[0]) {
    SetError("INVALID_REQUEST", std::string(label) + " is required.");
    return false;
  }
  const std::string_view text(value);
  if (text.size() > 160 || !IsValidUtf8(text)) {
    SetError(
        "INVALID_REQUEST",
        std::string(label) + " must be valid UTF-8 with at most 160 bytes.");
    return false;
  }
  return true;
}

bool ValidateUtf8Argument(const char* value,
                          const char* label,
                          bool allow_empty) {
  if (!value || (!allow_empty && !value[0])) {
    SetError("INVALID_REQUEST", std::string(label) + " is required.");
    return false;
  }
  if (!IsValidUtf8(value)) {
    SetError("INVALID_REQUEST", std::string(label) + " must be valid UTF-8.");
    return false;
  }
  return true;
}

void AppendJsonString(std::string* output, std::string_view value) {
  static constexpr char kHex[] = "0123456789abcdef";
  output->push_back('"');
  for (const uint8_t byte : value) {
    switch (byte) {
      case '"':
        output->append("\\\"");
        break;
      case '\\':
        output->append("\\\\");
        break;
      case '\b':
        output->append("\\b");
        break;
      case '\f':
        output->append("\\f");
        break;
      case '\n':
        output->append("\\n");
        break;
      case '\r':
        output->append("\\r");
        break;
      case '\t':
        output->append("\\t");
        break;
      default:
        if (byte < 0x20) {
          output->append("\\u00");
          output->push_back(kHex[byte >> 4]);
          output->push_back(kHex[byte & 0x0f]);
        } else {
          output->push_back(static_cast<char>(byte));
        }
        break;
    }
  }
  output->push_back('"');
}

void AppendJsonNumber(std::string* output, double value) {
  if (!std::isfinite(value)) {
    throw std::runtime_error("non-finite JSON number");
  }
  if (value == 0) {
    output->push_back('0');
    return;
  }
  char buffer[64];
  const auto result = std::to_chars(std::begin(buffer), std::end(buffer), value,
                                    std::chars_format::general,
                                    std::numeric_limits<double>::max_digits10);
  if (result.ec != std::errc()) {
    throw std::runtime_error("JSON number conversion failed");
  }
  output->append(buffer, result.ptr);
}

void AppendJsonUnsigned(std::string* output, uint64_t value) {
  char buffer[32];
  const auto result =
      std::to_chars(std::begin(buffer), std::end(buffer), value);
  if (result.ec != std::errc()) {
    throw std::runtime_error("JSON integer conversion failed");
  }
  output->append(buffer, result.ptr);
}

void AppendFontFaceInfo(std::string* output,
                        const pdf_editor::FontFaceInfo& face,
                        std::string_view id = {}) {
  output->push_back('{');
  if (!id.empty()) {
    output->append("\"id\":");
    AppendJsonString(output, id);
    output->append(",\"faceIndex\":");
    AppendJsonUnsigned(output, face.index);
    output->push_back(',');
  }
  output->append("\"index\":");
  AppendJsonUnsigned(output, face.index);
  output->append(",\"family\":");
  AppendJsonString(output, face.family);
  output->append(",\"style\":");
  AppendJsonString(output, face.style);
  output->append(",\"format\":");
  AppendJsonString(output, pdf_editor::FontFormatName(face.format));
  output->append(",\"weight\":");
  AppendJsonUnsigned(output, face.weight);
  output->append(",\"italic\":");
  output->append(face.italic ? "true" : "false");
  output->append(",\"fsType\":");
  AppendJsonUnsigned(output, face.fs_type);
  output->append(",\"editableEmbedding\":");
  output->append(face.editable_embedding ? "true" : "false");
  output->push_back('}');
}

void AppendJsonSigned(std::string* output, int64_t value) {
  char buffer[32];
  const auto result =
      std::to_chars(std::begin(buffer), std::end(buffer), value);
  if (result.ec != std::errc()) {
    throw std::runtime_error("JSON integer conversion failed");
  }
  output->append(buffer, result.ptr);
}

std::string SourcePageId(const Document& document, uint32_t page_index) {
  return "p:" + std::to_string(document.session_id) + ":" +
         std::to_string(page_index);
}

std::string SourceObjectId(const Document& document,
                           uint32_t page_index,
                           uint64_t ordinal) {
  return "o:" + std::to_string(document.session_id) + ":" +
         std::to_string(page_index) + ":" + std::to_string(ordinal);
}

std::string SourceTextBlockId(const Document& document,
                              uint32_t page_index,
                              uint64_t ordinal) {
  return "t:" + std::to_string(document.session_id) + ":" +
         std::to_string(page_index) + ":" + std::to_string(ordinal);
}

uint64_t StableIdHash(std::string_view value) {
  uint64_t hash = 1469598103934665603ULL;
  for (uint8_t byte : value) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return hash;
}

std::string GeneratedObjectId(const Document& document,
                              std::string_view seed,
                              uint64_t ordinal) {
  return "o:" + std::to_string(document.session_id) +
         ":g:" + std::to_string(StableIdHash(seed)) + ":" +
         std::to_string(ordinal);
}

std::string GeneratedTextBlockId(const Document& document,
                                 std::string_view seed,
                                 uint64_t ordinal) {
  return "t:" + std::to_string(document.session_id) +
         ":g:" + std::to_string(StableIdHash(seed)) + ":" +
         std::to_string(ordinal);
}

Document* FindDocument(uint32_t handle) {
  const auto found = g_documents.find(handle);
  if (found == g_documents.end()) {
    SetError("DOCUMENT_NOT_FOUND", "The document handle is not open.");
    return nullptr;
  }
  return found->second.get();
}

bool DocumentIdIsOpen(std::string_view document_id) {
  return std::any_of(g_documents.begin(), g_documents.end(),
                     [document_id](const auto& entry) {
                       return entry.second->document_id == document_id;
                     });
}

uint32_t AllocateHandle() {
  if (g_documents.size() >= std::numeric_limits<uint32_t>::max() - 1ULL) {
    return 0;
  }
  for (;;) {
    const uint32_t candidate = g_next_handle++;
    if (g_next_handle == 0) {
      g_next_handle = 1;
    }
    if (candidate != 0 && !g_documents.contains(candidate)) {
      return candidate;
    }
  }
}

uint64_t AllocateSessionId() {
  const uint64_t result = g_next_session_id++;
  if (g_next_session_id == 0) {
    g_next_session_id = 1;
  }
  return result == 0 ? AllocateSessionId() : result;
}

void SetPdfOpenError() {
  if (FPDF_GetLastError() == FPDF_ERR_PASSWORD) {
    SetError("PASSWORD_REQUIRED", "A valid PDF password is required.");
    return;
  }
  SetError("INVALID_REQUEST", "The PDF document could not be opened.");
}

Matrix MatrixFromCfx(const CFX_Matrix& matrix) {
  return {matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f};
}

Matrix MatrixFromFs(const FS_MATRIX& matrix) {
  return {matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f};
}

Rect TransformBounds(double left,
                     double bottom,
                     double right,
                     double top,
                     const Matrix& matrix) {
  const double min_x = std::min(left, right);
  const double max_x = std::max(left, right);
  const double min_y = std::min(bottom, top);
  const double max_y = std::max(bottom, top);
  const std::array<std::array<double, 2>, 4> points = {
      matrix.Apply(min_x, min_y), matrix.Apply(max_x, min_y),
      matrix.Apply(min_x, max_y), matrix.Apply(max_x, max_y)};
  double result_min_x = points[0][0];
  double result_max_x = points[0][0];
  double result_min_y = points[0][1];
  double result_max_y = points[0][1];
  for (const auto& point : points) {
    result_min_x = std::min(result_min_x, point[0]);
    result_max_x = std::max(result_max_x, point[0]);
    result_min_y = std::min(result_min_y, point[1]);
    result_max_y = std::max(result_max_y, point[1]);
  }
  return {result_min_x, result_min_y, result_max_x - result_min_x,
          result_max_y - result_min_y};
}

double GetUserUnit(CPDF_Page* page) {
  std::set<const CPDF_Dictionary*> visited;
  RetainPtr<const CPDF_Dictionary> dictionary = page->GetDict();
  while (dictionary && !visited.contains(dictionary.Get())) {
    visited.insert(dictionary.Get());
    if (dictionary->KeyExist("UserUnit")) {
      const double value = dictionary->GetFloatFor("UserUnit");
      return std::isfinite(value) && value > 0 ? value : 1.0;
    }
    dictionary = dictionary->GetDictFor("Parent");
  }
  return 1.0;
}

void AppendCodePointUtf8(uint32_t code_point, std::string* output) {
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

std::string Utf16ToUtf8(const std::vector<FPDF_WCHAR>& input, size_t length) {
  std::string result;
  for (size_t index = 0; index < length; ++index) {
    uint32_t code_point = input[index];
    if (code_point >= 0xd800 && code_point <= 0xdbff) {
      if (index + 1 < length && input[index + 1] >= 0xdc00 &&
          input[index + 1] <= 0xdfff) {
        code_point =
            0x10000 + ((code_point - 0xd800) << 10) + (input[++index] - 0xdc00);
      } else {
        code_point = 0xfffd;
      }
    } else if (code_point >= 0xdc00 && code_point <= 0xdfff) {
      code_point = 0xfffd;
    }
    AppendCodePointUtf8(code_point, &result);
  }
  return result;
}

std::string GetTextForObject(FPDF_PAGEOBJECT object, FPDF_TEXTPAGE text_page) {
  // GetTextByObject also appends whitespace belonging to the next object.
  // Edit ranges must refer only to this object's actual mapped characters,
  // not reading-order separators inferred by the page text extractor.
  std::vector<FPDF_WCHAR> buffer;
  const int count = FPDFText_CountChars(text_page);
  for (int index = 0; index < count; ++index) {
    if (FPDFText_GetTextObject(text_page, index) != object ||
        FPDFText_IsGenerated(text_page, index) == 1) continue;
    const uint32_t code_point = FPDFText_GetUnicode(text_page, index);
    if (!code_point) continue;
    if (code_point > 0xffff && code_point <= 0x10ffff) {
      buffer.push_back(static_cast<FPDF_WCHAR>(0xd800 + ((code_point - 0x10000) >> 10)));
      buffer.push_back(static_cast<FPDF_WCHAR>(0xdc00 + ((code_point - 0x10000) & 0x3ff)));
    } else {
      buffer.push_back(static_cast<FPDF_WCHAR>(code_point));
    }
  }
  return Utf16ToUtf8(buffer, buffer.size());
}

TextStyleData GetTextStyle(FPDF_PAGEOBJECT object) {
  TextStyleData style;
  float font_size = 0;
  if (FPDFTextObj_GetFontSize(object, &font_size) && std::isfinite(font_size) &&
      font_size > 0 && font_size <= 1000) {
    style.font_size = font_size;
  }

  unsigned int red = 0;
  unsigned int green = 0;
  unsigned int blue = 0;
  unsigned int alpha = 0;
  if (FPDFPageObj_GetFillColor(object, &red, &green, &blue, &alpha)) {
    style.color =
        std::array<double, 3>{red / 255.0, green / 255.0, blue / 255.0};
  }

  CPDF_PageObject* native_object = CPDFPageObjectFromFPDFPageObject(object);
  CPDF_TextObject* native_text =
      native_object ? native_object->AsText() : nullptr;
  if (native_text) {
    const double spacing = native_text->text_state().GetCharSpace();
    if (std::isfinite(spacing)) {
      style.character_spacing = spacing;
    }
  }

  const FPDF_FONT font = FPDFTextObj_GetFont(object);
  if (font) {
    const int weight = FPDFFont_GetWeight(font);
    if (weight >= 100 && weight <= 900) {
      style.weight = weight;
    }
    int italic_angle = 0;
    if (FPDFFont_GetItalicAngle(font, &italic_angle)) {
      style.italic = italic_angle != 0;
    }
  }
  return style;
}

RetainPtr<const CPDF_Dictionary> ParagraphMetadata(FPDF_PAGEOBJECT object) {
  const auto* native = CPDFPageObjectFromFPDFPageObject(object);
  const auto* form = native ? native->AsForm() : nullptr;
  const auto dictionary = form ? form->form()->GetDict()->GetDictFor("KomoParagraph") : nullptr;
  const int version = dictionary ? dictionary->GetIntegerFor("Version") : 0;
  return dictionary && (version == 1 ||
         (version == 2 && dictionary->GetArrayFor("StyleRuns"))) &&
         dictionary->KeyExist("Text") && dictionary->GetFloatFor("Width") > 0 &&
         dictionary->GetFloatFor("Height") > 0 ? dictionary : nullptr;
}

RetainPtr<const CPDF_Dictionary> GroupMetadata(FPDF_PAGEOBJECT object) {
  const auto* native = CPDFPageObjectFromFPDFPageObject(object);
  const auto* form = native ? native->AsForm() : nullptr;
  const auto dictionary = form ? form->form()->GetDict()->GetDictFor("KomoGroup") : nullptr;
  const int count = form ? FPDFFormObj_CountObjects(object) : -1;
  const auto ids = dictionary ? dictionary->GetArrayFor("Ids") : nullptr;
  const auto text_ids = dictionary ? dictionary->GetArrayFor("TextIds") : nullptr;
  return dictionary && dictionary->GetIntegerFor("Version") == 1 && count >= 2 &&
         ids && text_ids && ids->size() == static_cast<size_t>(count) &&
         text_ids->size() == static_cast<size_t>(count) &&
         !dictionary->GetUnicodeTextFor("Id").IsEmpty() ? dictionary : nullptr;
}

bool RewriteGroupMetadata(FPDF_PAGEOBJECT object, const ObjectIdentity& identity) {
  auto* native = CPDFPageObjectFromFPDFPageObject(object);
  auto* form = native ? native->AsForm() : nullptr;
  if (!form || !GroupMetadata(object) ||
      form->form()->GetPageObjectCount() != identity.children.size()) {
    SetError("INVALID_REQUEST", "A copied group has inconsistent child identities.");
    return false;
  }
  // Imported pages and copied objects may share the original Form stream.
  form->form()->DetachStreamForEditing();
  auto group = form->form()->GetMutableDict()->GetMutableDictFor("KomoGroup");
  const WideString name = WideString::FromUTF8(ByteStringView(identity.id));
  group->SetNewFor<CPDF_String>("Id", name.AsStringView());
  auto ids = group->SetNewFor<CPDF_Array>("Ids");
  auto text_ids = group->SetNewFor<CPDF_Array>("TextIds");
  for (const auto& child : identity.children) {
    const WideString id = WideString::FromUTF8(ByteStringView(child.id));
    const WideString text_id = WideString::FromUTF8(ByteStringView(child.text_block_id));
    ids->AppendNew<CPDF_String>(id.AsStringView());
    text_ids->AppendNew<CPDF_String>(text_id.AsStringView());
  }
  native->SetDirty(true);
  return true;
}

bool IsOcrTextObject(FPDF_PAGEOBJECT object) {
  if (FPDFPageObj_CountMarks(object) != 1 ||
      FPDFTextObj_GetTextRenderMode(object) != FPDF_TEXTRENDERMODE_INVISIBLE) return false;
  const auto* mark = CPDFContentMarkItemFromFPDFPageObjectMark(FPDFPageObj_GetMark(object, 0));
  return mark && mark->GetName() == "KomoOCR";
}

bool HasSupportedTextMarks(FPDF_PAGEOBJECT object) {
  const int mark_count = FPDFPageObj_CountMarks(object);
  if (mark_count == 0) {
    return true;
  }
  if (mark_count != 1) {
    return false;
  }
  FPDF_PAGEOBJECTMARK mark = FPDFPageObj_GetMark(object, 0);
  CPDF_ContentMarkItem* item = CPDFContentMarkItemFromFPDFPageObjectMark(mark);
  if (!item || item->GetParamType() != CPDF_ContentMarkItem::kDirectDict) {
    return false;
  }
  RetainPtr<const CPDF_Dictionary> params = item->GetParam();
  return params && params->size() == 1 && params->KeyExist("ActualText");
}

std::string ObjectTypeName(int type) {
  switch (type) {
    case FPDF_PAGEOBJ_TEXT:
      return "text";
    case FPDF_PAGEOBJ_IMAGE:
      return "image";
    case FPDF_PAGEOBJ_PATH:
      return "path";
    case FPDF_PAGEOBJ_FORM:
      return "form";
    default:
      return "group";
  }
}

bool IsActiveObject(FPDF_PAGEOBJECT object) {
  FPDF_BOOL active = true;
  return !FPDFPageObj_GetIsActive(object, &active) || active;
}

bool BuildSourceObjectIdentity(const Document& document,
                               uint32_t page_index,
                               FPDF_PAGEOBJECT object,
                               size_t depth,
                               uint64_t* next_ordinal,
                               ObjectIdentity* identity) {
  if (depth > kMaxObjectDepth) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The PDF object nesting is too complex to edit safely.");
    return false;
  }
  if (!IsActiveObject(object)) {
    return true;
  }
  const uint64_t ordinal = (*next_ordinal)++;
  identity->id = SourceObjectId(document, page_index, ordinal);
  const int type = FPDFPageObj_GetType(object);
  if (type == FPDF_PAGEOBJ_TEXT || ParagraphMetadata(object)) {
    identity->text_block_id = SourceTextBlockId(document, page_index, ordinal);
  }
  if (type != FPDF_PAGEOBJ_FORM) {
    return true;
  }
  const int child_count = FPDFFormObj_CountObjects(object);
  if (child_count < 0) {
    SetUnexpectedError();
    return false;
  }
  identity->children.resize(static_cast<size_t>(child_count));
  for (int index = 0; index < child_count; ++index) {
    FPDF_PAGEOBJECT child =
        FPDFFormObj_GetObject(object, static_cast<unsigned long>(index));
    if (!child || !BuildSourceObjectIdentity(
                      document, page_index, child, depth + 1, next_ordinal,
                      &identity->children[static_cast<size_t>(index)])) {
      if (g_error_code.empty()) {
        SetUnexpectedError();
      }
      return false;
    }
  }
  if (const auto group = GroupMetadata(object)) {
    const ByteString id = group->GetUnicodeTextFor("Id").ToUTF8();
    if (id.GetLength() != std::strlen(id.c_str()) ||
        !ValidateId(id.c_str(), "Saved group ID")) return false;
    identity->id.assign(id.c_str(), id.GetLength());
    std::set<std::string> seen{identity->id};
    const auto ids = group->GetArrayFor("Ids");
    const auto text_ids = group->GetArrayFor("TextIds");
    for (size_t index = 0; index < identity->children.size(); ++index) {
      const ByteString child = ids->GetUnicodeTextAt(index).ToUTF8();
      const ByteString text = text_ids->GetUnicodeTextAt(index).ToUTF8();
      if (child.GetLength() != std::strlen(child.c_str()) ||
          text.GetLength() != std::strlen(text.c_str()) ||
          !ValidateId(child.c_str(), "Saved group child ID") ||
          !seen.insert({child.c_str(), child.GetLength()}).second ||
          (!text.IsEmpty() && (!ValidateId(text.c_str(), "Saved text block ID") ||
                             !seen.insert({text.c_str(), text.GetLength()}).second))) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "Saved group identities are duplicated or malformed.");
        return false;
      }
      identity->children[index].id.assign(child.c_str(), child.GetLength());
      identity->children[index].text_block_id.assign(text.c_str(), text.GetLength());
    }
  }
  return true;
}

bool BuildGeneratedObjectIdentity(const Document& document,
                                  std::string_view seed,
                                  FPDF_PAGEOBJECT object,
                                  size_t depth,
                                  uint64_t* next_ordinal,
                                  ObjectIdentity* identity) {
  if (depth > kMaxObjectDepth) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The inserted Form XObject nesting is too complex.");
    return false;
  }
  if (!IsActiveObject(object)) {
    return true;
  }
  const uint64_t ordinal = (*next_ordinal)++;
  identity->id = GeneratedObjectId(document, seed, ordinal);
  const int type = FPDFPageObj_GetType(object);
  if (type == FPDF_PAGEOBJ_TEXT || ParagraphMetadata(object)) {
    identity->text_block_id = GeneratedTextBlockId(document, seed, ordinal);
  }
  if (type != FPDF_PAGEOBJ_FORM) {
    return true;
  }
  const int child_count = FPDFFormObj_CountObjects(object);
  if (child_count < 0) {
    SetUnexpectedError();
    return false;
  }
  identity->children.resize(static_cast<size_t>(child_count));
  for (int index = 0; index < child_count; ++index) {
    FPDF_PAGEOBJECT child =
        FPDFFormObj_GetObject(object, static_cast<unsigned long>(index));
    if (!child || !BuildGeneratedObjectIdentity(
                      document, seed, child, depth + 1, next_ordinal,
                      &identity->children[static_cast<size_t>(index)])) {
      if (g_error_code.empty()) {
        SetUnexpectedError();
      }
      return false;
    }
  }
  return true;
}

bool IdentityTreeHasCollision(const ObjectIdentity& identity,
                              const CandidateMetadata& metadata,
                              std::set<std::string>* local_ids);

bool BuildGeneratedPageIdentity(const Document& document,
                                FPDF_DOCUMENT pdf,
                                size_t page_index,
                                std::string_view page_id,
                                const CandidateMetadata& metadata,
                                PageIdentity* identity) {
  if (page_index > static_cast<size_t>(std::numeric_limits<int>::max())) {
    SetError("RESOURCE_LIMIT", "The imported page index is too large.");
    return false;
  }
  ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(page_index)));
  if (!page.get()) {
    SetError("CORE_UNAVAILABLE", "The imported PDF page could not be loaded.");
    return false;
  }
  const int object_count = FPDFPage_CountObjects(page.get());
  if (object_count < 0) {
    SetUnexpectedError();
    return false;
  }
  identity->id = std::string(page_id);
  identity->objects.resize(static_cast<size_t>(object_count));
  uint64_t next_ordinal = 0;
  std::set<std::string> generated_ids{identity->id};
  for (int index = 0; index < object_count; ++index) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page.get(), index);
    ObjectIdentity& object_identity =
        identity->objects[static_cast<size_t>(index)];
    if (!object ||
        !BuildGeneratedObjectIdentity(document, page_id, object, 0,
                                      &next_ordinal, &object_identity)) {
      if (g_error_code.empty()) {
        SetUnexpectedError();
      }
      return false;
    }
    if (IdentityTreeHasCollision(object_identity, metadata, &generated_ids)) {
      SetError(
          "INVALID_REQUEST",
          "An imported page object identity collides with an existing ID.");
      return false;
    }
  }
  return true;
}

void AddIdentityIds(const ObjectIdentity& identity,
                    std::set<std::string>* ids) {
  if (!identity.id.empty()) {
    ids->insert(identity.id);
  }
  if (!identity.text_block_id.empty()) {
    ids->insert(identity.text_block_id);
  }
  for (const ObjectIdentity& child : identity.children) {
    AddIdentityIds(child, ids);
  }
}

bool BuildInitialMetadata(Document* document) {
  const int page_count = FPDF_GetPageCount(document->pdf);
  if (page_count <= 0) {
    SetError("INVALID_REQUEST", "The PDF must contain at least one page.");
    return false;
  }
  CandidateMetadata metadata;
  metadata.pages.resize(static_cast<size_t>(page_count));
  for (int page_index = 0; page_index < page_count; ++page_index) {
    PageIdentity& page_identity =
        metadata.pages[static_cast<size_t>(page_index)];
    page_identity.id =
        SourcePageId(*document, static_cast<uint32_t>(page_index));
    ScopedPage page(FPDF_LoadPage(document->pdf, page_index));
    if (!page.get()) {
      SetError("CORE_UNAVAILABLE", "The PDF page could not be loaded.");
      return false;
    }
    const int object_count = FPDFPage_CountObjects(page.get());
    if (object_count < 0) {
      SetUnexpectedError();
      return false;
    }
    page_identity.objects.resize(static_cast<size_t>(object_count));
    uint64_t next_ordinal = 0;
    for (int object_index = 0; object_index < object_count; ++object_index) {
      FPDF_PAGEOBJECT object = FPDFPage_GetObject(page.get(), object_index);
      if (!object ||
          !BuildSourceObjectIdentity(
              *document, static_cast<uint32_t>(page_index), object, 0,
              &next_ordinal,
              &page_identity.objects[static_cast<size_t>(object_index)])) {
        if (g_error_code.empty()) {
          SetUnexpectedError();
        }
        return false;
      }
    }
  }
  document->source_metadata = metadata;
  document->metadata = std::move(metadata);
  for (const PageIdentity& page : document->metadata.pages) {
    document->reserved_ids.insert(page.id);
    for (const ObjectIdentity& object : page.objects) {
      AddIdentityIds(object, &document->reserved_ids);
    }
  }
  return true;
}

std::optional<size_t> FindPageIndex(const CandidateMetadata& metadata,
                                    std::string_view page_id) {
  for (size_t index = 0; index < metadata.pages.size(); ++index) {
    if (metadata.pages[index].id == page_id) {
      return index;
    }
  }
  return std::nullopt;
}

struct IdentityLocation {
  ObjectIdentity* identity = nullptr;
  std::vector<size_t> path;
};

bool FindIdentityInObjects(std::vector<ObjectIdentity>* objects,
                           std::string_view id,
                           bool text_id,
                           std::vector<size_t>* path,
                           IdentityLocation* result) {
  for (size_t index = 0; index < objects->size(); ++index) {
    ObjectIdentity& identity = (*objects)[index];
    path->push_back(index);
    const std::string& candidate =
        text_id ? identity.text_block_id : identity.id;
    if (!candidate.empty() && candidate == id) {
      result->identity = &identity;
      result->path = *path;
      path->pop_back();
      return true;
    }
    if (FindIdentityInObjects(&identity.children, id, text_id, path, result)) {
      path->pop_back();
      return true;
    }
    path->pop_back();
  }
  return false;
}

bool FindIdentity(PageIdentity* page,
                  std::string_view id,
                  bool text_id,
                  IdentityLocation* result) {
  std::vector<size_t> path;
  return FindIdentityInObjects(&page->objects, id, text_id, &path, result);
}

bool IdentityContainsId(const ObjectIdentity& identity, std::string_view id) {
  if (identity.id == id || identity.text_block_id == id) {
    return true;
  }
  return std::any_of(identity.children.begin(), identity.children.end(),
                     [id](const ObjectIdentity& child) {
                       return IdentityContainsId(child, id);
                     });
}

bool MetadataContainsId(const CandidateMetadata& metadata,
                        std::string_view id) {
  for (const PageIdentity& page : metadata.pages) {
    if (page.id == id) {
      return true;
    }
    if (std::any_of(page.objects.begin(), page.objects.end(),
                    [id](const ObjectIdentity& object) {
                      return IdentityContainsId(object, id);
                    })) {
      return true;
    }
  }
  return false;
}

bool IdentityTreeHasCollision(const ObjectIdentity& identity,
                              const CandidateMetadata& metadata,
                              std::set<std::string>* local_ids) {
  if ((!identity.id.empty() && (!local_ids->insert(identity.id).second ||
                                MetadataContainsId(metadata, identity.id))) ||
      (!identity.text_block_id.empty() &&
       (!local_ids->insert(identity.text_block_id).second ||
        MetadataContainsId(metadata, identity.text_block_id)))) {
    return true;
  }
  return std::any_of(identity.children.begin(), identity.children.end(),
                     [&](const ObjectIdentity& child) {
                       return IdentityTreeHasCollision(child, metadata,
                                                       local_ids);
                     });
}

FPDF_PAGEOBJECT ObjectAtPath(FPDF_PAGE page, const std::vector<size_t>& path) {
  if (path.empty() ||
      path[0] > static_cast<size_t>(std::numeric_limits<int>::max())) {
    return nullptr;
  }
  FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, static_cast<int>(path[0]));
  for (size_t depth = 1; object && depth < path.size(); ++depth) {
    if (path[depth] > std::numeric_limits<unsigned long>::max()) {
      return nullptr;
    }
    object =
        FPDFFormObj_GetObject(object, static_cast<unsigned long>(path[depth]));
  }
  return object;
}

// The Form stream can be isolated, but rewriting tagged/marked content would
// also require updating the document's structure tree and marked-content scopes.
template <typename Index>
bool NestedFormPathIsStructurallyEditable(FPDF_PAGE page,
                                      FPDF_PAGEOBJECT leaf,
                                      const std::vector<Index>& path) {
  if (!page || !leaf || path.size() < 2 || FPDFPageObj_CountMarks(leaf) != 0)
    return false;
  const auto* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page || native_page->GetDict()->KeyExist("StructParents") ||
      native_page->GetDict()->KeyExist("StructParent") ||
      native_page->GetDocument()->GetRoot()->KeyExist("StructTreeRoot"))
    return false;
  FPDF_PAGEOBJECT ancestor = FPDFPage_GetObject(page, static_cast<int>(path[0]));
  for (size_t depth = 1; depth < path.size(); ++depth) {
    const auto* native = CPDFPageObjectFromFPDFPageObject(ancestor);
    const auto* form = native ? native->AsForm() : nullptr;
    if (!form || FPDFPageObj_CountMarks(ancestor) != 0 ||
        form->form()->GetDict()->KeyExist("StructParents") ||
        form->form()->GetDict()->KeyExist("StructParent"))
      return false;
    if (depth + 1 < path.size())
      ancestor = FPDFFormObj_GetObject(ancestor, static_cast<unsigned long>(path[depth]));
  }
  return true;
}

struct EnumerationContext {
  std::string page_id;
  std::string source_id;
  FPDF_TEXTPAGE text_page;
  FPDF_PAGE page;
  Matrix pdf_to_page;
  std::vector<ObjectData>* objects;
  std::vector<TextBlockData>* text_blocks;
};

void EnumerateObject(FPDF_PAGEOBJECT object,
                     const ObjectIdentity& identity,
                     const Matrix& parent_to_pdf,
                     std::vector<uint32_t> path,
                     size_t depth,
                     EnumerationContext* context) {
  if (depth > kMaxObjectDepth) {
    throw std::runtime_error("PDF object nesting is too deep");
  }
  if (!IsActiveObject(object)) {
    return;
  }
  if (identity.id.empty()) {
    throw std::runtime_error("PDF object identity is unavailable");
  }

  ObjectData data;
  data.id = identity.id;
  data.page_id = context->page_id;
  const int type = FPDFPageObj_GetType(object);
  data.type = type == FPDF_PAGEOBJ_FORM && GroupMetadata(object)
                  ? "group" : ObjectTypeName(type);
  data.object_index = path.back();
  data.container_path.assign(path.begin(), path.end() - 1);

  FS_MATRIX object_matrix_value{};
  const Matrix object_matrix =
      FPDFPageObj_GetMatrix(object, &object_matrix_value)
          ? MatrixFromFs(object_matrix_value)
          : Matrix{};
  const Matrix object_to_page =
      object_matrix.Then(parent_to_pdf).Then(context->pdf_to_page);
  data.transform = object_to_page;

  float left = 0;
  float bottom = 0;
  float right = 0;
  float top = 0;
  if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) {
    throw std::runtime_error("PDF object bounds are unavailable");
  }
  data.bounds = TransformBounds(left, bottom, right, top,
                                parent_to_pdf.Then(context->pdf_to_page));

  const auto paragraph = ParagraphMetadata(object);
  if (paragraph) {
    data.type = "text";
    data.bounds = TransformBounds(0, 0, paragraph->GetFloatFor("Width"),
                                  paragraph->GetFloatFor("Height"), object_to_page);
    TextBlockData block;
    block.id = identity.text_block_id; block.page_id = context->page_id;
    block.source_id = context->source_id; block.object_id = data.id;
    const ByteString utf8 = paragraph->GetUnicodeTextFor("Text").ToUTF8();
    block.text.assign(utf8.c_str(), utf8.GetLength());
    block.bounds = data.bounds; block.transform = data.transform;
    block.is_paragraph = true;
    const ByteString base_id = paragraph->GetUnicodeTextFor("RegisteredFontId").ToUTF8();
    if (!base_id.IsEmpty()) block.style.font_id =
        std::string(base_id.c_str(), base_id.GetLength());
    block.style.font_size = paragraph->GetFloatFor("FontSize");
    block.style.character_spacing = paragraph->GetFloatFor("LetterSpacing");
    if (paragraph->GetBooleanFor("Underline", false)) block.style.underline = true;
    const auto color = paragraph->GetArrayFor("Color");
    if (color && color->size() == 3)
      block.style.color = std::array<double, 3>{color->GetFloatAt(0), color->GetFloatAt(1), color->GetFloatAt(2)};
    if (const auto style_runs = paragraph->GetArrayFor("StyleRuns")) {
      LayoutText decoded;
      uint32_t next = 0;
      bool valid = DecodeLayoutText(block.text, &decoded);
      for (size_t index = 0; valid && index < style_runs->size(); ++index) {
        const auto entry = style_runs->GetDictAt(index);
        if (!entry) { valid = false; break; }
        const int first = entry->GetIntegerFor("Start");
        const int last = entry->GetIntegerFor("End");
        if (first < 0 || last <= first || static_cast<uint32_t>(first) != next ||
            static_cast<size_t>(last) >= decoded.byte_offsets.size() ||
            decoded.byte_offsets[first] == std::numeric_limits<size_t>::max() ||
            decoded.byte_offsets[last] == std::numeric_limits<size_t>::max()) {
          valid = false; break;
        }
        StyledRunData run;
        run.text = block.text.substr(decoded.byte_offsets[first],
                                     decoded.byte_offsets[last] - decoded.byte_offsets[first]);
        run.style.font_size = entry->GetFloatFor("FontSize");
        run.style.character_spacing = entry->GetFloatFor("LetterSpacing");
        run.style.underline = entry->GetBooleanFor("Underline", false);
        const ByteString font_id = entry->GetUnicodeTextFor("RegisteredFontId").ToUTF8();
        if (!font_id.IsEmpty()) run.style.font_id =
            std::string(font_id.c_str(), font_id.GetLength());
        const auto rgb = entry->GetArrayFor("Color");
        if (rgb && rgb->size() == 3) run.style.color = std::array<double, 3>{
            rgb->GetFloatAt(0), rgb->GetFloatAt(1), rgb->GetFloatAt(2)};
        block.runs.push_back(std::move(run));
        next = static_cast<uint32_t>(last);
      }
      if (!valid || next != decoded.utf16.size()) {
        block.runs.clear();
        block.editability = "geometry-only";
      }
    }
    if (depth > 0) block.editability = "geometry-only";
    data.text_block = block;
    context->text_blocks->push_back(std::move(block));
  } else if (type == FPDF_PAGEOBJ_TEXT) {
    std::string text = GetTextForObject(object, context->text_page);
    if (!text.empty()) {
      if (identity.text_block_id.empty()) {
        throw std::runtime_error("PDF text identity is unavailable");
      }
      TextBlockData block;
      block.id = identity.text_block_id;
      block.page_id = context->page_id;
      block.source_id = context->source_id;
      block.object_id = data.id;
      block.text = std::move(text);
      block.style = GetTextStyle(object);
      block.bounds = data.bounds;
      block.transform = data.transform;
      block.is_ocr = IsOcrTextObject(object);
      if ((depth > 0 && !NestedFormPathIsStructurallyEditable(context->page, object, path)) ||
          (depth == 0 && !HasSupportedTextMarks(object))) {
        block.editability = "geometry-only";
      }
      data.text_block = block;
      context->text_blocks->push_back(std::move(block));
    }
  }

  context->objects->push_back(std::move(data));

  if (paragraph || type != FPDF_PAGEOBJ_FORM) {
    return;
  }
  const int child_count = FPDFFormObj_CountObjects(object);
  if (child_count < 0 ||
      identity.children.size() != static_cast<size_t>(child_count)) {
    throw std::runtime_error("PDF form identity is out of sync");
  }
  const Matrix form_to_pdf = object_matrix.Then(parent_to_pdf);
  for (int child_index = 0; child_index < child_count; ++child_index) {
    FPDF_PAGEOBJECT child =
        FPDFFormObj_GetObject(object, static_cast<unsigned long>(child_index));
    if (!child) {
      throw std::runtime_error("PDF form child is unavailable");
    }
    std::vector<uint32_t> child_path = path;
    child_path.push_back(static_cast<uint32_t>(child_index));
    EnumerateObject(child, identity.children[static_cast<size_t>(child_index)],
                    form_to_pdf, std::move(child_path), depth + 1, context);
  }
}

bool BuildPageData(Document* document, uint32_t page_index, PageData* result) {
  if (page_index > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      page_index >= document->metadata.pages.size() ||
      page_index >= static_cast<uint32_t>(FPDF_GetPageCount(document->pdf))) {
    SetError("INVALID_REQUEST", "The page index is out of range.");
    return false;
  }

  ScopedPage page(FPDF_LoadPage(document->pdf, static_cast<int>(page_index)));
  if (!page.get()) {
    SetError("CORE_UNAVAILABLE", "The PDF page could not be loaded.");
    return false;
  }
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page.get());
  if (!native_page) {
    SetUnexpectedError();
    return false;
  }

  const double user_unit = GetUserUnit(native_page);
  const Matrix unit_scale{user_unit, 0, 0, user_unit, 0, 0};
  const Matrix pdf_to_page =
      MatrixFromCfx(native_page->GetDisplayMatrix()).Then(unit_scale);

  const PageIdentity& page_identity = document->metadata.pages[page_index];
  result->id = page_identity.id;
  result->width_pt = native_page->GetPageWidth() * user_unit;
  result->height_pt = native_page->GetPageHeight() * user_unit;
  result->rotation = native_page->GetPageRotation() * 90;
  if (!std::isfinite(result->width_pt) || !std::isfinite(result->height_pt) ||
      result->width_pt <= 0 || result->height_pt <= 0) {
    SetError("CORE_UNAVAILABLE", "The PDF page has invalid geometry.");
    return false;
  }

  ScopedTextPage text_page(FPDFText_LoadPage(page.get()));
  if (!text_page.get()) {
    SetError("CORE_UNAVAILABLE", "The PDF text layer could not be loaded.");
    return false;
  }

  const int object_count = FPDFPage_CountObjects(page.get());
  if (object_count < 0 ||
      page_identity.objects.size() != static_cast<size_t>(object_count)) {
    SetError("CORE_UNAVAILABLE",
             "The page object identity map is out of sync.");
    return false;
  }
  EnumerationContext context{result->id,       document->source_id,
                             text_page.get(),  page.get(), pdf_to_page,
                             &result->objects, &result->text_blocks};
  for (int object_index = 0; object_index < object_count; ++object_index) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page.get(), object_index);
    if (!object) {
      SetUnexpectedError();
      return false;
    }
    EnumerateObject(
        object, page_identity.objects[static_cast<size_t>(object_index)],
        Matrix{}, {static_cast<uint32_t>(object_index)}, 0, &context);
  }
  return true;
}

void AppendMatrix(std::string* output, const Matrix& matrix) {
  output->push_back('[');
  AppendJsonNumber(output, matrix.a);
  output->push_back(',');
  AppendJsonNumber(output, matrix.b);
  output->push_back(',');
  AppendJsonNumber(output, matrix.c);
  output->push_back(',');
  AppendJsonNumber(output, matrix.d);
  output->push_back(',');
  AppendJsonNumber(output, matrix.e);
  output->push_back(',');
  AppendJsonNumber(output, matrix.f);
  output->push_back(']');
}

void AppendRect(std::string* output, const Rect& rect) {
  output->append("{\"x\":");
  AppendJsonNumber(output, rect.x);
  output->append(",\"y\":");
  AppendJsonNumber(output, rect.y);
  output->append(",\"width\":");
  AppendJsonNumber(output, rect.width);
  output->append(",\"height\":");
  AppendJsonNumber(output, rect.height);
  output->push_back('}');
}

void AppendTextStyle(std::string* output, const TextStyleData& style) {
  output->push_back('{');
  bool has_property = false;
  const auto property = [&]() {
    if (has_property) {
      output->push_back(',');
    }
    has_property = true;
  };
  if (style.font_id) {
    property();
    output->append("\"fontId\":");
    AppendJsonString(output, *style.font_id);
  }
  if (style.font_size) {
    property();
    output->append("\"fontSize\":");
    AppendJsonNumber(output, *style.font_size);
  }
  if (style.color) {
    property();
    output->append("\"color\":[");
    AppendJsonNumber(output, (*style.color)[0]);
    output->push_back(',');
    AppendJsonNumber(output, (*style.color)[1]);
    output->push_back(',');
    AppendJsonNumber(output, (*style.color)[2]);
    output->push_back(']');
  }
  if (style.character_spacing) {
    property();
    output->append("\"characterSpacing\":");
    AppendJsonNumber(output, *style.character_spacing);
  }
  if (style.weight) {
    property();
    output->append("\"weight\":");
    AppendJsonSigned(output, *style.weight);
  }
  if (style.italic) {
    property();
    output->append("\"italic\":");
    output->append(*style.italic ? "true" : "false");
  }
  if (style.underline) {
    property();
    output->append("\"underline\":");
    output->append(*style.underline ? "true" : "false");
  }
  output->push_back('}');
}

void AppendTextBlock(std::string* output, const TextBlockData& block) {
  output->append("{\"id\":");
  AppendJsonString(output, block.id);
  output->append(",\"pageId\":");
  AppendJsonString(output, block.page_id);
  output->append(",\"sourceId\":");
  AppendJsonString(output, block.source_id);
  output->append(",\"sourceObjectIds\":[");
  AppendJsonString(output, block.object_id);
  output->append("],\"runs\":[");
  const auto append_run = [&](std::string_view text, const TextStyleData& style) {
    output->append("{\"text\":");
    AppendJsonString(output, text);
    output->append(",\"style\":");
    AppendTextStyle(output, style);
    output->append(",\"sourceObjectIds\":[");
    AppendJsonString(output, block.object_id);
    output->append("]}");
  };
  if (block.runs.empty()) {
    append_run(block.text, block.style);
  } else {
    for (size_t index = 0; index < block.runs.size(); ++index) {
      if (index) output->push_back(',');
      append_run(block.runs[index].text, block.runs[index].style);
    }
  }
  output->append("],\"bounds\":");
  AppendRect(output, block.bounds);
  output->append(",\"transform\":");
  AppendMatrix(output, block.transform);
  output->append(",\"editability\":");
  AppendJsonString(output, block.editability);
  if (block.is_ocr) output->append(",\"isOcr\":true");
  if (block.is_paragraph) output->append(",\"isParagraph\":true");
  output->push_back('}');
}

void AppendObject(std::string* output, const ObjectData& object) {
  output->append("{\"id\":");
  AppendJsonString(output, object.id);
  output->append(",\"pageId\":");
  AppendJsonString(output, object.page_id);
  output->append(",\"type\":");
  AppendJsonString(output, object.type);
  output->append(",\"bounds\":");
  AppendRect(output, object.bounds);
  output->append(",\"transform\":");
  AppendMatrix(output, object.transform);
  output->append(",\"locator\":{\"pageId\":");
  AppendJsonString(output, object.page_id);
  output->append(",\"containerPath\":[");
  for (size_t index = 0; index < object.container_path.size(); ++index) {
    if (index) {
      output->push_back(',');
    }
    AppendJsonUnsigned(output, object.container_path[index]);
  }
  output->append("],\"objectIndex\":");
  AppendJsonUnsigned(output, object.object_index);
  output->push_back('}');
  if (object.text_block) {
    output->append(",\"textBlock\":");
    AppendTextBlock(output, *object.text_block);
  }
  output->push_back('}');
}

bool HasSignedSignature(FPDF_DOCUMENT document) {
  const int count = FPDF_GetSignatureCount(document);
  for (int index = 0; index < count; ++index) {
    const FPDF_SIGNATURE signature = FPDF_GetSignatureObject(document, index);
    const unsigned long byte_range_length =
        FPDFSignatureObj_GetByteRange(signature, nullptr, 0);
    if (signature && FPDFSignatureObj_GetContents(signature, nullptr, 0) > 0 &&
        byte_range_length >= 4 && byte_range_length % 2 == 0) {
      return true;
    }
  }
  return false;
}

std::string SerializeDocumentInfo(const Document& document) {
  std::string output;
  output.append("{\"id\":");
  AppendJsonString(&output, document.document_id);
  output.append(",\"revision\":");
  AppendJsonUnsigned(&output, document.revision);
  output.append(",\"savedRevision\":");
  AppendJsonUnsigned(&output, document.saved_revision);
  output.append(",\"pageOrder\":[");
  for (size_t index = 0; index < document.metadata.pages.size(); ++index) {
    if (index) {
      output.push_back(',');
    }
    AppendJsonString(&output, document.metadata.pages[index].id);
  }
  output.append("],\"sourceIds\":[");
  AppendJsonString(&output, document.source_id);
  output.append("],\"sourceBytes\":");
  AppendJsonUnsigned(&output, static_cast<uint64_t>(document.source_size));
  output.append(",\"permissions\":{");

  const unsigned long permissions = FPDF_GetDocPermissions(document.pdf);
  const auto allowed = [permissions](unsigned long bit) {
    return permissions == 0xffffffffUL || (permissions & bit) != 0;
  };
  output.append("\"modify\":");
  output.append(allowed(1UL << 3) ? "true" : "false");
  output.append(",\"copy\":");
  output.append(allowed(1UL << 4) ? "true" : "false");
  output.append(",\"annotate\":");
  output.append(allowed(1UL << 5) ? "true" : "false");
  output.append(",\"fillForms\":");
  output.append(allowed(1UL << 8) ? "true" : "false");
  output.append(",\"print\":");
  output.append(allowed(1UL << 2) ? "true" : "false");
  output.append(",\"encrypted\":");
  output.append(FPDF_GetSecurityHandlerRevision(document.pdf) >= 0 ? "true"
                                                                   : "false");
  output.append(",\"signed\":");
  output.append(HasSignedSignature(document.pdf) ? "true" : "false");
  output.append("},\"capabilities\":");
  if (document.editing_allowed) {
    output.append(kCapabilitiesJson.data(), kCapabilitiesJson.size());
  } else {
    output.push_back('[');
    if (!HasSignedSignature(document.pdf)) {
      const bool annotate = allowed(1UL << 5);
      const bool fill = allowed(1UL << 8);
      if (annotate) output.append("\"annotation.add\",\"annotation.update\",\"annotation.delete\"");
      if (annotate && fill) output.push_back(',');
      if (fill) output.append("\"form.fill\"");
    }
    output.push_back(']');
  }
  output.push_back('}');
  return output;
}

std::string SerializePage(const PageData& page) {
  std::string output;
  output.append("{\"id\":");
  AppendJsonString(&output, page.id);
  output.append(",\"widthPt\":");
  AppendJsonNumber(&output, page.width_pt);
  output.append(",\"heightPt\":");
  AppendJsonNumber(&output, page.height_pt);
  output.append(",\"rotation\":");
  AppendJsonSigned(&output, page.rotation);
  output.append(",\"objects\":[");
  for (size_t index = 0; index < page.objects.size(); ++index) {
    if (index) {
      output.push_back(',');
    }
    AppendObject(&output, page.objects[index]);
  }
  output.append("]}");
  return output;
}

std::string SerializeTextBlocks(const std::vector<TextBlockData>& blocks) {
  std::string output;
  output.push_back('[');
  for (size_t index = 0; index < blocks.size(); ++index) {
    if (index) {
      output.push_back(',');
    }
    AppendTextBlock(&output, blocks[index]);
  }
  output.push_back(']');
  return output;
}

bool ReadFileSource(Document* document,
                    int64_t offset,
                    uint8_t* destination,
                    size_t length) {
  size_t copied = 0;
  while (copied < length) {
    const size_t read = document->file_source->ReadPos(
        pdfium::span<uint8_t>(destination + copied, length - copied),
        offset + static_cast<int64_t>(copied));
    if (read == 0 || read > length - copied) {
      return false;
    }
    copied += read;
  }
  return true;
}

bool CopySourceToMemory(Document* document) {
  if (!document->file_source) {
    g_binary = document->memory_source;
    return true;
  }
  if (document->source_size < 0 ||
      static_cast<uint64_t>(document->source_size) >
          std::numeric_limits<uint32_t>::max()) {
    SetError("RESOURCE_LIMIT",
             "The source is too large for an in-memory save.");
    return false;
  }
  g_binary.resize(static_cast<size_t>(document->source_size));
  if (!g_binary.empty() &&
      !ReadFileSource(document, 0, g_binary.data(), g_binary.size())) {
    SetError("SAVE_FAILED", "The immutable source could not be read.");
    return false;
  }
  return true;
}

class DestinationFile {
 public:
  ~DestinationFile() {
    Close();
    // Open uses CREATE_NEW / "wbx". Only the file this call created may be
    // removed; a pre-existing destination is never touched on failure.
    if (!finished_ && !created_path_.empty()) {
#if defined(_WIN32)
      DeleteFileW(created_path_.c_str());
#else
      std::remove(created_path_.c_str());
#endif
    }
  }

  bool Open(std::string_view path) {
#if defined(_WIN32)
    std::wstring wide_path = pdf_editor::NativeWidePath(path);
    if (wide_path.empty()) return false;
    handle_ = CreateFileW(wide_path.c_str(), GENERIC_WRITE, 0, nullptr,
                          CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle_ == INVALID_HANDLE_VALUE) return false;
    created_path_.swap(wide_path);
    return true;
#else
    std::string file_path(path);
    file_ = std::fopen(file_path.c_str(), "wbx");
    if (!file_) return false;
    created_path_.swap(file_path);
    return true;
#endif
  }

  bool Write(const uint8_t* data, size_t length) {
#if defined(_WIN32)
    size_t written_total = 0;
    while (written_total < length) {
      const DWORD request = static_cast<DWORD>(std::min<size_t>(
          length - written_total, std::numeric_limits<DWORD>::max()));
      DWORD written = 0;
      if (!WriteFile(handle_, data + written_total, request, &written,
                     nullptr) ||
          written == 0) {
        return false;
      }
      written_total += written;
    }
    return true;
#else
    size_t written_total = 0;
    while (written_total < length) {
      const size_t written =
          std::fwrite(data + written_total, 1, length - written_total, file_);
      if (written == 0) {
        return false;
      }
      written_total += written;
    }
    return true;
#endif
  }

  bool Finish() {
#if defined(_WIN32)
    if (handle_ == INVALID_HANDLE_VALUE) return false;
    const bool flushed = FlushFileBuffers(handle_) != 0;
    const bool closed = CloseHandle(handle_) != 0;
    handle_ = INVALID_HANDLE_VALUE;
    finished_ = flushed && closed;
#else
    if (!file_) return false;
    finished_ = std::fclose(file_) == 0;
    file_ = nullptr;
#endif
    return finished_;
  }

 private:
  void Close() {
#if defined(_WIN32)
    if (handle_ != INVALID_HANDLE_VALUE) {
      CloseHandle(handle_);
      handle_ = INVALID_HANDLE_VALUE;
    }
#else
    if (file_) {
      std::fclose(file_);
      file_ = nullptr;
    }
#endif
  }

#if defined(_WIN32)
  HANDLE handle_ = INVALID_HANDLE_VALUE;
  std::wstring created_path_;
#else
  std::FILE* file_ = nullptr;
  std::string created_path_;
#endif
  bool finished_ = false;
};

bool CopySourceToFile(Document* document, std::string_view destination) {
  DestinationFile output;
  if (!output.Open(destination)) {
    SetError("SAVE_FAILED", "The destination file could not be opened.");
    return false;
  }

  if (!document->file_source) {
    if (!document->memory_source.empty() &&
        !output.Write(document->memory_source.data(),
                      document->memory_source.size())) {
      SetError("SAVE_FAILED", "The immutable source could not be written.");
      return false;
    }
  } else {
    std::vector<uint8_t> chunk(kCopyChunkSize);
    int64_t offset = 0;
    while (offset < document->source_size) {
      const size_t length = static_cast<size_t>(std::min<int64_t>(
          document->source_size - offset, static_cast<int64_t>(chunk.size())));
      if (!ReadFileSource(document, offset, chunk.data(), length) ||
          !output.Write(chunk.data(), length)) {
        SetError("SAVE_FAILED", "The immutable source could not be copied.");
        return false;
      }
      offset += static_cast<int64_t>(length);
    }
  }

  if (!output.Finish()) {
    SetError("SAVE_FAILED", "The destination file could not be finalized.");
    return false;
  }
  return true;
}

bool ValidateFontWithPdfium(const pdf_editor::PreparedFontFace& face) {
  ScopedDocument document(FPDF_CreateNewDocument());
  if (!document.get()) {
    SetUnexpectedError();
    return false;
  }
  std::string message;
  FPDF_FONT font =
      pdf_editor::LoadFontFace(document.get(), face.info, face.sfnt, &message);
  if (!font) {
    SetError("INVALID_REQUEST", std::move(message));
    return false;
  }
  FPDFFont_Close(font);
  return true;
}

std::shared_ptr<const FontResource> RegisterFontResource(
    const char* font_id,
    const uint8_t* bytes,
    uint32_t length,
    uint32_t face_index,
    bool legacy_truetype_only) {
  if (!RequireInitialized() || !ValidateId(font_id, "Font ID")) {
    return nullptr;
  }
  if (!bytes || length == 0 || length > kMaxFontBytes) {
    SetError("INVALID_REQUEST", "Font bytes are required.");
    return nullptr;
  }

  if (legacy_truetype_only &&
      (length < 4 || bytes[0] != 0 || bytes[1] != 1 || bytes[2] != 0 ||
       bytes[3] != 0 || face_index != 0)) {
    SetError("INVALID_REQUEST",
             "The legacy API accepts a standalone TrueType font only.");
    return nullptr;
  }

  const auto existing = g_fonts.find(font_id);
  if (existing != g_fonts.end()) {
    if (existing->second->face.index == face_index &&
        existing->second->original_bytes.size() == length &&
        std::equal(existing->second->original_bytes.begin(),
                   existing->second->original_bytes.end(), bytes)) {
      return existing->second;
    }
    SetError("INVALID_REQUEST",
             "The font ID is already registered with "
             "different bytes or a different face.");
    return nullptr;
  }

  pdf_editor::PreparedFontFace prepared;
  std::string error_code;
  std::string error_message;
  if (!pdf_editor::PrepareFontFace(std::span<const uint8_t>(bytes, length),
                                   face_index, &prepared, &error_code,
                                   &error_message)) {
    SetError(std::move(error_code), std::move(error_message));
    return nullptr;
  }
  if (legacy_truetype_only &&
      prepared.info.format != pdf_editor::FontFormat::kTrueType) {
    SetError("INVALID_REQUEST",
             "The legacy API accepts a standalone TrueType font only.");
    return nullptr;
  }
  if (!prepared.info.editable_embedding) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The font license does not allow editable outline embedding.");
    return nullptr;
  }
  if (!ValidateFontWithPdfium(prepared)) {
    return nullptr;
  }

  auto resource = std::make_shared<FontResource>();
  resource->id = font_id;
  resource->original_bytes.assign(bytes, bytes + length);
  resource->face = prepared.info;
  if (prepared.sfnt.size() != length ||
      !std::equal(prepared.sfnt.begin(), prepared.sfnt.end(), bytes)) {
    resource->extracted_sfnt = std::move(prepared.sfnt);
  }
  g_fonts.emplace(resource->id, resource);
  return resource;
}

bool EditingIsAllowed(FPDF_DOCUMENT pdf) {
  const unsigned long permissions = FPDF_GetDocPermissions(pdf);
  const bool can_modify =
      permissions == 0xffffffffUL || (permissions & (1UL << 3)) != 0;
  return can_modify && !HasSignedSignature(pdf);
}

bool EnsureImmutableSourceBytes(Document* document) {
  if (!document->memory_source.empty()) {
    return true;
  }
  if (!document->file_source || document->source_size <= 0 ||
      static_cast<uint64_t>(document->source_size) >
          std::numeric_limits<uint32_t>::max()) {
    SetError("RESOURCE_LIMIT",
             "The native source is too large for transactional editing.");
    return false;
  }
  document->memory_source.resize(static_cast<size_t>(document->source_size));
  if (!ReadFileSource(document, 0, document->memory_source.data(),
                      document->memory_source.size())) {
    document->memory_source.clear();
    SetError("CORE_UNAVAILABLE", "The immutable PDF source could not be read.");
    return false;
  }
  return true;
}

struct ObjectTarget {
  FPDF_PAGEOBJECT object = nullptr;
  ObjectIdentity* identity = nullptr;
  std::vector<size_t> path;
};

bool FindObjectTarget(FPDF_PAGE page,
                      PageIdentity* page_identity,
                      std::string_view id,
                      bool text_id,
                      ObjectTarget* target) {
  IdentityLocation location;
  if (!FindIdentity(page_identity, id, text_id, &location)) {
    SetError("INVALID_REQUEST",
             text_id ? "The text block does not exist on this page."
                     : "The page object does not exist on this page.");
    return false;
  }
  FPDF_PAGEOBJECT object = ObjectAtPath(page, location.path);
  if (!object) {
    SetError("CORE_UNAVAILABLE",
             "The page object identity map is out of sync.");
    return false;
  }
  target->object = object;
  target->identity = location.identity;
  target->path = std::move(location.path);
  return true;
}

bool PrepareObjectHolder(
    FPDF_PAGE page,
    const std::vector<size_t>& object_path,
    CPDF_PageObjectHolder** holder,
    std::optional<pdf_editor::PreparedFormPath>* prepared_path) {
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page || object_path.empty()) {
    SetUnexpectedError();
    return false;
  }
  if (object_path.size() == 1) {
    *holder = native_page;
    prepared_path->reset();
    return true;
  }
  if (!NestedFormPathIsStructurallyEditable(
          page, ObjectAtPath(page, object_path), object_path)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Nested marked/tagged Form objects cannot be rewritten safely.");
    return false;
  }
  auto prepared = pdf_editor::PrepareFormPath(
      native_page,
      std::span<const size_t>(object_path.data(), object_path.size() - 1));
  if (!prepared || prepared->ancestors.empty()) {
    SetError("CORE_UNAVAILABLE", "The nested Form object path is invalid.");
    return false;
  }
  *holder = prepared->ancestors.back()->form();
  *prepared_path = std::move(prepared);
  return true;
}

bool GenerateEditedObjectHolder(
    FPDF_PAGE page,
    const std::optional<pdf_editor::PreparedFormPath>& prepared_path,
    const char* failure_message) {
  if (prepared_path) {
    pdf_editor::GeneratePreparedFormPath(*prepared_path);
    return true;
  }
  if (!FPDFPage_GenerateContent(page)) {
    SetError("CORE_UNAVAILABLE", failure_message);
    return false;
  }
  return true;
}

bool GetNormalizedObjectBounds(FPDF_PAGE page,
                               FPDF_PAGEOBJECT object,
                               Rect* bounds,
                               const Matrix& parent_to_pdf = Matrix{}) {
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page) {
    SetUnexpectedError();
    return false;
  }
  const double user_unit = GetUserUnit(native_page);
  const Matrix unit_scale{user_unit, 0, 0, user_unit, 0, 0};
  const Matrix pdf_to_page =
      MatrixFromCfx(native_page->GetDisplayMatrix()).Then(unit_scale);
  float left = 0;
  float bottom = 0;
  float right = 0;
  float top = 0;
  if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) {
    SetUnexpectedError();
    return false;
  }
  *bounds = TransformBounds(left, bottom, right, top,
                            parent_to_pdf.Then(pdf_to_page));
  return true;
}

bool GetSupportedActualTextMark(FPDF_PAGEOBJECT object,
                                FPDF_PAGEOBJECTMARK* actual_text_mark) {
  *actual_text_mark = nullptr;
  const int mark_count = FPDFPageObj_CountMarks(object);
  if (mark_count < 0) {
    SetUnexpectedError();
    return false;
  }
  if (mark_count == 0) {
    return true;
  }
  if (mark_count != 1) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Text with multiple marked-content scopes cannot be edited yet.");
    return false;
  }

  FPDF_PAGEOBJECTMARK mark = FPDFPageObj_GetMark(object, 0);
  CPDF_ContentMarkItem* item = CPDFContentMarkItemFromFPDFPageObjectMark(mark);
  if (!item || item->GetParamType() != CPDF_ContentMarkItem::kDirectDict) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Only a direct single ActualText mark is supported.");
    return false;
  }
  RetainPtr<const CPDF_Dictionary> params = item->GetParam();
  if (!params || params->size() != 1 || !params->KeyExist("ActualText")) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Only a direct single ActualText mark is supported.");
    return false;
  }
  *actual_text_mark = mark;
  return true;
}

bool SetActualText(FPDF_PAGEOBJECT object,
                   FPDF_PAGEOBJECTMARK mark,
                   std::string_view replacement) {
  if (!mark) {
    return true;
  }
  CPDF_ContentMarkItem* item = CPDFContentMarkItemFromFPDFPageObjectMark(mark);
  RetainPtr<CPDF_Dictionary> params = item ? item->GetParam() : nullptr;
  CPDF_PageObject* native_object = CPDFPageObjectFromFPDFPageObject(object);
  if (!params || !native_object) {
    SetUnexpectedError();
    return false;
  }
  const WideString wide = WideString::FromUTF8(
      ByteStringView(replacement.data(), replacement.size()));
  params->SetNewFor<CPDF_String>("ActualText", wide.AsStringView());
  native_object->SetDirty(true);
  return true;
}

bool GetNormalizedTextLayoutFrame(FPDF_PAGE page,
                                  FPDF_PAGEOBJECT object,
                                  Rect* frame,
                                  const Matrix& parent_to_pdf = Matrix{}) {
  auto* native_page = CPDFPageFromFPDFPage(page);
  auto* native_object = CPDFPageObjectFromFPDFPageObject(object);
  auto* text = native_object ? native_object->AsText() : nullptr;
  if (!native_page || !text)
    return false;
  const FPDF_FONT font = FPDFTextObj_GetFont(object);
  float ascent = 0;
  float descent = 0;
  if (!font || !FPDFFont_GetAscent(font, text->GetFontSize(), &ascent) ||
      !FPDFFont_GetDescent(font, text->GetFontSize(), &descent)) {
    return GetNormalizedObjectBounds(page, object, frame, parent_to_pdf);
  }
  const auto& positions = text->GetCharPositions();
  const auto& codes = text->GetCharCodes();
  const double advance =
      positions.empty() || codes.empty()
          ? 0
          : positions.back() + text->GetCharWidth(codes.back());
  const double user_unit = GetUserUnit(native_page);
  const Matrix unit_scale{user_unit, 0, 0, user_unit, 0, 0};
  const Matrix matrix =
      MatrixFromCfx(text->GetTextMatrix())
          .Then(parent_to_pdf)
          .Then(MatrixFromCfx(native_page->GetDisplayMatrix()))
          .Then(unit_scale);
  // Ink bearings vary per glyph. Layout uses baseline/advance and font metrics,
  // so replacing H with E does not overflow merely because E's ink starts
  // earlier.
  *frame =
      TransformBounds(std::min(0.0, advance), std::min(0.0f, descent),
                      std::max(0.0, advance), std::max(0.0f, ascent), matrix);
  return true;
}

bool FontCanEncode(CPDF_Font* font, std::string_view text) {
  std::vector<uint32_t> code_points;
  if (!font || !DecodeUtf8(text, &code_points)) {
    return false;
  }
  for (uint32_t code_point : code_points) {
    if (code_point > 0xffff) {
      return false;
    }
    const wchar_t unicode = static_cast<wchar_t>(code_point);
    const uint32_t char_code = font->CharCodeFromUnicode(unicode);
    if (char_code == CPDF_Font::kInvalidCharCode ||
        (char_code == 0 && code_point != 0)) {
      return false;
    }
    const WideString round_trip = font->UnicodeFromCharCode(char_code);
    if (round_trip.GetLength() != 1 || round_trip.Front() != unicode) {
      return false;
    }
  }
  return true;
}

class CandidateFontCache {
 public:
  explicit CandidateFontCache(FPDF_DOCUMENT document) : document_(document) {}
  ~CandidateFontCache() {
    for (FPDF_FONT font : handles_) {
      FPDFFont_Close(font);
    }
  }

  FPDF_FONT LoadHandle(const std::shared_ptr<const FontResource>& resource) {
    const auto found = fonts_.find(resource->id);
    if (found != fonts_.end()) {
      return found->second;
    }
    std::string message;
    FPDF_FONT handle = pdf_editor::LoadFontFace(
        document_, resource->face, resource->SfntBytes(), &message);
    if (!handle) {
      SetError("CORE_UNAVAILABLE", std::move(message));
      return nullptr;
    }
    handles_.push_back(handle);
    fonts_.emplace(resource->id, handle);
    return handle;
  }

  CPDF_Font* Load(const std::shared_ptr<const FontResource>& resource) {
    FPDF_FONT handle = LoadHandle(resource);
    return handle ? CPDFFontFromFPDFFont(handle) : nullptr;
  }

 private:
  FPDF_DOCUMENT document_;
  std::vector<FPDF_FONT> handles_;
  std::map<std::string, FPDF_FONT> fonts_;
};

bool ValidateSingleLineText(std::string_view text, const char* label) {
  if (text.size() > kMaxTextBytes) {
    SetError("RESOURCE_LIMIT", std::string(label) + " is too large.");
    return false;
  }
  if (!IsValidUtf8(text)) {
    SetError("INVALID_REQUEST", std::string(label) + " must be valid UTF-8.");
    return false;
  }
  if (ContainsUnsupportedLineBreak(text)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Multiline text layout is not supported by this command batch.");
    return false;
  }
  std::vector<uint32_t> code_points;
  if (!DecodeUtf8(text, &code_points)) {
    SetError("INVALID_REQUEST", std::string(label) + " must be valid UTF-8.");
    return false;
  }
  if (std::any_of(code_points.begin(), code_points.end(),
                  [](uint32_t code_point) { return code_point > 0xffff; })) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Supplementary Unicode characters are not supported yet.");
    return false;
  }
  return true;
}

bool ValidateLayoutText(std::string_view text, const char* label) {
  if (text.size() > kMaxTextBytes) {
    SetError("RESOURCE_LIMIT", std::string(label) + " is too large.");
    return false;
  }
  if (!IsValidUtf8(text)) {
    SetError("INVALID_REQUEST", std::string(label) + " must be valid UTF-8.");
    return false;
  }
  return true;
}

bool ReplaceUtf16Range(std::string_view original,
                       uint32_t start,
                       uint32_t end,
                       std::string_view replacement,
                       std::string* result) {
  if (end < start) {
    SetError("INVALID_REQUEST", "The text range is invalid.");
    return false;
  }
  std::vector<uint32_t> code_points;
  if (!DecodeUtf8(original, &code_points)) {
    SetError("CORE_UNAVAILABLE", "The existing PDF text is not valid UTF-8.");
    return false;
  }
  uint32_t offset = 0;
  bool start_found = start == 0;
  bool end_found = end == 0;
  result->clear();
  for (uint32_t code_point : code_points) {
    if (offset == start) {
      result->append(replacement);
      start_found = true;
    }
    if (offset < start || offset >= end) {
      AppendCodePointUtf8(code_point, result);
    }
    const uint32_t width = code_point > 0xffff ? 2U : 1U;
    if (offset > std::numeric_limits<uint32_t>::max() - width) {
      SetError("RESOURCE_LIMIT", "The existing text is too large.");
      return false;
    }
    offset += width;
    if (offset == end) {
      end_found = true;
    }
    if ((offset > start && !start_found) || (offset > end && !end_found)) {
      SetError("INVALID_REQUEST",
               "The text range splits a UTF-16 surrogate pair.");
      return false;
    }
  }
  if (offset == start) {
    result->append(replacement);
    start_found = true;
  }
  if (offset == end) {
    end_found = true;
  }
  if (!start_found || !end_found || start > offset || end > offset) {
    SetError("INVALID_REQUEST", "The text range is outside the TextBlock.");
    return false;
  }
  return true;
}

bool GetPageMatrices(FPDF_PAGE page, Matrix* pdf_to_page, Matrix* page_to_pdf) {
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page) {
    SetUnexpectedError();
    return false;
  }
  const double user_unit = GetUserUnit(native_page);
  *pdf_to_page = MatrixFromCfx(native_page->GetDisplayMatrix())
                     .Then(Matrix{user_unit, 0, 0, user_unit, 0, 0});
  const std::optional<Matrix> inverse = InverseMatrix(*pdf_to_page);
  if (!inverse) {
    SetError("CORE_UNAVAILABLE", "The PDF page transform is not invertible.");
    return false;
  }
  *page_to_pdf = *inverse;
  return true;
}

bool ParentFormToPdf(FPDF_PAGE page,
                     const std::vector<size_t>& path,
                     Matrix* parent_to_pdf) {
  *parent_to_pdf = Matrix{};
  if (path.size() < 2) return true;
  FPDF_PAGEOBJECT parent = FPDFPage_GetObject(page, static_cast<int>(path[0]));
  for (size_t depth = 1; depth < path.size(); ++depth) {
    FS_MATRIX matrix{};
    if (!parent || FPDFPageObj_GetType(parent) != FPDF_PAGEOBJ_FORM ||
        !FPDFPageObj_GetMatrix(parent, &matrix)) {
      SetError("CORE_UNAVAILABLE", "The parent Form transform is unavailable.");
      return false;
    }
    *parent_to_pdf = MatrixFromFs(matrix).Then(*parent_to_pdf);
    if (depth + 1 < path.size())
      parent = FPDFFormObj_GetObject(parent, static_cast<unsigned long>(path[depth]));
  }
  return true;
}

bool NestedObjectFitsForm(FPDF_PAGE page,
                          FPDF_PAGEOBJECT object,
                          const std::vector<size_t>& path) {
  auto* native = CPDFPageObjectFromFPDFPageObject(object);
  if (!native) { SetUnexpectedError(); return false; }
  CFX_FloatRect bounds = native->GetRect();
  for (size_t depth = path.size() - 1; depth > 0; --depth) {
    const std::vector<size_t> prefix(path.begin(), path.begin() + depth);
    auto* ancestor = CPDFPageObjectFromFPDFPageObject(ObjectAtPath(page, prefix));
    auto* form = ancestor ? ancestor->AsForm() : nullptr;
    if (!form) { SetUnexpectedError(); return false; }
    const CFX_FloatRect clip = form->form()->GetDict()->GetRectFor("BBox");
    if (bounds.left < clip.left - 0.01f || bounds.bottom < clip.bottom - 0.01f ||
        bounds.right > clip.right + 0.01f || bounds.top > clip.top + 0.01f) {
      SetError("UNSUPPORTED_CAPABILITY",
               "The nested object would extend beyond its parent Form clipping bounds.");
      return false;
    }
    bounds = form->form_matrix().TransformRect(bounds);
  }
  return true;
}

bool ApplyNormalizedTransform(FPDF_PAGE page,
                              FPDF_PAGEOBJECT object,
                              const Matrix& normalized_transform,
                              const Matrix& parent_to_pdf = Matrix{}) {
  if (!IsFiniteMatrix(normalized_transform)) {
    SetError("INVALID_REQUEST", "The object transform must be finite.");
    return false;
  }
  Matrix pdf_to_page;
  Matrix page_to_pdf;
  if (!GetPageMatrices(page, &pdf_to_page, &page_to_pdf)) {
    return false;
  }
  const Matrix local_to_page = parent_to_pdf.Then(pdf_to_page);
  const auto page_to_local = InverseMatrix(local_to_page);
  if (!page_to_local) {
    SetError("UNSUPPORTED_CAPABILITY", "The parent Form transform is not invertible.");
    return false;
  }
  const Matrix pdf_transform =
      local_to_page.Then(normalized_transform).Then(*page_to_local);
  const FS_MATRIX value{
      static_cast<float>(pdf_transform.a), static_cast<float>(pdf_transform.b),
      static_cast<float>(pdf_transform.c), static_cast<float>(pdf_transform.d),
      static_cast<float>(pdf_transform.e), static_cast<float>(pdf_transform.f)};
  CPDF_PageObject* native_object = CPDFPageObjectFromFPDFPageObject(object);
  if (!native_object || !FPDFPageObj_TransformF(object, &value)) {
    SetError("CORE_UNAVAILABLE", "The page object could not be transformed.");
    return false;
  }
  native_object->TransformClipPath(
      CFX_Matrix(value.a, value.b, value.c, value.d, value.e, value.f));
  return true;
}

bool SetObjectMatrix(FPDF_PAGE page,
                     FPDF_PAGEOBJECT object,
                     const Matrix& object_to_page) {
  Matrix pdf_to_page;
  Matrix page_to_pdf;
  if (!GetPageMatrices(page, &pdf_to_page, &page_to_pdf)) {
    return false;
  }
  const Matrix object_to_pdf = object_to_page.Then(page_to_pdf);
  const FS_MATRIX value{
      static_cast<float>(object_to_pdf.a), static_cast<float>(object_to_pdf.b),
      static_cast<float>(object_to_pdf.c), static_cast<float>(object_to_pdf.d),
      static_cast<float>(object_to_pdf.e), static_cast<float>(object_to_pdf.f)};
  if (!FPDFPageObj_SetMatrix(object, &value)) {
    SetError("CORE_UNAVAILABLE",
             "The inserted object could not be positioned.");
    return false;
  }
  return true;
}

bool FitTextToBounds(FPDF_PAGE page, FPDF_PAGEOBJECT object, const Rect& requested) {
  Rect current;
  if (!GetNormalizedObjectBounds(page, object, &current)) return false;
  if (current.width <= 0 || current.height <= 0) {
    if (!GetNormalizedTextLayoutFrame(page, object, &current) || current.width <= 0 || current.height <= 0) {
      SetError("INVALID_REQUEST", "The text has no measurable search-layer geometry.");
      return false;
    }
  }
  const double sx = requested.width / current.width;
  const double sy = requested.height / current.height;
  return ApplyNormalizedTransform(page, object,
      Matrix{sx, 0, 0, sy, requested.x - current.x * sx, requested.y - current.y * sy});
}

bool FitOcrReplacement(CPDF_TextObject* text, CPDF_TextObject* original) {
  const CFX_Matrix matrix = original->GetTextMatrix();
  original->SetTextMatrix(CFX_Matrix());
  auto measured = text->Clone();
  measured->SetTextMatrix(CFX_Matrix());
  const auto before = original->GetRect();
  const auto after = measured->GetRect();
  if (before.Width() <= 0 || before.Height() <= 0 || after.Width() <= 0 || after.Height() <= 0) return false;
  const float sx = before.Width() / after.Width();
  const float sy = before.Height() / after.Height();
  text->SetTextMatrix(CFX_Matrix(sx, 0, 0, sy, before.left - sx * after.left,
                                before.bottom - sy * after.bottom) * matrix);
  text->SetDirty(true);
  return true;
}

bool GetObjectText(FPDF_PAGE page, FPDF_PAGEOBJECT object, std::string* text) {
  ScopedTextPage text_page(FPDFText_LoadPage(page));
  if (!text_page.get()) {
    SetError("CORE_UNAVAILABLE", "The PDF text layer could not be loaded.");
    return false;
  }
  *text = GetTextForObject(object, text_page.get());
  return true;
}

bool SetTextContent(FPDF_PAGEOBJECT object, std::string_view text) {
  if (text.empty()) {
    SetError("INVALID_REQUEST", "Empty text must remove the page object.");
    return false;
  }
  std::vector<FPDF_WCHAR> wide;
  uint32_t length = 0;
  if (!Utf8ToPdfWide(text, &wide, &length) ||
      !FPDFText_SetText(object, wide.data())) {
    SetError("CORE_UNAVAILABLE", "The text could not be encoded into the PDF.");
    return false;
  }
  return true;
}

bool SelectTextFont(
    FPDF_DOCUMENT pdf,
    CPDF_TextObject* text,
    const std::string& font_id,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    CPDF_Font** selected_font) {
  *selected_font = text->GetFont().Get();
  if (font_id.empty()) {
    return *selected_font != nullptr;
  }
  const auto resource = resources.find(font_id);
  if (resource == resources.end()) {
    SetError("INVALID_REQUEST", "The requested font is not registered.");
    return false;
  }
  CPDF_Font* loaded = font_cache->Load(resource->second);
  CPDF_Document* native_document = CPDFDocumentFromFPDFDocument(pdf);
  RetainPtr<CPDF_Font> replacement_font;
  if (loaded && native_document) {
    replacement_font = CPDF_DocPageData::FromDocument(native_document)
                           ->GetFont(loaded->GetMutableFontDict());
  }
  if (!replacement_font) {
    SetUnexpectedError();
    return false;
  }
  text->mutable_text_state().SetFont(std::move(replacement_font));
  text->SetDirty(true);
  *selected_font = loaded;
  return true;
}

bool LoadCommandPage(FPDF_DOCUMENT pdf,
                     CandidateMetadata* metadata,
                     const std::string& page_id,
                     size_t* page_index,
                     ScopedPage* page) {
  const std::optional<size_t> found = FindPageIndex(*metadata, page_id);
  if (!found || *found > static_cast<size_t>(std::numeric_limits<int>::max())) {
    SetError("INVALID_REQUEST", "The command page does not exist.");
    return false;
  }
  *page_index = *found;
  FPDF_PAGE loaded = FPDF_LoadPage(pdf, static_cast<int>(*found));
  if (!loaded) {
    SetError("CORE_UNAVAILABLE", "The PDF page could not be loaded.");
    return false;
  }
  *page = ScopedPage(loaded);
  return true;
}

bool ApplyParagraphStyle(const Document& document, FPDF_DOCUMENT pdf,
    FPDF_PAGE page, CandidateMetadata* metadata, size_t page_index,
    const ObjectTarget& target, const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources);

bool ReplaceParagraphText(const Document& document, FPDF_DOCUMENT pdf, FPDF_PAGE page,
    CandidateMetadata* metadata, size_t page_index, const ObjectTarget& target,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    Rect* layout_bounds, bool* overflow, TextInsertLayoutResult* paragraph_layout);

bool ApplyTextReplace(
    const Document& document,
    FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    Rect* layout_bounds,
    bool* overflow,
    TextInsertLayoutResult* paragraph_layout) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  ObjectTarget target;
  if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                        command.target_id, true, &target)) {
    return false;
  }
  const bool nested = target.path.size() > 1;
  if (nested && (!NestedFormPathIsStructurallyEditable(page.get(), target.object, target.path) ||
                 ParagraphMetadata(target.object))) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Nested marked/tagged Form text or paragraph structures cannot be rewritten safely.");
    return false;
  }
  if (ParagraphMetadata(target.object)) {
    return ReplaceParagraphText(document, pdf, page.get(), metadata, page_index, target,
                                command, resources, layout_bounds, overflow, paragraph_layout);
  }
  CPDF_PageObject* native_object =
      CPDFPageObjectFromFPDFPageObject(target.object);
  CPDF_TextObject* native_text =
      native_object ? native_object->AsText() : nullptr;
  if (!native_text) {
    SetError("INVALID_REQUEST", "The target is not a text object.");
    return false;
  }
  const bool search_layer = IsOcrTextObject(target.object);
  auto original_ocr = search_layer ? native_text->Clone() : nullptr;
  std::string current_text;
  if (!GetObjectText(page.get(), target.object, &current_text)) {
    return false;
  }
  if (!ValidateSingleLineText(command.text, "Replacement text")) return false;
  const uint32_t current_length = Utf16Length(current_text);
  if (!command.font_id.empty() &&
      (command.start_utf16 != 0 || command.end_utf16 != current_length)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Changing font during a partial TextBlock replacement is not "
             "supported.");
    return false;
  }
  std::string updated_text;
  if (!ReplaceUtf16Range(current_text, command.start_utf16, command.end_utf16,
                         command.text, &updated_text)) {
    return false;
  }

  FPDF_PAGEOBJECTMARK actual_text_mark = nullptr;
  if (!GetSupportedActualTextMark(target.object, &actual_text_mark)) {
    return false;
  }
  Matrix parent_to_pdf;
  if (nested && !ParentFormToPdf(page.get(), target.path, &parent_to_pdf))
    return false;
  Rect original_bounds;
  Rect original_frame;
  if (!GetNormalizedTextLayoutFrame(page.get(), target.object,
                                    &original_frame, parent_to_pdf) ||
      !GetNormalizedObjectBounds(page.get(), target.object, &original_bounds,
                                 parent_to_pdf)) {
    return false;
  }
  CPDF_PageObjectHolder* holder = nullptr;
  std::optional<pdf_editor::PreparedFormPath> prepared_path;
  if (nested && !PrepareObjectHolder(page.get(), target.path, &holder, &prepared_path))
    return false;
  if (updated_text.empty()) {
    // PDFium drops empty text on reparsing, so delete the object and its
    // identity together rather than retaining an unsavable empty placeholder.
    if (nested ? !holder->RemovePageObject(native_object)
               : !FPDFPage_RemoveObject(page.get(), target.object)) {
      SetError("CORE_UNAVAILABLE", "The cleared text object could not be removed.");
      return false;
    }
    if (!nested) FPDFPageObj_Destroy(target.object);
    auto* identities = &metadata->pages[page_index].objects;
    for (size_t depth = 0; depth + 1 < target.path.size(); ++depth)
      identities = &(*identities)[target.path[depth]].children;
    identities->erase(identities->begin() + static_cast<std::ptrdiff_t>(target.path.back()));
    if (!GenerateEditedObjectHolder(page.get(), prepared_path,
                                    "The cleared text content could not be generated."))
      return false;
    if (layout_bounds) *layout_bounds = {original_bounds.x, original_bounds.y, 0, 0};
    if (overflow) *overflow = false;
    return true;
  }
  CPDF_Font* selected_font = nullptr;
  if (!SelectTextFont(pdf, native_text, command.font_id, resources, font_cache,
                      &selected_font)) {
    return false;
  }
  if (!updated_text.empty() && !FontCanEncode(selected_font, updated_text)) {
    SetError("UNSUPPORTED_CAPABILITY",
             command.font_id.empty()
                 ? "The current PDF font cannot reliably encode the "
                   "replacement; select a registered font."
                 : "The selected font does not contain every replacement "
                   "character.");
    return false;
  }
  if (!SetTextContent(target.object, updated_text) ||
      !SetActualText(target.object, actual_text_mark, updated_text) ||
      (search_layer && !FitOcrReplacement(native_text, original_ocr.get()) &&
       !FitTextToBounds(page.get(), target.object, original_bounds)) ||
      (nested && !NestedObjectFitsForm(page.get(), target.object, target.path)) ||
      !GenerateEditedObjectHolder(
          page.get(), prepared_path, "The edited text content could not be generated.")) {
    return false;
  }

  if (layout_bounds || overflow) {
    Rect edited_bounds;
    if (updated_text.empty()) {
      edited_bounds = {original_bounds.x, original_bounds.y, 0, 0};
    } else if (!GetNormalizedObjectBounds(page.get(), target.object,
                                          &edited_bounds, parent_to_pdf)) {
      return false;
    }
    if (layout_bounds) {
      *layout_bounds = edited_bounds;
    }
    if (overflow) {
      Rect edited_frame;
      if (!GetNormalizedTextLayoutFrame(page.get(), target.object,
                                        &edited_frame, parent_to_pdf)) {
        return false;
      }
      *overflow = !search_layer && (
          edited_frame.x < original_frame.x - kLayoutEpsilon ||
          edited_frame.y < original_frame.y - kLayoutEpsilon ||
          edited_frame.x + edited_frame.width >
              original_frame.x + original_frame.width + kLayoutEpsilon ||
          edited_frame.y + edited_frame.height >
              original_frame.y + original_frame.height + kLayoutEpsilon);
    }
  }
  return true;
}

bool ApplyStyleToText(
    FPDF_DOCUMENT pdf,
    CPDF_TextObject* text,
    const std::string& current_text,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache) {
  FPDF_PAGEOBJECT object = FPDFPageObjectFromCPDFPageObject(text);
  CPDF_Font* selected_font = nullptr;
  if (!SelectTextFont(pdf, text,
                      (command.flags & 1U) ? command.font_id : std::string(),
                      resources, font_cache, &selected_font)) {
    return false;
  }
  const bool font_changed = (command.flags & 1U) != 0;
  if (font_changed && !FontCanEncode(selected_font, current_text)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The selected font does not contain every selected character.");
    return false;
  }
  if (command.flags & 2U) {
    text->mutable_text_state().SetFontSize(static_cast<float>(command.values[0]));
  }
  if (command.flags & 4U) {
    unsigned int red = 0, green = 0, blue = 0, alpha = 255;
    FPDFPageObj_GetFillColor(object, &red, &green, &blue, &alpha);
    if (!FPDFPageObj_SetFillColor(
            object,
            static_cast<unsigned int>(std::lround(command.values[1] * 255)),
            static_cast<unsigned int>(std::lround(command.values[2] * 255)),
            static_cast<unsigned int>(std::lround(command.values[3] * 255)),
            alpha)) {
      SetError("CORE_UNAVAILABLE", "The text color could not be changed.");
      return false;
    }
  }
  if (command.flags & 8U) {
    text->mutable_text_state().SetCharSpace(static_cast<float>(command.values[4]));
  }
  if (font_changed) {
    if (!SetTextContent(object, current_text)) return false;
  } else if (command.flags & (2U | 8U)) {
    text->SetTextMatrix(text->GetTextMatrix());
  }
  text->SetDirty(true);
  return true;
}

bool ApplyTextRangeStyle(
    const Document& document,
    FPDF_DOCUMENT pdf,
    FPDF_PAGE page,
    CandidateMetadata* metadata,
    size_t page_index,
    const ObjectTarget& target,
    CPDF_TextObject* text,
    const std::string& current_text,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    const std::set<std::string>* batch_new_ids) {
  LayoutText decoded;
  std::vector<bool> boundaries;
  if (!DecodeLayoutText(current_text, &decoded) ||
      !CollectUnicodeBreaks(UBRK_CHARACTER, decoded.utf16, &boundaries)) {
    return false;
  }
  if (command.start_utf16 >= command.end_utf16 ||
      command.end_utf16 > decoded.utf16.size() ||
      !boundaries[command.start_utf16] || !boundaries[command.end_utf16]) {
    SetError("INVALID_REQUEST", "The style range must contain whole graphemes.");
    return false;
  }
  if (command.start_utf16 == 0 && command.end_utf16 == decoded.utf16.size()) {
    return ApplyStyleToText(pdf, text, current_text, command, resources, font_cache);
  }
  FPDF_PAGEOBJECTMARK original_mark = nullptr;
  if (!GetSupportedActualTextMark(target.object, &original_mark)) return false;

  // Locate PDF character boundaries through the actual ToUnicode map. A
  // ligature or marked-text alias is never split by guessing glyph indices.
  auto font = text->GetFont();
  std::string mapped_text;
  std::vector<uint32_t> offsets{0};
  for (uint32_t code : text->GetCharCodes()) {
    const ByteString mapped = font->UnicodeFromCharCode(code).ToUTF8();
    if (mapped.IsEmpty()) {
      SetError("UNSUPPORTED_CAPABILITY", "The selected text has unmapped glyphs.");
      return false;
    }
    const std::string_view unicode(mapped.c_str(), mapped.GetLength());
    mapped_text.append(unicode);
    offsets.push_back(offsets.back() + Utf16Length(unicode));
  }
  const auto start = std::find(offsets.begin(), offsets.end(), command.start_utf16);
  const auto end = std::find(offsets.begin(), offsets.end(), command.end_utf16);
  if (mapped_text != current_text || start == offsets.end() || end == offsets.end()) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The range cuts a glyph cluster or has a non-local text mapping.");
    return false;
  }
  const size_t first = static_cast<size_t>(start - offsets.begin());
  const size_t last = static_cast<size_t>(end - offsets.begin());
  const size_t count = text->CharCount();
  const auto positions = text->GetCharPositions();
  const auto original_matrix = text->GetTextMatrix();
  if (text->CalcPositionData(1).y != 0) {
    SetError("UNSUPPORTED_CAPABILITY", "Vertical range layout is not connected yet.");
    return false;
  }
  auto& identities = metadata->pages[page_index].objects;
  const ObjectIdentity original_identity = identities[target.path[0]];
  const std::string seed = command.transaction_id + ":style:" +
      std::to_string(command.transaction_index) + ":" + original_identity.id;
  std::vector<std::unique_ptr<CPDF_TextObject>> pieces;
  std::vector<ObjectIdentity> piece_ids;
  std::set<std::string> generated_ids;
  float suffix_shift = 0;
  const std::array<std::pair<size_t, size_t>, 3> slices = {
      std::pair<size_t, size_t>{0, first}, {first, last}, {last, count}};
  for (size_t part = 0; part < slices.size(); ++part) {
    const auto [begin, finish] = slices[part];
    if (begin == finish) continue;
    auto piece = text->Clone();
    std::vector<ByteString> strings;
    std::vector<float> kernings;
    for (size_t index = begin; index < finish; ++index) {
      ByteString encoded;
      font->AppendChar(&encoded, text->GetCharCode(index));
      strings.push_back(std::move(encoded));
      if (index + 1 < finish) kernings.push_back(text->GetCharKernings()[index]);
    }
    piece->SetSegments(strings, kernings);
    piece->SetTextMatrix(original_matrix);
    piece->SetContentStream(text->GetContentStream());
    const std::string piece_text = current_text.substr(
        decoded.byte_offsets[offsets[begin]],
        decoded.byte_offsets[offsets[finish]] - decoded.byte_offsets[offsets[begin]]);
    FPDF_PAGEOBJECT handle = FPDFPageObjectFromCPDFPageObject(piece.get());
    if (original_mark) {
      const auto* original_item = CPDFContentMarkItemFromFPDFPageObjectMark(original_mark);
      // A cloned mark may share its dictionary; detach before updating ActualText.
      if (!FPDFPageObj_RemoveMark(handle, FPDFPageObj_GetMark(handle, 0))) return false;
      FPDF_PAGEOBJECTMARK mark = FPDFPageObj_AddMark(handle, original_item->GetName().c_str());
      auto* item = CPDFContentMarkItemFromFPDFPageObjectMark(mark);
      if (!item) return false;
      item->SetDirectDict(ToDictionary(original_item->GetParam()->Clone()));
      if (!SetActualText(handle, mark, piece_text)) return false;
    }
    if (part == 1) {
      const float old_advance = piece->CalcPositionData(1).x;
      if (!ApplyStyleToText(pdf, piece.get(), piece_text, command, resources, font_cache)) {
        return false;
      }
      suffix_shift = piece->CalcPositionData(1).x - old_advance;
    }
    const float offset = positions[begin] + (part == 2 ? suffix_shift : 0);
    auto matrix = original_matrix;
    const CFX_PointF origin = original_matrix.Transform(CFX_PointF(offset, 0));
    matrix.e = origin.x;
    matrix.f = origin.y;
    piece->SetTextMatrix(matrix);
    piece->SetDirty(true);
    ObjectIdentity identity = original_identity;
    if (!pieces.empty()) {
      identity.id = GeneratedObjectId(document, seed, part);
      identity.text_block_id = GeneratedTextBlockId(document, seed, part);
      const bool history_collision = !document.transaction_ids.contains(command.transaction_id) &&
          (document.reserved_ids.contains(identity.id) ||
           document.reserved_ids.contains(identity.text_block_id));
      if (history_collision ||
          (batch_new_ids && (batch_new_ids->contains(identity.id) ||
                             batch_new_ids->contains(identity.text_block_id))) ||
          IdentityTreeHasCollision(identity, *metadata, &generated_ids)) {
        SetError("INVALID_REQUEST", "A formatted text identity is already in use.");
        return false;
      }
    }
    pieces.push_back(std::move(piece));
    piece_ids.push_back(std::move(identity));
  }
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page);
  const size_t object_index = target.path[0];
  if (!native_page->ErasePageObjectAtIndex(object_index)) {
    SetError("CORE_UNAVAILABLE", "The formatted text could not be replaced.");
    return false;
  }
  identities.erase(identities.begin() + object_index);
  for (size_t index = 0; index < pieces.size(); ++index) {
    if (!native_page->InsertPageObjectAtIndex(object_index + index, std::move(pieces[index]))) {
      SetError("CORE_UNAVAILABLE", "A formatted text run could not be inserted.");
      return false;
    }
  }
  identities.insert(identities.begin() + object_index, piece_ids.begin(), piece_ids.end());
  return true;
}

bool ApplyTextStyle(
    const Document& document,
    FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    const std::set<std::string>* batch_new_ids) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  for (const std::string& block_id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], block_id,
                          true, &target)) {
      return false;
    }
    const bool nested = target.path.size() > 1;
    if (ParagraphMetadata(target.object)) {
      if (!ApplyParagraphStyle(document, pdf, page.get(), metadata, page_index,
                               target, command, resources)) return false;
      continue;
    }
    if (command.flags & kTextStyleUnderlineFlag) {
      SetError("UNSUPPORTED_CAPABILITY", "Underlining a regular TextObject is not implemented.");
      return false;
    }
    if (nested && ((command.flags & kTextStyleRangeFlag) ||
                   !NestedFormPathIsStructurallyEditable(page.get(), target.object, target.path))) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Nested marked/tagged text and nested range formatting cannot be rewritten safely.");
      return false;
    }
    CPDF_PageObject* native_object =
        CPDFPageObjectFromFPDFPageObject(target.object);
    CPDF_TextObject* native_text =
        native_object ? native_object->AsText() : nullptr;
    if (!native_text) {
      SetError("INVALID_REQUEST", "A style target is not a text object.");
      return false;
    }
    std::string current_text;
    if (!GetObjectText(page.get(), target.object, &current_text)) {
      return false;
    }
    CPDF_PageObjectHolder* holder = nullptr;
    std::optional<pdf_editor::PreparedFormPath> prepared_path;
    if (nested && !PrepareObjectHolder(page.get(), target.path, &holder, &prepared_path))
      return false;
    if (command.flags & kTextStyleRangeFlag) {
      if (!ApplyTextRangeStyle(document, pdf, page.get(), metadata, page_index,
                               target, native_text, current_text, command,
                               resources, font_cache, batch_new_ids)) return false;
    } else if (!ApplyStyleToText(pdf, native_text, current_text, command,
                                resources, font_cache)) {
      return false;
    }
    if (nested && (!NestedObjectFitsForm(page.get(), target.object, target.path) ||
                   !GenerateEditedObjectHolder(
                       page.get(), prepared_path, "The styled Form content could not be generated.")))
      return false;
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE",
             "The styled page content could not be generated.");
    return false;
  }
  return true;
}

bool AddTopLevelIdentity(PageIdentity* page,
                         ObjectIdentity identity,
                         FPDF_PAGE page_handle,
                         FPDF_PAGEOBJECT object) {
  if (!FPDFPage_InsertObject(page_handle, object)) {
    SetError("CORE_UNAVAILABLE", "The new page object could not be inserted.");
    return false;
  }
  page->objects.push_back(std::move(identity));
  return true;
}

struct WrappedTextLine {
  uint32_t start_utf16 = 0;
  uint32_t end_utf16 = 0;
  std::string text;
  double advance = 0;
  Rect bounds;
};

struct PreparedTextInsertLayout {
  std::vector<WrappedTextLine> lines;
  bool overflow = false;
};

bool RectFitsInside(const Rect& inner, const Rect& outer) {
  return inner.x >= outer.x - kLayoutEpsilon &&
         inner.y >= outer.y - kLayoutEpsilon &&
         inner.x + inner.width <= outer.x + outer.width + kLayoutEpsilon &&
         inner.y + inner.height <= outer.y + outer.height + kLayoutEpsilon;
}

void IncludeRect(const Rect& value, bool* initialized, Rect* bounds) {
  if (!*initialized) {
    *bounds = value;
    *initialized = true;
    return;
  }
  const double left = std::min(bounds->x, value.x);
  const double top = std::min(bounds->y, value.y);
  const double right =
      std::max(bounds->x + bounds->width, value.x + value.width);
  const double bottom =
      std::max(bounds->y + bounds->height, value.y + value.height);
  *bounds = {left, top, right - left, bottom - top};
}

bool PrepareTextInsertLayout(FPDF_PAGE page,
                             FPDF_FONT font,
                             CPDF_Font* native_font,
                             const EditCommand& command,
                             PreparedTextInsertLayout* layout) {
  LayoutText text;
  if (!DecodeLayoutText(command.text, &text)) {
    SetError("INVALID_REQUEST", "Inserted text must be valid UTF-8.");
    return false;
  }
  std::vector<bool> grapheme_boundaries;
  std::vector<bool> line_boundaries;
  if (!CollectUnicodeBreaks(UBRK_CHARACTER, text.utf16,
                            &grapheme_boundaries) ||
      !CollectUnicodeBreaks(UBRK_LINE, text.utf16, &line_boundaries)) {
    return false;
  }

  const float font_size = static_cast<float>(command.values[4]);
  const double character_spacing =
      (command.flags & 8U) ? static_cast<float>(command.values[8]) : 0;
  std::vector<double> width_prefix(text.utf16.size() + 1, 0);
  std::vector<uint32_t> character_prefix(text.utf16.size() + 1, 0);
  std::vector<double> glyph_left(text.utf16.size(), 0);
  std::vector<double> glyph_right(text.utf16.size(), 0);
  double total_width = 0;
  uint32_t character_count = 0;
  for (const LayoutCodePoint& code_point : text.code_points) {
    for (uint32_t offset = code_point.start_utf16;
         offset < code_point.end_utf16; ++offset) {
      width_prefix[offset] = total_width;
      character_prefix[offset] = character_count;
    }
    if (code_point.value != '\n' && code_point.value != '\r') {
      if (code_point.value > 0xffff) {
        SetError("UNSUPPORTED_CAPABILITY",
                 "The selected font cannot reliably encode a supplementary "
                 "inserted character.");
        return false;
      }
      const wchar_t unicode = static_cast<wchar_t>(code_point.value);
      const uint32_t char_code = native_font->CharCodeFromUnicode(unicode);
      const WideString round_trip =
          char_code == CPDF_Font::kInvalidCharCode
              ? WideString()
              : native_font->UnicodeFromCharCode(char_code);
      if (char_code == CPDF_Font::kInvalidCharCode ||
          (char_code == 0 && code_point.value != 0) ||
          round_trip.GetLength() != 1 || round_trip.Front() != unicode) {
        SetError("UNSUPPORTED_CAPABILITY",
                 "The selected font does not contain every inserted "
                 "character.");
        return false;
      }
      const double glyph_width =
          native_font->GetCharWidth(char_code) * font_size / 1000.0;
      if (!std::isfinite(glyph_width)) {
        SetError("CORE_UNAVAILABLE", "The inserted text width is invalid.");
        return false;
      }
      const FX_RECT ink = native_font->GetCharBBox(char_code);
      glyph_left[code_point.start_utf16] = ink.left * font_size / 1000.0;
      glyph_right[code_point.start_utf16] = ink.right * font_size / 1000.0;
      total_width += glyph_width;
      ++character_count;
    }
    width_prefix[code_point.end_utf16] = total_width;
    character_prefix[code_point.end_utf16] = character_count;
  }

  float ascent = 0;
  float descent = 0;
  if (!FPDFFont_GetAscent(font, static_cast<float>(font_size), &ascent) ||
      !FPDFFont_GetDescent(font, static_cast<float>(font_size), &descent)) {
    SetError("CORE_UNAVAILABLE", "The inserted font metrics are unavailable.");
    return false;
  }
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page) {
    SetUnexpectedError();
    return false;
  }
  const double user_unit = GetUserUnit(native_page);
  const Matrix text_to_page =
      MatrixFromCfx(native_page->GetDisplayMatrix())
          .Then(Matrix{user_unit, 0, 0, user_unit, 0, 0});
  const double line_height =
      (command.flags & kTextInsertLineHeightFlag) ? command.values[9]
                                                  : kDefaultLineHeight;
  const double line_step = font_size * line_height * user_unit;
  const Rect requested{command.values[0], command.values[1], command.values[2],
                       command.values[3]};

  const auto line_advance = [&](uint32_t start, uint32_t end) {
    const uint32_t count = character_prefix[end] - character_prefix[start];
    const double spacing = count > 1 ? character_spacing * (count - 1) : 0;
    return width_prefix[end] - width_prefix[start] + spacing;
  };
  const auto frame_for_advance = [&](double advance, double ink_left = 0,
                                     double ink_right = 0) {
    return TransformBounds(std::min({0.0, advance, ink_left}),
                           std::min<double>(0, descent),
                           std::max({0.0, advance, ink_right}),
                           std::max<double>(0, ascent), text_to_page);
  };
  const auto character_position = [&](uint32_t start, uint32_t offset) {
    return width_prefix[offset] - width_prefix[start] +
           character_spacing * (character_prefix[offset] - character_prefix[start]);
  };
  const auto frame_for_range = [&](uint32_t start, uint32_t end) {
    double left = 0, right = 0;
    for (uint32_t offset = start; offset < end; ++offset) {
      const double x = character_position(start, offset);
      left = std::min(left, x + glyph_left[offset]);
      right = std::max(right, x + glyph_right[offset]);
    }
    return frame_for_advance(line_advance(start, end), left, right);
  };
  const auto append_line = [&](uint32_t start, uint32_t end) -> bool {
    if (start >= text.byte_offsets.size() || end >= text.byte_offsets.size() ||
        text.byte_offsets[start] == std::numeric_limits<size_t>::max() ||
        text.byte_offsets[end] == std::numeric_limits<size_t>::max()) {
      SetError("CORE_UNAVAILABLE",
               "A Unicode line boundary split an inserted character.");
      return false;
    }
    WrappedTextLine line;
    line.start_utf16 = start;
    line.end_utf16 = end;
    line.text.assign(command.text, text.byte_offsets[start],
                     text.byte_offsets[end] - text.byte_offsets[start]);
    line.advance = line_advance(start, end);
    if (!std::isfinite(line.advance)) {
      SetError("RESOURCE_LIMIT", "The inserted text width is too large.");
      return false;
    }
    layout->lines.push_back(std::move(line));
    return true;
  };
  const auto wrap_paragraph = [&](uint32_t paragraph_start,
                                  uint32_t paragraph_end) -> bool {
    if (paragraph_start == paragraph_end) {
      return append_line(paragraph_start, paragraph_end);
    }
    uint32_t line_start = paragraph_start;
    while (line_start < paragraph_end) {
      uint32_t first_grapheme = 0;
      uint32_t furthest_fit = 0;
      uint32_t preferred_break = 0;
      double ink_left = 0, ink_right = 0;
      for (uint32_t boundary = line_start + 1; boundary <= paragraph_end;
           ++boundary) {
        const uint32_t offset = boundary - 1;
        const double x = character_position(line_start, offset);
        ink_left = std::min(ink_left, x + glyph_left[offset]);
        ink_right = std::max(ink_right, x + glyph_right[offset]);
        if (!grapheme_boundaries[boundary]) {
          continue;
        }
        if (first_grapheme == 0) {
          first_grapheme = boundary;
        }
        const Rect frame = frame_for_advance(line_advance(line_start, boundary),
                                              ink_left, ink_right);
        if (frame.width <= requested.width + kLayoutEpsilon) {
          furthest_fit = boundary;
          if (line_boundaries[boundary]) {
            preferred_break = boundary;
          }
        } else if (character_spacing >= 0) {
          break;
        }
      }
      uint32_t line_end = 0;
      if (furthest_fit == paragraph_end) {
        line_end = paragraph_end;
      } else if (preferred_break > line_start) {
        line_end = preferred_break;
      } else if (furthest_fit > line_start) {
        line_end = furthest_fit;
      } else if (first_grapheme > line_start) {
        line_end = first_grapheme;
        layout->overflow = true;
      } else {
        SetError("CORE_UNAVAILABLE",
                 "Unicode grapheme boundaries could not advance layout.");
        return false;
      }
      if (!append_line(line_start, line_end)) {
        return false;
      }
      line_start = line_end;
    }
    return true;
  };

  uint32_t paragraph_start = 0;
  uint32_t offset = 0;
  while (offset < text.utf16.size()) {
    if (text.utf16[offset] != '\r' && text.utf16[offset] != '\n') {
      ++offset;
      continue;
    }
    if (!wrap_paragraph(paragraph_start, offset)) {
      return false;
    }
    if (text.utf16[offset] == '\r' && offset + 1 < text.utf16.size() &&
        text.utf16[offset + 1] == '\n') {
      offset += 2;
    } else {
      ++offset;
    }
    paragraph_start = offset;
  }
  if (!wrap_paragraph(paragraph_start,
                      static_cast<uint32_t>(text.utf16.size()))) {
    return false;
  }

  if (std::ranges::all_of(layout->lines,
                          [](const WrappedTextLine& line) { return line.text.empty(); })) {
    SetError("INVALID_REQUEST", "A text box must contain more than line breaks.");
    return false;
  }
  for (size_t index = 0; index < layout->lines.size(); ++index) {
    WrappedTextLine& line = layout->lines[index];
    const Rect unpositioned = frame_for_range(line.start_utf16, line.end_utf16);
    double x = requested.x;
    if (command.flags & kTextInsertCenterFlag) {
      x += (requested.width - unpositioned.width) / 2;
    } else if (command.flags & kTextInsertRightFlag) {
      x += requested.width - unpositioned.width;
    }
    line.bounds = {x, requested.y + index * line_step, unpositioned.width,
                   unpositioned.height};
    if (!RectFitsInside(line.bounds, requested)) {
      layout->overflow = true;
    }
  }
  return true;
}

#include "paragraph_commands.h"

bool ApplyTextInsert(
    const Document& document,
    FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    const std::set<std::string>* batch_new_ids,
    TextInsertLayoutResult* layout_result,
    bool allow_overflow) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  const auto font_resource = resources.find(command.font_id);
  if (font_resource == resources.end()) {
    SetError("INVALID_REQUEST", "The requested font is not registered.");
    return false;
  }
  FPDF_FONT font = font_cache->LoadHandle(font_resource->second);
  CPDF_Font* native_font = font ? CPDFFontFromFPDFFont(font) : nullptr;
  if (!font || !native_font) {
    if (g_error_code.empty()) {
      SetError("CORE_UNAVAILABLE", "The inserted font could not be loaded.");
    }
    return false;
  }

  PreparedTextInsertLayout prepared;
  if (command.flags & kTextFitBoundsFlag) {
    if (!ValidateSingleLineText(command.text, "Search-layer text") ||
        !FontCanEncode(native_font, command.text)) {
      if (g_error_code.empty()) SetError("UNSUPPORTED_CAPABILITY", "The OCR font cannot encode every recognized character.");
      return false;
    }
    prepared.lines.push_back({0, Utf16Length(command.text), command.text, 0,
        {command.values[0], command.values[1], command.values[2], command.values[3]}});
  } else if (!PrepareTextInsertLayout(page.get(), font, native_font, command,
                                      &prepared)) {
    return false;
  }
  if (prepared.overflow && !allow_overflow) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The inserted text does not fit its requested bounds.");
    return false;
  }

  const Rect requested{command.values[0], command.values[1], command.values[2],
                       command.values[3]};
  TextInsertLayoutResult result;
  result.overflow = prepared.overflow;
  result.lines.reserve(prepared.lines.size());
  std::set<std::string> inserted_ids;
  bool bounds_initialized = false;
  bool first_object = true;
  for (size_t index = 0; index < prepared.lines.size(); ++index) {
    const WrappedTextLine& line = prepared.lines[index];
    // Empty text objects disappear when PDFium reparses a page. Preserve blank
    // lines in layout and baseline spacing, not as phantom object identities.
    if (line.text.empty()) {
      IncludeRect(line.bounds, &bounds_initialized, &result.bounds);
      result.lines.push_back({line.bounds, line.start_utf16, line.end_utf16});
      continue;
    }
    FPDF_PAGEOBJECT object = FPDFPageObj_CreateTextObj(
        pdf, font, static_cast<float>(command.values[4]));
    if (!object) {
      SetError("CORE_UNAVAILABLE", "A text line object could not be created.");
      return false;
    }
    CPDF_PageObject* native_object = CPDFPageObjectFromFPDFPageObject(object);
    CPDF_TextObject* native_text =
        native_object ? native_object->AsText() : nullptr;
    if (!native_text) {
      FPDFPageObj_Destroy(object);
      SetUnexpectedError();
      return false;
    }
    if (command.flags & 8U) {
      native_text->mutable_text_state().SetCharSpace(
          static_cast<float>(command.values[8]));
    }
    if (!SetTextContent(object, line.text)) {
      FPDFPageObj_Destroy(object);
      return false;
    }
    if (command.flags & kTextInvisibleFlag) {
      if (!FPDFTextObj_SetTextRenderMode(object, FPDF_TEXTRENDERMODE_INVISIBLE)) {
        FPDFPageObj_Destroy(object);
        SetError("CORE_UNAVAILABLE", "The search-layer rendering mode could not be set.");
        return false;
      }
    }
    if (command.flags & kTextOcrFlag) {
      const auto mark = FPDFPageObj_AddMark(object, "KomoOCR");
      auto* item = CPDFContentMarkItemFromFPDFPageObjectMark(mark);
      if (!item) { FPDFPageObj_Destroy(object); SetUnexpectedError(); return false; }
      item->SetDirectDict(pdfium::MakeRetain<CPDF_Dictionary>());
      if (!SetActualText(object, mark, line.text)) { FPDFPageObj_Destroy(object); return false; }
    }
    if (command.flags & 4U) {
      if (!FPDFPageObj_SetFillColor(
              object,
              static_cast<unsigned int>(std::lround(command.values[5] * 255)),
              static_cast<unsigned int>(std::lround(command.values[6] * 255)),
              static_cast<unsigned int>(std::lround(command.values[7] * 255)),
              255)) {
        FPDFPageObj_Destroy(object);
        SetError("CORE_UNAVAILABLE",
                 "The inserted text color could not be set.");
        return false;
      }
    }

    Rect frame;
    if (!GetNormalizedTextLayoutFrame(page.get(), object, &frame)) {
      FPDFPageObj_Destroy(object);
      return false;
    }
    Rect ink;
    if (!GetNormalizedObjectBounds(page.get(), object, &ink)) {
      FPDFPageObj_Destroy(object);
      return false;
    }
    // Italic bearings may extend beyond the advance box. Position and align
    // the complete horizontal footprint instead of rejecting every left fit.
    const double frame_right = std::max(frame.x + frame.width, ink.x + ink.width);
    frame.x = std::min(frame.x, ink.x);
    frame.width = frame_right - frame.x;
    double positioned_x = requested.x;
    if (command.flags & kTextInsertCenterFlag) {
      positioned_x += (requested.width - frame.width) / 2;
    } else if (command.flags & kTextInsertRightFlag) {
      positioned_x += requested.width - frame.width;
    }
    const Matrix translation{1, 0, 0, 1, positioned_x - frame.x,
                             line.bounds.y - frame.y};
    if (!ApplyNormalizedTransform(page.get(), object, translation)) {
      FPDFPageObj_Destroy(object);
      return false;
    }
    if ((command.flags & kTextFitBoundsFlag) &&
        !FitTextToBounds(page.get(), object, requested)) {
      FPDFPageObj_Destroy(object);
      return false;
    }
    ObjectIdentity identity;
    identity.id = first_object
                      ? command.target_id
                      : GeneratedObjectId(document, command.target_id, index);
    identity.text_block_id =
        GeneratedTextBlockId(document, command.target_id, index);
    const bool collides_with_batch =
        batch_new_ids &&
        ((!first_object && batch_new_ids->contains(identity.id)) ||
         batch_new_ids->contains(identity.text_block_id));
    const bool replaying_reserved_insert =
        document.reserved_ids.contains(command.target_id);
    const bool collides_with_history =
        !replaying_reserved_insert &&
        ((!first_object && document.reserved_ids.contains(identity.id)) ||
         document.reserved_ids.contains(identity.text_block_id));
    if (collides_with_batch || collides_with_history ||
        IdentityTreeHasCollision(identity, *metadata, &inserted_ids)) {
      FPDFPageObj_Destroy(object);
      SetError("INVALID_REQUEST",
               "An inserted text line identity collides with an existing or "
               "same-batch ID.");
      return false;
    }
    if (!AddTopLevelIdentity(&metadata->pages[page_index], std::move(identity),
                             page.get(), object)) {
      FPDFPageObj_Destroy(object);
      return false;
    }

    first_object = false;
    Rect positioned;
    if (!GetNormalizedTextLayoutFrame(page.get(), object, &positioned)) {
      return false;
    }
    if (!(command.flags & kTextFitBoundsFlag) && !RectFitsInside(positioned, requested)) {
      result.overflow = true;
    }
    Rect reported_bounds = positioned;
    if (!line.text.empty()) {
      if (!GetNormalizedObjectBounds(page.get(), object, &reported_bounds)) {
        return false;
      }
      if (!RectFitsInside(reported_bounds, requested)) {
        result.overflow = true;
      }
    }
    IncludeRect(reported_bounds, &bounds_initialized, &result.bounds);
    result.lines.push_back(
        {reported_bounds, line.start_utf16, line.end_utf16});
  }

  if (result.overflow && !allow_overflow) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The inserted text does not fit its requested bounds.");
    return false;
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE", "The inserted text could not be generated.");
    return false;
  }
  if (layout_result) {
    *layout_result = std::move(result);
  }
  return true;
}

bool ApplyObjectsTransform(FPDF_DOCUMENT pdf,
                           CandidateMetadata* metadata,
                           const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  const Matrix transform{command.values[0], command.values[1],
                         command.values[2], command.values[3],
                         command.values[4], command.values[5]};
  for (const std::string& object_id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], object_id,
                          false, &target)) {
      return false;
    }
    Matrix parent_to_pdf;
    if (!ParentFormToPdf(page.get(), target.path, &parent_to_pdf)) return false;
    CPDF_PageObjectHolder* holder = nullptr;
    std::optional<pdf_editor::PreparedFormPath> prepared;
    if (!PrepareObjectHolder(page.get(), target.path, &holder, &prepared) ||
        !ApplyNormalizedTransform(page.get(), target.object, transform, parent_to_pdf))
      return false;
    if (prepared &&
        (!NestedObjectFitsForm(page.get(), target.object, target.path) ||
         !GenerateEditedObjectHolder(
             page.get(), prepared, "The transformed Form could not be generated.")))
      return false;
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE",
             "The transformed page could not be generated.");
    return false;
  }
  return true;
}

bool ApplyObjectsAlign(FPDF_DOCUMENT pdf,
                       CandidateMetadata* metadata,
                       const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page))
    return false;

  std::vector<Rect> bounds;
  Rect selection{};
  bool initialized = false;
  for (const auto& id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], id,
                          false, &target)) return false;
    if (target.path.size() != 1) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Nested Form XObject children cannot be aligned independently.");
      return false;
    }
    Rect box;
    if (!GetNormalizedObjectBounds(page.get(), target.object, &box))
      return false;
    IncludeRect(box, &initialized, &selection);
    bounds.push_back(box);
  }
  const int axis = static_cast<int>(command.values[0]);
  const double anchor = axis == 0 ? selection.x :
      axis == 1 ? selection.x + selection.width / 2 :
      axis == 2 ? selection.x + selection.width :
      axis == 3 ? selection.y :
      axis == 4 ? selection.y + selection.height / 2 :
                  selection.y + selection.height;
  for (size_t index = 0; index < command.ids.size(); ++index) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                          command.ids[index], false, &target)) return false;
    const Rect& box = bounds[index];
    const double current = axis == 0 ? box.x :
        axis == 1 ? box.x + box.width / 2 :
        axis == 2 ? box.x + box.width :
        axis == 3 ? box.y :
        axis == 4 ? box.y + box.height / 2 : box.y + box.height;
    const double distance = anchor - current;
    const Matrix move{1, 0, 0, 1,
                      axis < 3 ? distance : 0,
                      axis >= 3 ? distance : 0};
    if (!ApplyNormalizedTransform(page.get(), target.object, move)) return false;
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE", "The aligned page could not be generated.");
    return false;
  }
  return true;
}

bool ApplyObjectsDistribute(FPDF_DOCUMENT pdf,
                            CandidateMetadata* metadata,
                            const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page))
    return false;
  struct Positioned {
    std::string id;
    double center = 0;
  };
  std::vector<Positioned> positions;
  const bool horizontal = command.values[0] == 0;
  for (const auto& id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], id,
                          false, &target)) return false;
    if (target.path.size() != 1) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Nested Form XObject children cannot be distributed independently.");
      return false;
    }
    Rect box;
    if (!GetNormalizedObjectBounds(page.get(), target.object, &box))
      return false;
    positions.push_back({id, horizontal ? box.x + box.width / 2
                                         : box.y + box.height / 2});
  }
  std::stable_sort(positions.begin(), positions.end(),
                   [](const Positioned& a, const Positioned& b) {
                     return a.center < b.center;
                   });
  const double gap = (positions.back().center - positions.front().center) /
                     (positions.size() - 1);
  for (size_t index = 1; index + 1 < positions.size(); ++index) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                          positions[index].id, false, &target)) return false;
    const double delta = positions.front().center + gap * index -
                         positions[index].center;
    const Matrix move{1, 0, 0, 1, horizontal ? delta : 0,
                      horizontal ? 0 : delta};
    if (!ApplyNormalizedTransform(page.get(), target.object, move)) return false;
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE", "The distributed page could not be generated.");
    return false;
  }
  return true;
}

bool ApplyObjectsDelete(FPDF_DOCUMENT pdf,
                        CandidateMetadata* metadata,
                        const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  std::vector<std::vector<size_t>> paths;
  for (const std::string& object_id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], object_id,
                          false, &target)) return false;
    for (size_t depth = 1; depth < target.path.size(); ++depth) {
      std::vector<size_t> ancestor(target.path.begin(), target.path.begin() + depth);
      if (GroupMetadata(ObjectAtPath(page.get(), ancestor))) {
        SetError("UNSUPPORTED_CAPABILITY",
                 "Ungroup persistent members before deleting them separately.");
        return false;
      }
    }
    paths.push_back(std::move(target.path));
  }
  std::sort(paths.begin(), paths.end());
  for (size_t index = 1; index < paths.size(); ++index) {
    const auto& previous = paths[index - 1];
    const auto& current = paths[index];
    if (previous.size() <= current.size() &&
        std::equal(previous.begin(), previous.end(), current.begin())) {
      SetError("INVALID_REQUEST", "Delete targets overlap or repeat.");
      return false;
    }
  }
  for (auto it = paths.rbegin(); it != paths.rend(); ++it) {
    CPDF_PageObjectHolder* holder = nullptr;
    std::optional<pdf_editor::PreparedFormPath> prepared;
    if (!PrepareObjectHolder(page.get(), *it, &holder, &prepared)) return false;
    auto* object = holder->GetPageObjectByIndex(it->back());
    if (!object || !holder->RemovePageObject(object)) {
      SetError("CORE_UNAVAILABLE", "The page object could not be deleted.");
      return false;
    }
    auto* identities = &metadata->pages[page_index].objects;
    for (size_t depth = 0; depth + 1 < it->size(); ++depth)
      identities = &(*identities)[(*it)[depth]].children;
    identities->erase(identities->begin() + static_cast<std::ptrdiff_t>(it->back()));
    if (prepared && !GenerateEditedObjectHolder(
            page.get(), prepared, "The edited Form could not be generated.")) return false;
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE", "The edited page could not be generated.");
    return false;
  }
  return true;
}

bool ApplyPagesRotate(FPDF_DOCUMENT pdf,
                      CandidateMetadata* metadata,
                      const EditCommand& command) {
  const int quarter_turns = static_cast<int>(command.values[0] / 90.0);
  for (const std::string& page_id : command.ids) {
    const std::optional<size_t> page_index = FindPageIndex(*metadata, page_id);
    if (!page_index ||
        *page_index > static_cast<size_t>(std::numeric_limits<int>::max())) {
      SetError("INVALID_REQUEST", "A page rotation target does not exist.");
      return false;
    }
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(*page_index)));
    if (!page.get()) {
      SetError("CORE_UNAVAILABLE", "The PDF page could not be loaded.");
      return false;
    }
    const int current = FPDFPage_GetRotation(page.get());
    if (current < 0) {
      SetError("CORE_UNAVAILABLE", "The page rotation could not be read.");
      return false;
    }
    FPDFPage_SetRotation(page.get(), (current + quarter_turns) % 4);
  }
  return true;
}

bool ApplyPagesCrop(FPDF_DOCUMENT pdf,
                    CandidateMetadata* metadata,
                    const EditCommand& command) {
  const Rect requested{command.values[0], command.values[1],
                       command.values[2], command.values[3]};
  for (const auto& page_id : command.ids) {
    const auto index = FindPageIndex(*metadata, page_id);
    if (!index || *index > static_cast<size_t>(std::numeric_limits<int>::max())) {
      SetError("INVALID_REQUEST", "The page crop target does not exist.");
      return false;
    }
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(*index)));
    CPDF_Page* native = page.get() ? CPDFPageFromFPDFPage(page.get()) : nullptr;
    if (!native) {
      SetError("CORE_UNAVAILABLE", "The page crop target could not be loaded.");
      return false;
    }
    const double user_unit = GetUserUnit(native);
    if (!RectFitsInside(requested, {0, 0, native->GetPageWidth() * user_unit,
                                     native->GetPageHeight() * user_unit})) {
      SetError("INVALID_REQUEST", "The crop rectangle must fit within every selected page.");
      return false;
    }
    Matrix to_page, to_pdf;
    if (!GetPageMatrices(page.get(), &to_page, &to_pdf)) return false;
    const Rect bounds = TransformBounds(requested.x, requested.y,
        requested.x + requested.width, requested.y + requested.height, to_pdf);
    if (bounds.width <= 0 || bounds.height <= 0 ||
        !std::isfinite(bounds.x + bounds.width + bounds.y + bounds.height) ||
        std::max({std::abs(bounds.x), std::abs(bounds.y), bounds.width, bounds.height}) >
            std::numeric_limits<float>::max()) {
      SetError("INVALID_REQUEST", "The PDF crop rectangle is invalid.");
      return false;
    }
    FPDFPage_SetCropBox(page.get(), static_cast<float>(bounds.x),
                        static_cast<float>(bounds.y),
                        static_cast<float>(bounds.x + bounds.width),
                        static_cast<float>(bounds.y + bounds.height));
  }
  return true;
}

void MigrateNumericDestination(CPDF_Document* doc, FPDF_DEST dest) {
  if (!doc || !dest) return;
  CPDF_Array* array = CPDFArrayFromFPDFDest(dest);
  if (!array || array->IsEmpty()) return;
  RetainPtr<const CPDF_Object> first = array->GetDirectObjectAt(0);
  if (first && first->IsNumber()) {
    const int page_index = first->GetInteger();
    if (page_index >= 0 && page_index < doc->GetPageCount()) {
      auto page_dict = doc->GetPageDictionary(page_index);
      if (page_dict && page_dict->GetObjNum() != 0) {
        array->SetNewAt<CPDF_Reference>(0, doc, page_dict->GetObjNum());
      }
    }
  }
}

FPDF_DEST ResolveAndMigrateDest(FPDF_DOCUMENT pdf,
                                CPDF_Document* doc,
                                FPDF_DEST direct_dest,
                                FPDF_ACTION action) {
  FPDF_DEST dest = direct_dest;
  if (!dest && action && FPDFAction_GetType(action) == PDFACTION_GOTO) {
    dest = FPDFAction_GetDest(pdf, action);
  }
  if (dest) {
    MigrateNumericDestination(doc, dest);
  }
  return dest;
}

bool OutlineTargetsDeletedPages(FPDF_DOCUMENT pdf,
                                CPDF_Document* doc,
                                const std::set<size_t>& deleted_indices) {
  std::set<FPDF_BOOKMARK> visited;
  std::vector<FPDF_BOOKMARK> pending;
  if (FPDF_BOOKMARK first = FPDFBookmark_GetFirstChild(pdf, nullptr)) {
    pending.push_back(first);
  }
  while (!pending.empty()) {
    FPDF_BOOKMARK bookmark = pending.back();
    pending.pop_back();
    if (!visited.insert(bookmark).second) continue;
    FPDF_DEST dest = ResolveAndMigrateDest(
        pdf, doc, FPDFBookmark_GetDest(pdf, bookmark),
        FPDFBookmark_GetAction(bookmark));
    if (dest) {
      const int target_index = FPDFDest_GetDestPageIndex(pdf, dest);
      if (target_index >= 0 &&
          deleted_indices.contains(static_cast<size_t>(target_index))) {
        return true;
      }
    }
    if (FPDF_BOOKMARK sibling = FPDFBookmark_GetNextSibling(pdf, bookmark)) {
      pending.push_back(sibling);
    }
    if (FPDF_BOOKMARK child = FPDFBookmark_GetFirstChild(pdf, bookmark)) {
      pending.push_back(child);
    }
  }
  return false;
}

bool SurvivingPageLinksTargetDeletedPages(
    FPDF_DOCUMENT pdf,
    CPDF_Document* doc,
    size_t page_count,
    const std::set<size_t>& deleted_indices) {
  for (size_t p = 0; p < page_count; ++p) {
    if (deleted_indices.contains(p)) continue;
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(p)));
    if (!page.get()) continue;
    int link_pos = 0;
    FPDF_LINK link = nullptr;
    while (FPDFLink_Enumerate(page.get(), &link_pos, &link)) {
      if (!link) continue;
      FPDF_DEST dest = ResolveAndMigrateDest(
          pdf, doc, FPDFLink_GetDest(pdf, link),
          FPDFLink_GetAction(link));
      if (dest) {
        const int target_index = FPDFDest_GetDestPageIndex(pdf, dest);
        if (target_index >= 0 &&
            deleted_indices.contains(static_cast<size_t>(target_index))) {
          return true;
        }
      }
    }
  }
  return false;
}

void MigrateAllDestinations(FPDF_DOCUMENT pdf) {
  CPDF_Document* doc = CPDFDocumentFromFPDFDocument(pdf);
  if (!doc) return;
  std::set<size_t> empty_set;
  OutlineTargetsDeletedPages(pdf, doc, empty_set);
  SurvivingPageLinksTargetDeletedPages(pdf, doc, static_cast<size_t>(doc->GetPageCount()), empty_set);
}

bool ApplyPagesDelete(FPDF_DOCUMENT pdf,
                      CandidateMetadata* metadata,
                      const EditCommand& command) {
  if (command.ids.size() >= metadata->pages.size()) {
    SetError("INVALID_REQUEST",
             "A PDF document must retain at least one page.");
    return false;
  }
  CPDF_Document* native_doc = CPDFDocumentFromFPDFDocument(pdf);
  if (!native_doc) {
    SetUnexpectedError();
    return false;
  }
  const auto* root = native_doc->GetRoot();
  if (root && root->KeyExist("StructTreeRoot")) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Deleting pages from a tagged PDF is not supported without structure remapping.");
    return false;
  }

  std::vector<size_t> indices;
  std::set<size_t> deleted_set;
  for (const std::string& page_id : command.ids) {
    const std::optional<size_t> index = FindPageIndex(*metadata, page_id);
    if (!index) {
      SetError("INVALID_REQUEST", "A page deletion target does not exist.");
      return false;
    }
    if (!deleted_set.insert(*index).second) {
      SetError("INVALID_REQUEST", "Page deletion request contains duplicate page IDs.");
      return false;
    }
    indices.push_back(*index);
  }

  for (size_t index : indices) {
    const auto page_dict = native_doc->GetPageDictionary(static_cast<int>(index));
    if (page_dict && page_dict->KeyExist("StructParents")) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Deleting tagged pages is not supported without structure remapping.");
      return false;
    }
  }

  if (OutlineTargetsDeletedPages(pdf, native_doc, deleted_set)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Deleting pages referenced by document bookmarks is not supported.");
    return false;
  }

  if (SurvivingPageLinksTargetDeletedPages(pdf, native_doc, metadata->pages.size(), deleted_set)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Deleting pages referenced by surviving link annotations is not supported.");
    return false;
  }

  std::sort(indices.rbegin(), indices.rend());
  for (size_t index : indices) {
    FPDFPage_Delete(pdf, static_cast<int>(index));
    metadata->pages.erase(metadata->pages.begin() +
                          static_cast<std::ptrdiff_t>(index));
  }
  return true;
}

bool ApplyPagesReorder(FPDF_DOCUMENT pdf,
                       CandidateMetadata* metadata,
                       const EditCommand& command) {
  if (command.ids.size() != metadata->pages.size()) {
    SetError("INVALID_REQUEST",
             "Page reordering must include every current page exactly once.");
    return false;
  }
  MigrateAllDestinations(pdf);
  std::set<std::string> requested(command.ids.begin(), command.ids.end());
  if (requested.size() != command.ids.size()) {
    SetError("INVALID_REQUEST", "Page reordering contains duplicate IDs.");
    return false;
  }
  for (const PageIdentity& page : metadata->pages) {
    if (!requested.contains(page.id)) {
      SetError("INVALID_REQUEST",
               "Page reordering must include every current page exactly once.");
      return false;
    }
  }
  for (size_t target_index = 0; target_index < command.ids.size();
       ++target_index) {
    const std::optional<size_t> current_index =
        FindPageIndex(*metadata, command.ids[target_index]);
    if (!current_index) {
      SetUnexpectedError();
      return false;
    }
    if (*current_index == target_index) {
      continue;
    }
    const int move_index = static_cast<int>(*current_index);
    if (!FPDF_MovePages(pdf, &move_index, 1, static_cast<int>(target_index))) {
      SetError("CORE_UNAVAILABLE", "The PDF pages could not be reordered.");
      return false;
    }
    PageIdentity moved = std::move(metadata->pages[*current_index]);
    metadata->pages.erase(metadata->pages.begin() +
                          static_cast<std::ptrdiff_t>(*current_index));
    metadata->pages.insert(
        metadata->pages.begin() + static_cast<std::ptrdiff_t>(target_index),
        std::move(moved));
  }
  return true;
}

bool ApplyPageInsert(FPDF_DOCUMENT pdf,
                     CandidateMetadata* metadata,
                     const EditCommand& command) {
  if (MetadataContainsId(*metadata, command.page_id)) {
    SetError("INVALID_REQUEST", "The new page ID is already in use.");
    return false;
  }
  size_t index = 0;
  if (!command.target_id.empty()) {
    const std::optional<size_t> after =
        FindPageIndex(*metadata, command.target_id);
    if (!after) {
      SetError("INVALID_REQUEST",
               "The page insertion position does not exist.");
      return false;
    }
    index = *after + 1;
  }
  ScopedPage page(FPDFPage_New(pdf, static_cast<int>(index), command.values[0],
                               command.values[1]));
  if (!page.get()) {
    SetError("CORE_UNAVAILABLE", "The new PDF page could not be created.");
    return false;
  }
  PageIdentity identity;
  identity.id = command.page_id;
  metadata->pages.insert(
      metadata->pages.begin() + static_cast<std::ptrdiff_t>(index),
      std::move(identity));
  return true;
}

struct SnapshotPdfWriter : FPDF_FILEWRITE {
  SnapshotPdfWriter() {
    version = 1;
    WriteBlock = [](FPDF_FILEWRITE* self, const void* data,
                    unsigned long size) -> int {
      auto* writer = static_cast<SnapshotPdfWriter*>(self);
      if (writer->failed ||
          size > std::numeric_limits<uint32_t>::max() - writer->bytes.size()) {
        writer->failed = true;
        return 0;
      }
      try {
        const uint8_t* first = static_cast<const uint8_t*>(data);
        writer->bytes.insert(writer->bytes.end(), first, first + size);
      } catch (...) {
        writer->failed = true;
        return 0;
      }
      return 1;
    };
  }

  std::vector<uint8_t> bytes;
  bool failed = false;
};

bool SaveCandidateSnapshot(FPDF_DOCUMENT pdf, std::vector<uint8_t>* bytes) {
  SnapshotPdfWriter writer;
  if (!FPDF_SaveAsCopy(pdf, &writer, FPDF_NO_INCREMENTAL) || writer.failed ||
      writer.bytes.empty()) {
    SetError(
        "CORE_UNAVAILABLE",
        "The current PDF state could not be snapshotted for page duplication.");
    return false;
  }
  bytes->swap(writer.bytes);
  return true;
}

bool ValidateImportedPageFeatures(FPDF_DOCUMENT source, int page_index) {
  ScopedPage page(FPDF_LoadPage(source, page_index));
  CPDF_Page* native_page =
      page.get() ? CPDFPageFromFPDFPage(page.get()) : nullptr;
  RetainPtr<const CPDF_Dictionary> page_dict =
      native_page ? native_page->GetDict() : nullptr;
  if (!page_dict) {
    SetError("CORE_UNAVAILABLE", "The source PDF page could not be inspected.");
    return false;
  }
  if (page_dict->KeyExist("StructParents")) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Tagged-PDF structure links are not imported with pages yet.");
    return false;
  }
  RetainPtr<const CPDF_Array> annotations = page_dict->GetArrayFor("Annots");
  if (!annotations) {
    return true;
  }
  for (size_t index = 0; index < annotations->size(); ++index) {
    RetainPtr<const CPDF_Dictionary> annotation = annotations->GetDictAt(index);
    if (!annotation) {
      continue;
    }
    if (annotation->KeyExist("StructParent")) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Tagged annotation structure links are not imported yet.");
      return false;
    }
    const ByteString subtype = annotation->GetNameFor("Subtype");
    if (subtype == "Link") {
      SetError("UNSUPPORTED_CAPABILITY",
               "Page links are not duplicated or imported yet.");
      return false;
    }
    if (subtype == "Widget") {
      SetError("UNSUPPORTED_CAPABILITY",
               "AcroForm widgets are not duplicated or imported yet.");
      return false;
    }
  }
  return true;
}

bool ObjectTreeHasStructureLink(CPDF_PageObject* object,
                                size_t depth,
                                bool* has_structure_link);

bool ValidateExtractablePageFeatures(FPDF_DOCUMENT source, int page_index) {
  if (!ValidateImportedPageFeatures(source, page_index)) return false;
  ScopedPage parsed(FPDF_LoadPage(source, page_index));
  if (!parsed.get()) { SetUnexpectedError(); return false; }
  const int count = FPDFPage_CountObjects(parsed.get());
  if (count < 0) { SetUnexpectedError(); return false; }
  for (int index = 0; index < count; ++index) {
    bool linked = false;
    if (!ObjectTreeHasStructureLink(
            CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(parsed.get(), index)),
            0, &linked)) return false;
    if (linked) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Tagged page content cannot be extracted without structure remapping.");
      return false;
    }
  }
  CPDF_Document* native = CPDFDocumentFromFPDFDocument(source);
  const auto page = native ? native->GetPageDictionary(page_index) : nullptr;
  if (!page) { SetUnexpectedError(); return false; }
  if (page->KeyExist("StructParent") || page->KeyExist("AA")) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Page structure links or actions cannot be extracted safely.");
    return false;
  }
  const auto annotations = page->GetArrayFor("Annots");
  if (page->KeyExist("Annots") && !annotations) {
    SetError("UNSUPPORTED_CAPABILITY", "The page annotation list is malformed.");
    return false;
  }
  if (!annotations) return true;
  constexpr const char* kOrdinaryAnnotations[] = {
      "Text", "FreeText", "Line", "Square", "Circle", "Polygon", "PolyLine",
      "Highlight", "Underline", "Squiggly", "StrikeOut", "Stamp", "Caret", "Ink"};
  for (size_t index = 0; index < annotations->size(); ++index) {
    const auto annotation = annotations->GetDictAt(index);
    const ByteString subtype = annotation ? annotation->GetNameFor("Subtype") : ByteString();
    if (!annotation || !std::any_of(std::begin(kOrdinaryAnnotations),
                                    std::end(kOrdinaryAnnotations),
                                    [&](const char* allowed) { return subtype == allowed; }) ||
        annotation->KeyExist("A") || annotation->KeyExist("AA") ||
        annotation->KeyExist("Dest") || annotation->KeyExist("IRT") ||
        annotation->KeyExist("Popup") || annotation->KeyExist("Parent") ||
        (annotation->KeyExist("P") &&
         annotation->GetDictFor("P").Get() != page.Get())) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Interactive or cross-linked annotations cannot be extracted safely.");
      return false;
    }
  }
  return true;
}

bool AssignImportedAnnotationIds(const Document& document,
                                 FPDF_DOCUMENT pdf,
                                 size_t insertion_index,
                                 const std::vector<std::string>& new_page_ids) {
  CPDF_Document* native = CPDFDocumentFromFPDFDocument(pdf);
  if (!native) { SetUnexpectedError(); return false; }
  std::set<std::string> used;
  for (int page_index = 0; page_index < native->GetPageCount(); ++page_index) {
    const size_t index = static_cast<size_t>(page_index);
    if (index >= insertion_index && index < insertion_index + new_page_ids.size()) continue;
    const auto page = native->GetPageDictionary(page_index);
    const auto annots = page ? page->GetArrayFor("Annots") : nullptr;
    if (!annots) continue;
    for (size_t offset = 0; offset < annots->size(); ++offset) {
      const auto annot = annots->GetDictAt(offset);
      if (!annot) continue;
      const ByteString name = annot->GetUnicodeTextFor("NM").ToUTF8();
      if (!name.IsEmpty()) used.emplace(name.c_str(), name.GetLength());
    }
  }
  for (size_t offset = 0; offset < new_page_ids.size(); ++offset) {
    auto page = native->GetMutablePageDictionary(static_cast<int>(insertion_index + offset));
    auto annots = page ? page->GetMutableArrayFor("Annots") : nullptr;
    if (!annots) continue;
    for (size_t index = 0; index < annots->size(); ++index) {
      auto annot = annots->GetMutableDictAt(index);
      if (!annot) continue;
      if (annot->GetNameFor("Subtype") == "Widget" || annot->KeyExist("StructParent")) {
        SetError("UNSUPPORTED_CAPABILITY", "Widget or tagged annotation imports need structure remapping.");
        return false;
      }
      const std::string id = "a:" + std::to_string(document.session_id) +
          ":g:" + std::to_string(StableIdHash(new_page_ids[offset])) + ":" +
          std::to_string(index);
      if (!used.insert(id).second) {
        SetError("INVALID_REQUEST", "An imported annotation ID collides with an existing annotation.");
        return false;
      }
      const WideString wide = WideString::FromUTF8(ByteStringView(id));
      annot->SetNewFor<CPDF_String>("NM", wide.AsStringView());
    }
  }
  return true;
}

bool ApplyImportedPages(const Document& document,
                        FPDF_DOCUMENT pdf,
                        CandidateMetadata* metadata,
                        FPDF_DOCUMENT source,
                        const std::vector<int>& source_indices,
                        const std::vector<std::string>& new_page_ids,
                        const std::string& after_page_id,
                        bool duplicate_within_document) {
  if (source_indices.empty() || source_indices.size() != new_page_ids.size()) {
    SetError("INVALID_REQUEST",
             "A non-empty page import pair list is required.");
    return false;
  }
  size_t insertion_index = 0;
  if (!after_page_id.empty()) {
    const std::optional<size_t> after = FindPageIndex(*metadata, after_page_id);
    if (!after) {
      SetError("INVALID_REQUEST",
               "The page insertion position does not exist.");
      return false;
    }
    insertion_index = *after + 1;
  }
  if (insertion_index > static_cast<size_t>(std::numeric_limits<int>::max())) {
    SetError("RESOURCE_LIMIT", "The page import request is too large.");
    return false;
  }
  CPDF_Document* native_source = CPDFDocumentFromFPDFDocument(source);
  const CPDF_Dictionary* source_root =
      native_source ? native_source->GetRoot() : nullptr;
  if (!source_root) {
    SetError("CORE_UNAVAILABLE", "The source PDF catalog is unavailable.");
    return false;
  }
  if (!duplicate_within_document && source_root->KeyExist("Outlines")) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Importing bookmarks from another PDF is not supported yet.");
    return false;
  }
  const int source_page_count = FPDF_GetPageCount(source);
  std::set<std::string> requested_ids;
  for (size_t index = 0; index < source_indices.size(); ++index) {
    if (source_indices[index] < 0 ||
        source_indices[index] >= source_page_count) {
      SetError("INVALID_REQUEST", "A source page index is out of range.");
      return false;
    }
    if (MetadataContainsId(*metadata, new_page_ids[index]) ||
        !requested_ids.insert(new_page_ids[index]).second) {
      SetError("INVALID_REQUEST", "A new page ID is already in use.");
      return false;
    }
    if (!ValidateImportedPageFeatures(source, source_indices[index])) {
      return false;
    }
  }
  if (!FPDF_ImportPagesByIndex(
          pdf, source, source_indices.data(),
          static_cast<unsigned long>(source_indices.size()),
          static_cast<int>(insertion_index))) {
    SetError("CORE_UNAVAILABLE", "The PDF pages could not be imported.");
    return false;
  }
  if (!AssignImportedAnnotationIds(document, pdf, insertion_index, new_page_ids))
    return false;
  for (size_t offset = 0; offset < new_page_ids.size(); ++offset) {
    PageIdentity identity;
    if (!BuildGeneratedPageIdentity(document, pdf, insertion_index + offset,
                                    new_page_ids[offset], *metadata,
                                    &identity)) {
      return false;
    }
    ScopedPage copied(FPDF_LoadPage(pdf, static_cast<int>(insertion_index + offset)));
    if (!copied.get()) { SetUnexpectedError(); return false; }
    bool rewritten_group = false;
    for (size_t index = 0; index < identity.objects.size(); ++index) {
      FPDF_PAGEOBJECT object = FPDFPage_GetObject(copied.get(), static_cast<int>(index));
      if (GroupMetadata(object)) {
        if (!RewriteGroupMetadata(object, identity.objects[index])) return false;
        rewritten_group = true;
      }
    }
    if (rewritten_group && !FPDFPage_GenerateContent(copied.get())) {
      SetError("CORE_UNAVAILABLE", "The copied group page could not be generated.");
      return false;
    }
    metadata->pages.insert(
        metadata->pages.begin() +
            static_cast<std::ptrdiff_t>(insertion_index + offset),
        std::move(identity));
  }
  return true;
}

bool ApplyPagesDuplicate(const Document& document,
                         FPDF_DOCUMENT pdf,
                         CandidateMetadata* metadata,
                         const EditCommand& command) {
  std::vector<int> source_indices;
  std::vector<std::string> new_page_ids;
  source_indices.reserve(command.ids.size() / 2);
  new_page_ids.reserve(command.ids.size() / 2);
  for (size_t index = 0; index < command.ids.size(); index += 2) {
    const std::optional<size_t> source_index =
        FindPageIndex(*metadata, command.ids[index]);
    if (!source_index ||
        *source_index > static_cast<size_t>(std::numeric_limits<int>::max())) {
      SetError("INVALID_REQUEST", "A page duplication source does not exist.");
      return false;
    }
    source_indices.push_back(static_cast<int>(*source_index));
    new_page_ids.push_back(command.ids[index + 1]);
  }
  std::vector<uint8_t> snapshot_bytes;
  if (!SaveCandidateSnapshot(pdf, &snapshot_bytes)) {
    return false;
  }
  ScopedDocument source(FPDF_LoadMemDocument64(snapshot_bytes.data(),
      snapshot_bytes.size(), document.source_password.empty()
                                 ? nullptr : document.source_password.c_str()));
  if (!source.get()) {
    SetError(
        "CORE_UNAVAILABLE",
        "The current PDF state could not be reopened for page duplication.");
    return false;
  }
  return ApplyImportedPages(document, pdf, metadata, source.get(),
                            source_indices, new_page_ids, command.target_id, true);
}

bool ParseSourcePageIndex(std::string_view value, uint32_t* result) {
  if (value.empty()) {
    SetError("INVALID_REQUEST", "A source page index is required.");
    return false;
  }
  uint32_t parsed = 0;
  const auto conversion =
      std::from_chars(value.data(), value.data() + value.size(), parsed, 10);
  if (conversion.ec != std::errc() ||
      conversion.ptr != value.data() + value.size()) {
    SetError("INVALID_REQUEST",
             "Source page indices must be zero-based decimal strings.");
    return false;
  }
  *result = parsed;
  return true;
}

bool ApplyPagesImport(const Document& document,
                      FPDF_DOCUMENT pdf,
                      CandidateMetadata* metadata,
                      const EditCommand& command) {
  const auto resource = document.pdf_resources.find(command.resource_id);
  if (resource == document.pdf_resources.end()) {
    SetError("INVALID_REQUEST", "The PDF page resource is not registered.");
    return false;
  }
  ScopedDocument source(FPDF_LoadMemDocument64(
      resource->second->bytes.data(), resource->second->bytes.size(), nullptr));
  if (!source.get()) {
    SetError("CORE_UNAVAILABLE",
             "The immutable PDF resource could not be reopened.");
    return false;
  }
  std::vector<int> source_indices;
  std::vector<std::string> new_page_ids;
  source_indices.reserve(command.ids.size() / 2);
  new_page_ids.reserve(command.ids.size() / 2);
  for (size_t index = 0; index < command.ids.size(); index += 2) {
    uint32_t source_index = 0;
    if (!ParseSourcePageIndex(command.ids[index], &source_index) ||
        source_index > static_cast<uint32_t>(std::numeric_limits<int>::max())) {
      if (g_error_code.empty()) {
        SetError("INVALID_REQUEST", "A source page index is out of range.");
      }
      return false;
    }
    source_indices.push_back(static_cast<int>(source_index));
    new_page_ids.push_back(command.ids[index + 1]);
  }
  return ApplyImportedPages(document, pdf, metadata, source.get(),
                            source_indices, new_page_ids, command.target_id, false);
}

std::unique_ptr<CPDF_PageObject> CreateImagePageObject(
    FPDF_DOCUMENT pdf,
    const ImageResource& image) {
  std::vector<uint8_t> bgra(image.rgba.size());
  for (size_t offset = 0; offset < image.rgba.size(); offset += 4) {
    bgra[offset] = image.rgba[offset + 2];
    bgra[offset + 1] = image.rgba[offset + 1];
    bgra[offset + 2] = image.rgba[offset];
    bgra[offset + 3] = image.rgba[offset + 3];
  }
  const uint64_t stride64 = static_cast<uint64_t>(image.width) * 4;
  if (image.width > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      image.height > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
      stride64 > static_cast<uint64_t>(std::numeric_limits<int>::max())) {
    SetError("RESOURCE_LIMIT", "The RGBA image dimensions are too large.");
    return nullptr;
  }
  ScopedBitmap bitmap(FPDFBitmap_CreateEx(
      static_cast<int>(image.width), static_cast<int>(image.height),
      FPDFBitmap_BGRA, bgra.data(), static_cast<int>(stride64)));
  FPDF_PAGEOBJECT handle = FPDFPageObj_NewImageObj(pdf);
  if (!bitmap.get() || !handle) {
    if (handle) {
      FPDFPageObj_Destroy(handle);
    }
    SetAllocationError();
    return nullptr;
  }
  if (!FPDFImageObj_SetBitmap(nullptr, 0, handle, bitmap.get())) {
    FPDFPageObj_Destroy(handle);
    SetError("CORE_UNAVAILABLE", "The RGBA image could not be embedded.");
    return nullptr;
  }
  return std::unique_ptr<CPDF_PageObject>(
      CPDFPageObjectFromFPDFPageObject(handle));
}

void CopyCommonObjectState(const CPDF_PageObject& source,
                           CPDF_PageObject* target) {
  target->mutable_graph_state() = source.graph_state();
  target->mutable_color_state() = source.color_state();
  target->mutable_text_state() = source.text_state();
  target->mutable_general_state() = source.general_state();
  target->mutable_clip_path() = source.clip_path();
  const CPDF_ContentMarks* source_marks = source.GetContentMarks();
  CPDF_ContentMarks* target_marks = target->GetContentMarks();
  for (size_t index = 0; index < source_marks->CountItems(); ++index) {
    const CPDF_ContentMarkItem* item = source_marks->GetItem(index);
    RetainPtr<const CPDF_Dictionary> params = item->GetParam();
    if (!params) {
      target_marks->AddMark(item->GetName());
      continue;
    }
    target_marks->AddMarkWithDirectDict(item->GetName(),
                                        ToDictionary(params->Clone()));
  }
  target->SetResourceName(source.GetResourceName());
  target->SetOriginalRect(source.GetOriginalRect());
  target->SetRect(source.GetRect());
  target->SetIsActive(source.IsActive());
  target->SetContentStream(CPDF_PageObject::kNoContentStream);
  target->SetDirty(true);
}

bool ApplyImageInsert(const Document& document,
                      FPDF_DOCUMENT pdf,
                      CandidateMetadata* metadata,
                      const EditCommand& command) {
  const auto resource = document.image_resources.find(command.resource_id);
  if (resource == document.image_resources.end()) {
    SetError("INVALID_REQUEST", "The RGBA image resource is not registered.");
    return false;
  }
  if (MetadataContainsId(*metadata, command.target_id)) {
    SetError("INVALID_REQUEST", "The new image object ID is already in use.");
    return false;
  }
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  std::unique_ptr<CPDF_PageObject> owned_object =
      CreateImagePageObject(pdf, *resource->second);
  if (!owned_object) {
    return false;
  }
  FPDF_PAGEOBJECT object = FPDFPageObjectFromCPDFPageObject(owned_object.get());
  const Matrix image_to_page{command.values[2],
                             0,
                             0,
                             -command.values[3],
                             command.values[0],
                             command.values[1] + command.values[3]};
  if (!SetObjectMatrix(page.get(), object, image_to_page)) {
    return false;
  }
  ObjectIdentity identity;
  identity.id = command.target_id;
  if (!AddTopLevelIdentity(
          &metadata->pages[page_index], std::move(identity), page.get(),
          FPDFPageObjectFromCPDFPageObject(owned_object.release())) ||
      !FPDFPage_GenerateContent(page.get())) {
    if (g_error_code.empty()) {
      SetError("CORE_UNAVAILABLE",
               "The image page content could not be generated.");
    }
    return false;
  }
  return true;
}

class ScopedXObject {
 public:
  explicit ScopedXObject(FPDF_XOBJECT value) : value_(value) {}
  ~ScopedXObject() {
    if (value_) {
      FPDF_CloseXObject(value_);
    }
  }
  FPDF_XOBJECT get() const { return value_; }

 private:
  FPDF_XOBJECT value_;
};

bool ApplyContentInsert(const Document& document,
                        FPDF_DOCUMENT pdf,
                        CandidateMetadata* metadata,
                        const EditCommand& command) {
  const auto resource = document.pdf_resources.find(command.resource_id);
  if (resource == document.pdf_resources.end()) {
    SetError("INVALID_REQUEST", "The PDF content resource is not registered.");
    return false;
  }
  if (command.resource_page_index >= resource->second->page_count ||
      command.resource_page_index >
          static_cast<uint32_t>(std::numeric_limits<int>::max())) {
    SetError("INVALID_REQUEST", "The PDF resource page index is out of range.");
    return false;
  }
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  ScopedDocument source(FPDF_LoadMemDocument64(
      resource->second->bytes.data(), resource->second->bytes.size(), nullptr));
  if (!source.get()) {
    SetError("CORE_UNAVAILABLE",
             "The immutable PDF resource could not be reopened.");
    return false;
  }
  ScopedXObject xobject(FPDF_NewXObjectFromPage(
      pdf, source.get(), static_cast<int>(command.resource_page_index)));
  if (!xobject.get()) {
    SetError("CORE_UNAVAILABLE",
             "The PDF resource page could not be imported.");
    return false;
  }
  FPDF_PAGEOBJECT object = FPDF_NewFormObjectFromXObject(xobject.get());
  if (!object) {
    SetError("CORE_UNAVAILABLE",
             "The imported Form XObject could not be created.");
    return false;
  }
  // NewFormObjectFromXObject leaves the ink bounds uninitialized. More
  // importantly, insertion fits the source PAGE, including its margins, not
  // the union of its glyph/path ink. The imported Form already carries the
  // source page's CropBox/rotation matrix in its dictionary.
  ScopedPage source_page(FPDF_LoadPage(
      source.get(), static_cast<int>(command.resource_page_index)));
  const double source_width =
      source_page.get() ? FPDF_GetPageWidthF(source_page.get()) : 0;
  const double source_height =
      source_page.get() ? FPDF_GetPageHeightF(source_page.get()) : 0;
  if (!std::isfinite(source_width) || !std::isfinite(source_height) ||
      source_width <= 0 || source_height <= 0) {
    FPDFPageObj_Destroy(object);
    SetError("INVALID_REQUEST",
             "The PDF resource page has invalid dimensions.");
    return false;
  }
  const double scale_x = command.values[2] / source_width;
  const double scale_y = command.values[3] / source_height;
  const Matrix form_to_page{scale_x,
                            0,
                            0,
                            -scale_y,
                            command.values[0],
                            command.values[1] + command.values[3]};
  if (!SetObjectMatrix(page.get(), object, form_to_page)) {
    FPDFPageObj_Destroy(object);
    return false;
  }
  ObjectIdentity identity;
  identity.id = command.target_id;
  const int child_count = FPDFFormObj_CountObjects(object);
  if (child_count < 0) {
    FPDFPageObj_Destroy(object);
    SetUnexpectedError();
    return false;
  }
  identity.children.resize(static_cast<size_t>(child_count));
  uint64_t next_child_ordinal = 0;
  for (int index = 0; index < child_count; ++index) {
    FPDF_PAGEOBJECT child =
        FPDFFormObj_GetObject(object, static_cast<unsigned long>(index));
    if (!child ||
        !BuildGeneratedObjectIdentity(
            document, command.target_id, child, 1, &next_child_ordinal,
            &identity.children[static_cast<size_t>(index)])) {
      FPDFPageObj_Destroy(object);
      if (g_error_code.empty()) {
        SetUnexpectedError();
      }
      return false;
    }
  }
  std::set<std::string> inserted_ids;
  if (IdentityTreeHasCollision(identity, *metadata, &inserted_ids)) {
    FPDFPageObj_Destroy(object);
    SetError(
        "INVALID_REQUEST",
        "The inserted Form XObject identity collides with an existing ID.");
    return false;
  }
  if (!AddTopLevelIdentity(&metadata->pages[page_index], std::move(identity),
                           page.get(), object) ||
      !FPDFPage_GenerateContent(page.get())) {
    if (g_error_code.empty()) {
      SetError("CORE_UNAVAILABLE",
               "The imported Form XObject content could not be generated.");
    }
    return false;
  }
  return true;
}

bool GetContainingHolderToPdf(FPDF_PAGE page,
                              const std::vector<size_t>& object_path,
                              Matrix* holder_to_pdf) {
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page || object_path.empty()) {
    SetUnexpectedError();
    return false;
  }
  CPDF_PageObjectHolder* holder = native_page;
  Matrix result;
  for (size_t depth = 0; depth + 1 < object_path.size(); ++depth) {
    if (object_path[depth] >= holder->GetPageObjectCount()) {
      SetError("CORE_UNAVAILABLE", "The nested Form object path is invalid.");
      return false;
    }
    CPDF_PageObject* object = holder->GetPageObjectByIndex(object_path[depth]);
    CPDF_FormObject* form = object ? object->AsForm() : nullptr;
    if (!form) {
      SetError("CORE_UNAVAILABLE", "The nested Form object path is invalid.");
      return false;
    }
    result = MatrixFromCfx(form->form_matrix()).Then(result);
    holder = form->form();
  }
  *holder_to_pdf = result;
  return true;
}

bool ApplyImageReplace(const Document& document,
                       FPDF_DOCUMENT pdf,
                       CandidateMetadata* metadata,
                       const EditCommand& command) {
  const auto resource = document.image_resources.find(command.resource_id);
  if (resource == document.image_resources.end()) {
    SetError("INVALID_REQUEST",
             "The replacement RGBA image is not registered.");
    return false;
  }
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  ObjectTarget target;
  if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                        command.target_id, false, &target)) {
    return false;
  }
  CPDF_PageObject* source = CPDFPageObjectFromFPDFPageObject(target.object);
  CPDF_ImageObject* source_image = source ? source->AsImage() : nullptr;
  if (!source_image) {
    SetError("INVALID_REQUEST",
             "The image replacement target is not an image.");
    return false;
  }
  CPDF_PageObjectHolder* holder = nullptr;
  std::optional<pdf_editor::PreparedFormPath> prepared_path;
  if (!PrepareObjectHolder(page.get(), target.path, &holder, &prepared_path)) {
    return false;
  }
  std::unique_ptr<CPDF_PageObject> replacement =
      CreateImagePageObject(pdf, *resource->second);
  if (!replacement) {
    return false;
  }
  CopyCommonObjectState(*source, replacement.get());
  replacement->AsImage()->SetImageMatrix(source_image->matrix());
  const size_t object_index = target.path.back();
  std::unique_ptr<CPDF_PageObject> removed = holder->RemovePageObject(source);
  if (!removed ||
      !holder->InsertPageObjectAtIndex(object_index, std::move(replacement))) {
    SetError("CORE_UNAVAILABLE",
             "The image object could not be replaced in its drawing layer.");
    return false;
  }
  return GenerateEditedObjectHolder(
      page.get(), prepared_path,
      "The image replacement page content could not be generated.");
}

bool ApplyImageCrop(FPDF_DOCUMENT pdf,
                    CandidateMetadata* metadata,
                    const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  ObjectTarget target;
  if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                        command.target_id, false, &target)) {
    return false;
  }
  CPDF_PageObject* object = CPDFPageObjectFromFPDFPageObject(target.object);
  if (!object || !object->AsImage()) {
    SetError("INVALID_REQUEST", "The crop target is not an image.");
    return false;
  }
  Matrix pdf_to_page;
  Matrix page_to_pdf;
  Matrix holder_to_pdf;
  if (!GetPageMatrices(page.get(), &pdf_to_page, &page_to_pdf) ||
      !GetContainingHolderToPdf(page.get(), target.path, &holder_to_pdf)) {
    return false;
  }
  (void)pdf_to_page;
  const std::optional<Matrix> pdf_to_holder = InverseMatrix(holder_to_pdf);
  if (!pdf_to_holder) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The containing Form transform is not invertible for cropping.");
    return false;
  }
  const Matrix page_to_holder = page_to_pdf.Then(*pdf_to_holder);
  const double left = command.values[0];
  const double top = command.values[1];
  const double right = left + command.values[2];
  const double bottom = top + command.values[3];
  const std::array<std::array<double, 2>, 4> points = {
      page_to_holder.Apply(left, top), page_to_holder.Apply(right, top),
      page_to_holder.Apply(right, bottom), page_to_holder.Apply(left, bottom)};

  CPDF_PageObjectHolder* holder = nullptr;
  std::optional<pdf_editor::PreparedFormPath> prepared_path;
  if (!PrepareObjectHolder(page.get(), target.path, &holder, &prepared_path)) {
    return false;
  }
  (void)holder;
  CPDF_Path crop_path;
  crop_path.Emplace();
  crop_path.AppendPoint(CFX_PointF(static_cast<float>(points[0][0]),
                                   static_cast<float>(points[0][1])),
                        CFX_Path::Point::Type::kMove);
  crop_path.AppendPoint(CFX_PointF(static_cast<float>(points[1][0]),
                                   static_cast<float>(points[1][1])),
                        CFX_Path::Point::Type::kLine);
  crop_path.AppendPoint(CFX_PointF(static_cast<float>(points[2][0]),
                                   static_cast<float>(points[2][1])),
                        CFX_Path::Point::Type::kLine);
  crop_path.AppendPointAndClose(CFX_PointF(static_cast<float>(points[3][0]),
                                           static_cast<float>(points[3][1])),
                                CFX_Path::Point::Type::kLine);
  CPDF_ClipPath& clip_path = object->mutable_clip_path();
  if (!clip_path.HasRef()) {
    clip_path.Emplace();
  }
  clip_path.AppendPath(std::move(crop_path),
                       CFX_FillRenderOptions::FillType::kWinding);
  object->SetDirty(true);
  return GenerateEditedObjectHolder(
      page.get(), prepared_path,
      "The cropped image page content could not be generated.");
}

bool ObjectTreeHasStructureLink(CPDF_PageObject* object,
                                size_t depth,
                                bool* has_structure_link) {
  if (!object || depth > kMaxObjectDepth) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The page object nesting is too complex to copy safely.");
    return false;
  }
  if (object->GetContentMarks()->GetMarkedContentID() >= 0) {
    *has_structure_link = true;
    return true;
  }
  CPDF_FormObject* form = object->AsForm();
  if (!form) {
    return true;
  }
  if (form->form()->GetDict()->KeyExist("StructParent") ||
      form->form()->GetDict()->KeyExist("StructParents")) {
    *has_structure_link = true;
    return true;
  }
  for (const auto& child : *form->form()) {
    if (!ObjectTreeHasStructureLink(child.get(), depth + 1,
                                    has_structure_link)) {
      return false;
    }
    if (*has_structure_link) {
      return true;
    }
  }
  return true;
}

std::unique_ptr<CPDF_PageObject> CloneTopLevelObject(CPDF_PageObject* source) {
  if (!source || !source->IsActive()) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Inactive page objects cannot be copied.");
    return nullptr;
  }
  bool has_structure_link = false;
  if (!ObjectTreeHasStructureLink(source, 0, &has_structure_link)) {
    return nullptr;
  }
  if (has_structure_link) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Tagged-PDF structure links are not copied with objects yet.");
    return nullptr;
  }
  std::unique_ptr<CPDF_PageObject> clone;
  switch (source->GetType()) {
    case CPDF_PageObject::Type::kText:
      clone = source->AsText()->Clone();
      if (clone) {
        CopyCommonObjectState(*source, clone.get());
      }
      break;
    case CPDF_PageObject::Type::kImage: {
      auto image = std::make_unique<CPDF_ImageObject>();
      CopyCommonObjectState(*source, image.get());
      image->SetImage(source->AsImage()->GetImage());
      image->SetImageMatrix(source->AsImage()->matrix());
      clone = std::move(image);
      break;
    }
    case CPDF_PageObject::Type::kPath: {
      auto path = std::make_unique<CPDF_PathObject>();
      CopyCommonObjectState(*source, path.get());
      path->path() = source->AsPath()->path();
      path->set_stroke(source->AsPath()->stroke());
      path->set_filltype(source->AsPath()->filltype());
      path->SetPathMatrix(source->AsPath()->matrix());
      clone = std::move(path);
      break;
    }
    case CPDF_PageObject::Type::kForm: {
      CPDF_FormObject* source_form = source->AsForm();
      RetainPtr<CPDF_Stream> source_stream =
          source_form->form()->GetMutableStreamForEditing();
      auto form = std::make_unique<CPDF_Form>(
          source_form->form()->GetDocument(),
          source_form->form()->GetMutablePageResources(),
          std::move(source_stream));
      form->ParseContent();
      if (form->GetPageObjectCount() !=
          source_form->form()->GetPageObjectCount()) {
        SetError("UNSUPPORTED_CAPABILITY",
                 "The Form XObject could not be cloned with stable children.");
        return nullptr;
      }
      auto form_object = std::make_unique<CPDF_FormObject>(
          CPDF_PageObject::kNoContentStream, std::move(form),
          source_form->form_matrix());
      form_object->CalcBoundingBox();
      CopyCommonObjectState(*source, form_object.get());
      clone = std::move(form_object);
      break;
    }
    case CPDF_PageObject::Type::kShading:
      SetError("UNSUPPORTED_CAPABILITY",
               "Top-level shading objects cannot be copied yet.");
      return nullptr;
  }
  if (!clone) {
    SetUnexpectedError();
    return nullptr;
  }
  clone->SetContentStream(CPDF_PageObject::kNoContentStream);
  clone->SetDirty(true);
  return clone;
}

bool BuildCopiedObjectIdentity(const Document& document,
                               std::string_view new_id,
                               FPDF_PAGEOBJECT object,
                               ObjectIdentity* identity) {
  identity->id = std::string(new_id);
  const int type = FPDFPageObj_GetType(object);
  if (type == FPDF_PAGEOBJ_TEXT || ParagraphMetadata(object)) {
    identity->text_block_id = GeneratedTextBlockId(document, new_id, 0);
  }
  if (type != FPDF_PAGEOBJ_FORM) {
    return true;
  }
  const int child_count = FPDFFormObj_CountObjects(object);
  if (child_count < 0) {
    SetUnexpectedError();
    return false;
  }
  identity->children.resize(static_cast<size_t>(child_count));
  uint64_t next_ordinal = 0;
  for (int index = 0; index < child_count; ++index) {
    FPDF_PAGEOBJECT child =
        FPDFFormObj_GetObject(object, static_cast<unsigned long>(index));
    if (!child || !BuildGeneratedObjectIdentity(
                      document, new_id, child, 1, &next_ordinal,
                      &identity->children[static_cast<size_t>(index)])) {
      if (g_error_code.empty()) {
        SetUnexpectedError();
      }
      return false;
    }
  }
  return true;
}

bool ApplyObjectsCopy(const Document& document,
                      FPDF_DOCUMENT pdf,
                      CandidateMetadata* metadata,
                      const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) {
    return false;
  }
  struct PendingCopy {
    size_t source_index = 0;
    std::unique_ptr<CPDF_PageObject> object;
    ObjectIdentity identity;
  };
  std::vector<PendingCopy> copies;
  copies.reserve(command.ids.size() / 2);
  std::set<std::string> copied_ids;
  for (size_t pair = 0; pair < command.ids.size() / 2; ++pair) {
    const std::string& source_id = command.ids[pair * 2];
    const std::string& new_id = command.ids[pair * 2 + 1];
    ObjectTarget source;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], source_id,
                          false, &source)) {
      return false;
    }
    if (source.path.size() != 1) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Nested Form children cannot be copied independently yet.");
      return false;
    }
    const bool copying_group = GroupMetadata(source.object) != nullptr;
    if (MetadataContainsId(*metadata, new_id)) {
      SetError("INVALID_REQUEST", "A copied object ID is already in use.");
      return false;
    }
    std::unique_ptr<CPDF_PageObject> clone =
        CloneTopLevelObject(CPDFPageObjectFromFPDFPageObject(source.object));
    if (!clone) {
      return false;
    }
    ObjectIdentity identity;
    if (!BuildCopiedObjectIdentity(
            document, new_id, FPDFPageObjectFromCPDFPageObject(clone.get()),
            &identity) ||
        IdentityTreeHasCollision(identity, *metadata, &copied_ids)) {
      if (g_error_code.empty()) {
        SetError("INVALID_REQUEST",
                 "A copied object identity collides with an existing ID.");
      }
      return false;
    }
    if (copying_group &&
        !RewriteGroupMetadata(FPDFPageObjectFromCPDFPageObject(clone.get()), identity))
      return false;
    copies.push_back({source.path[0], std::move(clone), std::move(identity)});
  }
  std::stable_sort(copies.begin(), copies.end(),
                   [](const PendingCopy& left, const PendingCopy& right) {
                     return left.source_index < right.source_index;
                   });
  const Matrix translation{1, 0, 0, 1, command.values[0], command.values[1]};
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page.get());
  if (!native_page) {
    SetUnexpectedError();
    return false;
  }
  for (PendingCopy& copy : copies) {
    FPDF_PAGEOBJECT handle =
        FPDFPageObjectFromCPDFPageObject(copy.object.get());
    if (!ApplyNormalizedTransform(page.get(), handle, translation)) {
      return false;
    }
    native_page->AppendPageObject(std::move(copy.object));
    metadata->pages[page_index].objects.push_back(std::move(copy.identity));
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE",
             "The copied page objects could not be generated.");
    return false;
  }
  return true;
}

#include "document_commands.h"
#include "group_commands.h"

bool ApplyCommand(
    const Document& document,
    FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    const std::set<std::string>* batch_new_ids,
    Rect* layout_bounds,
    bool* overflow,
    TextInsertLayoutResult* text_insert_layout,
    bool allow_text_insert_overflow) {
  switch (command.type) {
    case EditType::kTextReplace:
      return ApplyTextReplace(document, pdf, metadata, command, resources,
                              font_cache, layout_bounds, overflow, text_insert_layout);
    case EditType::kTextStyle:
      return ApplyTextStyle(document, pdf, metadata, command, resources,
                            font_cache, batch_new_ids);
    case EditType::kTextReflow:
      return ApplyParagraphInsert(document, pdf, metadata, command, resources,
                                  batch_new_ids, text_insert_layout, allow_text_insert_overflow);
    case EditType::kTextInsert:
      if (command.flags & kTextParagraphFlag)
        return ApplyParagraphInsert(document, pdf, metadata, command, resources,
                                    batch_new_ids, text_insert_layout, allow_text_insert_overflow);
      return ApplyTextInsert(document, pdf, metadata, command, resources,
                             font_cache, batch_new_ids, text_insert_layout,
                             allow_text_insert_overflow);
    case EditType::kObjectsTransform:
      return ApplyObjectsTransform(pdf, metadata, command);
    case EditType::kObjectsAlign:
      return ApplyObjectsAlign(pdf, metadata, command);
    case EditType::kObjectsDistribute:
      return ApplyObjectsDistribute(pdf, metadata, command);
    case EditType::kObjectsGroup:
      return ApplyObjectsGroup(document, pdf, metadata, command);
    case EditType::kObjectsUngroup:
      return ApplyObjectsUngroup(pdf, metadata, command);
    case EditType::kObjectsDelete:
      return ApplyObjectsDelete(pdf, metadata, command);
    case EditType::kPagesRotate:
      return ApplyPagesRotate(pdf, metadata, command);
    case EditType::kPagesCrop:
      return ApplyPagesCrop(pdf, metadata, command);
    case EditType::kPagesDelete:
      return ApplyPagesDelete(pdf, metadata, command);
    case EditType::kPagesReorder:
      return ApplyPagesReorder(pdf, metadata, command);
    case EditType::kPagesInsert:
      return ApplyPageInsert(pdf, metadata, command);
    case EditType::kImageInsert:
      return ApplyImageInsert(document, pdf, metadata, command);
    case EditType::kContentInsert:
      return ApplyContentInsert(document, pdf, metadata, command);
    case EditType::kPagesDuplicate:
      return ApplyPagesDuplicate(document, pdf, metadata, command);
    case EditType::kPagesImport:
      return ApplyPagesImport(document, pdf, metadata, command);
    case EditType::kImageReplace:
      return ApplyImageReplace(document, pdf, metadata, command);
    case EditType::kImageCrop:
      return ApplyImageCrop(pdf, metadata, command);
    case EditType::kObjectsCopy:
      return ApplyObjectsCopy(document, pdf, metadata, command);
    case EditType::kAnnotationAdd:
    case EditType::kAnnotationUpdate:
    case EditType::kAnnotationDelete:
    case EditType::kFormFill:
    case EditType::kFormCreate:
    case EditType::kFormUpdate:
      return ApplyDocumentTool(document, pdf, metadata, command, resources, font_cache);
  }
  SetError("UNSUPPORTED_CAPABILITY", "The edit command type is not supported.");
  return false;
}

bool ApplyTransactionToPdf(
    const Document& document,
    FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata,
    const EditTransaction& transaction,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    CandidateFontCache* font_cache,
    Rect* layout_bounds,
    bool* overflow,
    TextInsertLayoutResult* text_insert_layout,
    bool allow_text_insert_overflow) {
  std::set<std::string> batch_new_ids;
  for (const EditCommand& command : transaction.commands) {
    if (command.type == EditType::kPagesInsert) {
      batch_new_ids.insert(command.page_id);
    } else if (command.type == EditType::kTextInsert ||
               command.type == EditType::kImageInsert ||
               command.type == EditType::kContentInsert ||
               command.type == EditType::kAnnotationAdd ||
               command.type == EditType::kObjectsGroup ||
               command.type == EditType::kFormCreate ||
               command.type == EditType::kTextReflow) {
      batch_new_ids.insert(command.target_id);
    } else if (command.type == EditType::kPagesDuplicate ||
               command.type == EditType::kPagesImport ||
               command.type == EditType::kObjectsCopy) {
      for (size_t index = 1; index < command.ids.size(); index += 2) {
        batch_new_ids.insert(command.ids[index]);
      }
    }
  }
  for (size_t index = 0; index < transaction.commands.size(); ++index) {
    const bool single_command = transaction.commands.size() == 1;
    Rect* command_bounds =
        layout_bounds && single_command ? layout_bounds : nullptr;
    bool* command_overflow = overflow && single_command ? overflow : nullptr;
    TextInsertLayoutResult* command_insert_layout =
        text_insert_layout && single_command ? text_insert_layout : nullptr;
    if (!ApplyCommand(document, pdf, metadata, transaction.commands[index],
                      resources, font_cache, &batch_new_ids, command_bounds,
                      command_overflow, command_insert_layout,
                      command_insert_layout && allow_text_insert_overflow)) {
      return false;
    }
  }
  return true;
}

bool RebuildCandidate(
    Document* document,
    const std::vector<EditTransaction>& transactions,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    FPDF_DOCUMENT* rebuilt_pdf,
    CandidateMetadata* rebuilt_metadata,
    Rect* layout_bounds = nullptr,
    bool* overflow = nullptr,
    TextInsertLayoutResult* text_insert_layout = nullptr,
    bool allow_text_insert_overflow = false) {
  if (!EnsureImmutableSourceBytes(document)) {
    return false;
  }
  ScopedDocument candidate(FPDF_LoadMemDocument64(
      document->memory_source.data(), document->memory_source.size(),
      document->source_password.empty() ? nullptr : document->source_password.c_str()));
  if (!candidate.get()) {
    SetError("CORE_UNAVAILABLE",
             "The immutable PDF source could not be rebuilt.");
    return false;
  }
  CandidateMetadata metadata = document->source_metadata;
  CandidateFontCache fonts(candidate.get());
  for (size_t index = 0; index < transactions.size(); ++index) {
    const bool is_last = index + 1 == transactions.size();
    const bool wants_text_layout = layout_bounds && is_last;
    const bool wants_insert_layout = text_insert_layout && is_last;
    if (!ApplyTransactionToPdf(
            *document, candidate.get(), &metadata, transactions[index],
            resources, &fonts, wants_text_layout ? layout_bounds : nullptr,
            wants_text_layout ? overflow : nullptr,
            wants_insert_layout ? text_insert_layout : nullptr,
            wants_insert_layout && allow_text_insert_overflow)) {
      return false;
    }
  }
  *rebuilt_metadata = std::move(metadata);
  *rebuilt_pdf = candidate.release();
  return true;
}

bool CopyOptionalId(const char* source,
                    const char* label,
                    std::string* target) {
  target->clear();
  if (!source || !source[0]) {
    return true;
  }
  if (!ValidateId(source, label)) {
    return false;
  }
  *target = source;
  return true;
}

bool CopyIdVector(const PdeEditCommand& source,
                  EditType type,
                  std::vector<std::string>* ids) {
  if (source.id_count == 0) {
    if (source.ids) {
      SetError("INVALID_REQUEST",
               "An empty ID vector must use a null pointer.");
      return false;
    }
    return true;
  }
  if (!source.ids || source.id_count > kMaxEditCount) {
    SetError("INVALID_REQUEST", "The command ID vector is invalid.");
    return false;
  }
  const bool paired = type == EditType::kPagesDuplicate ||
                      type == EditType::kPagesImport ||
                      type == EditType::kObjectsCopy;
  std::set<std::string> unique;
  ids->reserve(source.id_count);
  for (uint32_t index = 0; index < source.id_count; ++index) {
    const bool source_half = paired && index % 2 == 0;
    if (type == EditType::kFormFill || type == EditType::kFormCreate) {
      if (!ValidateUtf8Argument(source.ids[index],
                               type == EditType::kFormFill ? "Form option value" : "Choice option",
                               type == EditType::kFormFill)) return false;
    } else if (type == EditType::kPagesImport && source_half) {
      if (!ValidateUtf8Argument(source.ids[index], "Source page index",
                                false)) {
        return false;
      }
    } else if (!ValidateId(source.ids[index],
                           source_half ? "Source ID" : "Target ID")) {
      return false;
    }
    if (type != EditType::kAnnotationAdd &&
        type != EditType::kAnnotationUpdate && (!paired || !source_half) &&
        !unique.emplace(source.ids[index]).second) {
      SetError("INVALID_REQUEST", paired
                                      ? "A new pair ID is duplicated."
                                      : "A command target ID is duplicated.");
      return false;
    }
    ids->emplace_back(source.ids[index]);
  }
  return true;
}

bool ValidateColor(const EditCommand& command, size_t offset) {
  for (size_t index = 0; index < 3; ++index) {
    const double value = command.values[offset + index];
    if (value < 0 || value > 1) {
      SetError("INVALID_REQUEST",
               "Text color components must be between 0 and 1.");
      return false;
    }
  }
  return true;
}

bool ValidateRectValues(const EditCommand& command) {
  if (command.values[2] <= 0 || command.values[3] <= 0) {
    SetError("INVALID_REQUEST", "Inserted content requires positive bounds.");
    return false;
  }
  return true;
}

bool CopyEditCommand(const PdeEditCommand& source, EditCommand* target) {
  if (source.type < static_cast<uint32_t>(EditType::kTextReplace) ||
      source.type > static_cast<uint32_t>(EditType::kFormUpdate)) {
    SetError("UNSUPPORTED_CAPABILITY",
             "The edit command type is not supported.");
    return false;
  }
  target->type = static_cast<EditType>(source.type);
  if (!CopyOptionalId(source.page_id, "Page ID", &target->page_id) ||
      !CopyOptionalId(source.target_id, "Target ID", &target->target_id) ||
      !CopyOptionalId(source.resource_id, "Resource ID",
                      &target->resource_id) ||
      !CopyOptionalId(source.font_id, "Font ID", &target->font_id) ||
      !CopyIdVector(source, target->type, &target->ids)) {
    return false;
  }
  if (source.text_utf8) {
    target->text = source.text_utf8;
  }
  target->start_utf16 = source.start_utf16;
  target->end_utf16 = source.end_utf16;
  target->flags = source.flags;
  target->resource_page_index = source.resource_page_index;
  std::copy(std::begin(source.values), std::end(source.values),
            target->values.begin());
  if (std::any_of(target->values.begin(), target->values.end(),
                  [](double value) { return !std::isfinite(value); })) {
    SetError("INVALID_REQUEST", "Command numeric values must be finite.");
    return false;
  }

  const auto require_page = [&]() {
    if (!target->page_id.empty()) {
      return true;
    }
    SetError("INVALID_REQUEST", "The command page ID is required.");
    return false;
  };
  const auto require_target = [&]() {
    if (!target->target_id.empty()) {
      return true;
    }
    SetError("INVALID_REQUEST", "The command target ID is required.");
    return false;
  };
  const auto require_ids = [&]() {
    if (!target->ids.empty()) {
      return true;
    }
    SetError("INVALID_REQUEST", "The command requires at least one target ID.");
    return false;
  };

  switch (target->type) {
    case EditType::kTextReplace:
      if (!require_page() || !require_target() || !source.text_utf8 ||
          !target->ids.empty() || target->flags != 0) {
        if (g_error_code.empty()) {
          SetError("INVALID_REQUEST",
                   "The text replacement fields are invalid.");
        }
        return false;
      }
      return ValidateLayoutText(target->text, "Replacement text");
    case EditType::kTextStyle:
      if (!require_page() || !require_ids() ||
          (target->flags & ~(kKnownStyleFlags | kTextStyleRangeFlag |
                              kTextStyleUnderlineFlag)) != 0 ||
          (target->flags & (kKnownStyleFlags | kTextStyleUnderlineFlag)) == 0) {
        if (g_error_code.empty()) {
          SetError("UNSUPPORTED_CAPABILITY", "Unknown or empty text style.");
        }
        return false;
      }
      if ((target->flags & kTextStyleRangeFlag)
              ? (target->ids.size() != 1 || target->start_utf16 >= target->end_utf16)
              : (target->start_utf16 != 0 || target->end_utf16 != 0)) {
        SetError("INVALID_REQUEST", "Range styling requires one block and a non-empty range.");
        return false;
      }
      if (((target->flags & 1U) != 0) != !target->font_id.empty()) {
        SetError("INVALID_REQUEST", "The text font flag and font ID disagree.");
        return false;
      }
      if ((target->flags & kTextStyleUnderlineFlag) &&
          target->values[5] != 0 && target->values[5] != 1) {
        SetError("INVALID_REQUEST", "Paragraph underline must be 0 or 1.");
        return false;
      }
      if ((target->flags & 2U) &&
          (target->values[0] <= 0 || target->values[0] > 1000)) {
        SetError("INVALID_REQUEST", "The text font size is invalid.");
        return false;
      }
      return !(target->flags & 4U) || ValidateColor(*target, 1);
    case EditType::kTextReflow:
    case EditType::kTextInsert:
      if (!require_page() || !require_target() || !source.text_utf8 ||
          target->text.empty() ||
          (target->type == EditType::kTextReflow ? target->ids.empty() : !target->ids.empty()) ||
          (target->type == EditType::kTextReflow && !(target->flags & kTextParagraphFlag)) ||
          ((target->flags & kTextUnderlineFlag) && !(target->flags & kTextParagraphFlag)) ||
          ((target->flags & kTextParagraphFlag) &&
           (target->flags & (kTextInvisibleFlag | kTextFitBoundsFlag | kTextOcrFlag))) ||
          (target->flags & ~kKnownTextInsertFlags) != 0 ||
          (target->flags & 3U) != 3U || target->font_id.empty() ||
          target->values[4] <= 0 || target->values[4] > 1000 ||
          ((target->flags & kTextFitBoundsFlag) && !(target->flags & kTextInvisibleFlag)) ||
          ((target->flags & kTextOcrFlag) &&
           (target->flags & (kTextFitBoundsFlag | kTextInvisibleFlag)) !=
               (kTextFitBoundsFlag | kTextInvisibleFlag)) ||
          ((target->flags & kTextInsertCenterFlag) &&
           (target->flags & kTextInsertRightFlag) &&
           !(target->flags & kTextParagraphFlag)) ||
          ((target->flags & kTextInsertLineHeightFlag) &&
           (target->values[9] <= 0 || target->values[9] > 100)) ||
          !ValidateRectValues(*target)) {
        if (g_error_code.empty()) {
          SetError("INVALID_REQUEST",
                   "New text requires positive bounds, text, font, font size, "
                   "and compatible alignment flags (both flags require a logical paragraph).");
        }
        return false;
      }
      if (!ValidateLayoutText(target->text, "Inserted text")) {
        return false;
      }
      return !(target->flags & 4U) || ValidateColor(*target, 5);
    case EditType::kObjectsTransform:
      return require_page() && require_ids() && target->flags == 0;
    case EditType::kObjectsAlign:
      if (!require_page() || target->ids.size() < 2 || target->flags != 0 ||
          target->values[0] < 0 || target->values[0] > 5 ||
          std::floor(target->values[0]) != target->values[0]) {
        if (g_error_code.empty())
          SetError("INVALID_REQUEST", "Alignment requires two objects and a valid axis.");
        return false;
      }
      return true;
    case EditType::kObjectsDistribute:
      if (!require_page() || target->ids.size() < 3 || target->flags != 0 ||
          (target->values[0] != 0 && target->values[0] != 1)) {
        if (g_error_code.empty())
          SetError("INVALID_REQUEST", "Distribution requires three objects and horizontal or vertical axis.");
        return false;
      }
      return true;
    case EditType::kObjectsGroup:
      if (!require_page() || !require_target() || target->ids.size() < 2 ||
          target->flags != 0 || !target->resource_id.empty()) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "Grouping requires a new group ID and at least two object IDs.");
        return false;
      }
      return true;
    case EditType::kObjectsUngroup:
      if (!require_page() || !require_target() || !target->ids.empty() ||
          target->flags != 0 || !target->resource_id.empty()) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "Ungrouping requires an existing group ID.");
        return false;
      }
      return true;
    case EditType::kObjectsDelete:
      return require_page() && require_ids() && target->flags == 0;
    case EditType::kPagesRotate:
      if (!require_ids() || target->flags != 0 ||
          (target->values[0] != 90 && target->values[0] != 180 &&
           target->values[0] != 270)) {
        SetError("INVALID_REQUEST",
                 "Page rotation must be 90, 180, or 270 degrees.");
        return false;
      }
      return true;
    case EditType::kPagesCrop:
      if (!require_ids() || target->flags != 0 || !ValidateRectValues(*target)) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "Page crop requires a positive page rectangle.");
        return false;
      }
      return true;
    case EditType::kPagesDelete:
    case EditType::kPagesReorder:
      return require_ids() && target->flags == 0;
    case EditType::kPagesInsert:
      if (!require_page() || target->flags != 0 || target->values[0] <= 0 ||
          target->values[1] <= 0) {
        SetError("INVALID_REQUEST", "The inserted page geometry is invalid.");
        return false;
      }
      return true;
    case EditType::kImageInsert:
      if (!require_page() || !require_target() || target->resource_id.empty() ||
          !target->ids.empty() || target->flags != 0) {
        SetError("INVALID_REQUEST", "The image insertion fields are invalid.");
        return false;
      }
      return ValidateRectValues(*target);
    case EditType::kContentInsert:
      if (!require_page() || !require_target() || target->resource_id.empty() ||
          !target->ids.empty() || target->flags != 0) {
        SetError("INVALID_REQUEST",
                 "The PDF content insertion fields are invalid.");
        return false;
      }
      return ValidateRectValues(*target);
    case EditType::kPagesDuplicate:
      if (target->ids.empty() || target->ids.size() % 2 != 0 ||
          target->flags != 0 || !target->resource_id.empty() ||
          !target->page_id.empty()) {
        SetError("INVALID_REQUEST",
                 "Page duplication requires source/new page ID pairs.");
        return false;
      }
      return true;
    case EditType::kPagesImport:
      if (target->ids.empty() || target->ids.size() % 2 != 0 ||
          target->flags != 0 || target->resource_id.empty() ||
          !target->page_id.empty()) {
        SetError(
            "INVALID_REQUEST",
            "Page import requires a PDF resource and index/new page ID pairs.");
        return false;
      }
      for (size_t index = 0; index < target->ids.size(); index += 2) {
        uint32_t ignored = 0;
        if (!ParseSourcePageIndex(target->ids[index], &ignored)) {
          return false;
        }
      }
      return true;
    case EditType::kImageReplace:
      if (!require_page() || !require_target() || target->resource_id.empty() ||
          !target->ids.empty() || target->flags != 0) {
        SetError("INVALID_REQUEST",
                 "The image replacement fields are invalid.");
        return false;
      }
      return true;
    case EditType::kImageCrop:
      if (!require_page() || !require_target() ||
          !target->resource_id.empty() || !target->ids.empty() ||
          target->flags != 0 || target->values[2] <= 0 ||
          target->values[3] <= 0) {
        SetError(
            "INVALID_REQUEST",
            "Image cropping requires a positive page-coordinate rectangle.");
        return false;
      }
      return true;
    case EditType::kAnnotationDelete:
      if (!require_page() || !require_target() || !target->ids.empty() ||
          target->flags || !target->resource_id.empty() || !target->text.empty() ||
          !target->font_id.empty()) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "Annotation deletion requires a page and annotation ID.");
        return false;
      }
      return true;
    case EditType::kAnnotationUpdate:
    case EditType::kAnnotationAdd:
      if (!require_page() || !require_target() || !ValidateRectValues(*target) ||
          (target->flags & ~7U) || !target->font_id.empty() ||
          (target->resource_id != "highlight" && target->resource_id != "text" &&
           target->resource_id != "rectangle" && target->resource_id != "ink") ||
          !ValidateLayoutText(target->text, "Annotation text") ||
          ((target->flags & 1U) && !ValidateColor(*target, 4)) ||
          ((target->flags & 2U) && (target->values[7] < 0 || target->values[7] > 1)) ||
          ((target->flags & 4U) && target->values[8] <= 0)) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "The annotation fields are invalid.");
        return false;
      }
      if (target->resource_id == "ink") {
        if (target->ids.size() < 4 || target->ids.size() % 2 != 0) {
          SetError("INVALID_REQUEST", "Ink annotations require at least two coordinate pairs.");
          return false;
        }
        for (const auto& coordinate : target->ids) {
          double value = 0;
          const auto parsed = std::from_chars(coordinate.data(), coordinate.data() + coordinate.size(), value);
          if (parsed.ec != std::errc() || parsed.ptr != coordinate.data() + coordinate.size() || !std::isfinite(value)) {
            SetError("INVALID_REQUEST", "Ink coordinates must be finite numbers.");
            return false;
          }
        }
      } else if (!target->ids.empty()) {
        SetError("INVALID_REQUEST", "Only ink annotations accept coordinate pairs.");
        return false;
      }
      return true;
    case EditType::kFormFill:
      if (!require_target() || !target->page_id.empty() || !target->resource_id.empty() ||
          !target->font_id.empty() || target->flags > 2 ||
          ((target->flags == 1) && target->values[0] != 0 && target->values[0] != 1) ||
          ((target->flags != 2) && !target->ids.empty()) ||
          ((target->flags != 0) && !target->text.empty()) ||
          !ValidateLayoutText(target->text, "Form value")) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "The form value fields are invalid.");
        return false;
      }
      return true;
    case EditType::kFormUpdate:
      if (!require_target() || !target->page_id.empty() ||
          !target->resource_id.empty() || !target->font_id.empty() ||
          !target->ids.empty() ||
          target->flags == 0 || (target->flags & ~31U) ||
          ((target->flags & 1U) && target->values[0] != 0 && target->values[0] != 1) ||
          ((target->flags & 2U) && target->values[1] != 0 && target->values[1] != 1) ||
          ((target->flags & 4U) && target->values[2] != 0 && target->values[2] != 1) ||
          ((target->flags & 8U) && (target->values[3] < 0 || target->values[3] > 1000000.0 || target->values[3] != std::floor(target->values[3]))) ||
          (!(target->flags & 16U) && !target->text.empty()) ||
          ((target->flags & 16U) && !target->text.empty() && !ValidateLayoutText(target->text, "Tooltip"))) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "The form attribute update is invalid.");
        return false;
      }
      return true;
    case EditType::kFormCreate: {
      const bool choice = target->resource_id == "combo" || target->resource_id == "list";
      const bool radio = target->resource_id == "radio";
      if (!require_page() || !require_target() || !ValidateRectValues(*target) ||
          (target->flags & ~15U) ||
          ((target->flags & 8U) && target->resource_id != "list") ||
          (((target->flags & 1U) != 0) != !target->font_id.empty()) ||
          (target->resource_id != "text" && target->resource_id != "checkbox" && !choice && !radio) ||
          ((choice || radio) ? target->ids.empty() || (choice && target->font_id.empty()) : !target->ids.empty()) ||
          target->text.empty() || !ValidateLayoutText(target->text, "Form name") ||
          target->values[4] <= 0 || target->values[4] > 1000) {
        if (g_error_code.empty()) SetError("INVALID_REQUEST", "The new form field is invalid.");
        return false;
      }
      for (const auto& option : target->ids) {
        if (!ValidateLayoutText(option, "Choice option")) return false;
      }
      return true;
    }
    case EditType::kObjectsCopy:
      if (!require_page() || target->ids.empty() ||
          target->ids.size() % 2 != 0 || target->flags != 0 ||
          !target->resource_id.empty()) {
        SetError("INVALID_REQUEST",
                 "Object copying requires source/new object ID pairs.");
        return false;
      }
      return true;
  }
  return false;
}

bool BuildCommandTransaction(const char* transaction_id,
                             const PdeEditCommand* commands,
                             uint32_t count,
                             EditTransaction* transaction) {
  if (transaction_id && !ValidateId(transaction_id, "Transaction ID")) {
    return false;
  }
  if (!commands || count == 0 || count > kMaxEditCount) {
    SetError("INVALID_REQUEST", "A non-empty edit command batch is required.");
    return false;
  }
  transaction->id = transaction_id ? transaction_id : "preview";
  transaction->commands.reserve(count);
  std::map<std::pair<std::string, std::string>,
           std::vector<std::pair<uint32_t, uint32_t>>>
      text_ranges;
  for (uint32_t index = 0; index < count; ++index) {
    EditCommand command;
    if (!CopyEditCommand(commands[index], &command)) {
      return false;
    }
    command.transaction_id = transaction->id;
    command.transaction_index = index;
    if (command.type == EditType::kTextReplace) {
      auto& ranges = text_ranges[{command.page_id, command.target_id}];
      if (!ranges.empty() && command.start_utf16 > ranges.back().first) {
        SetError("INVALID_REQUEST",
                 "Text replacements in one block must use "
                 "descending original ranges.");
        return false;
      }
      for (const auto& range : ranges) {
        if (command.start_utf16 == range.first ||
            (command.start_utf16 < range.second &&
             command.end_utf16 > range.first)) {
          SetError("INVALID_REQUEST",
                   "Text replacement ranges in one block must not overlap.");
          return false;
        }
      }
      ranges.emplace_back(command.start_utf16, command.end_utf16);
    }
    transaction->commands.push_back(std::move(command));
  }
  return true;
}

bool CopyTextEdit(const Document& document,
                  const PdeTextEdit& source,
                  EditCommand* target) {
  if (source.page_index >= document.metadata.pages.size() ||
      !ValidateId(source.block_id, "Text block ID") ||
      !ValidateUtf8Argument(source.replacement_utf8, "Replacement text",
                            true) ||
      !ValidateLayoutText(source.replacement_utf8, "Replacement text")) {
    if (g_error_code.empty()) {
      SetError("INVALID_REQUEST", "The text edit page index is out of range.");
    }
    return false;
  }
  if (source.font_id && source.font_id[0] &&
      !ValidateId(source.font_id, "Font ID")) {
    return false;
  }
  target->type = EditType::kTextReplace;
  target->page_id = document.metadata.pages[source.page_index].id;
  target->target_id = source.block_id;
  target->text = source.replacement_utf8;
  target->font_id = source.font_id ? source.font_id : "";
  target->start_utf16 = source.start_utf16;
  target->end_utf16 = source.end_utf16;
  return true;
}

bool BuildTextTransaction(const Document& document,
                          const char* transaction_id,
                          const PdeTextEdit* edits,
                          uint32_t count,
                          EditTransaction* transaction) {
  if (!ValidateId(transaction_id, "Transaction ID")) {
    return false;
  }
  if (!edits || count == 0 || count > kMaxEditCount) {
    SetError("INVALID_REQUEST", "A non-empty text edit batch is required.");
    return false;
  }
  transaction->id = transaction_id;
  transaction->commands.reserve(count);
  std::set<std::pair<std::string, std::string>> targets;
  for (uint32_t index = 0; index < count; ++index) {
    EditCommand command;
    if (!CopyTextEdit(document, edits[index], &command)) {
      return false;
    }
    if (!targets.emplace(command.page_id, command.target_id).second) {
      SetError("INVALID_REQUEST",
               "A text block may appear only once in an ABI 2 transaction.");
      return false;
    }
    transaction->commands.push_back(std::move(command));
  }
  return true;
}

bool AddRequiredFontResources(
    const EditTransaction& transaction,
    std::map<std::string, std::shared_ptr<const FontResource>>* resources) {
  for (const EditCommand& command : transaction.commands) {
    if (command.font_id.empty() || resources->contains(command.font_id)) {
      continue;
    }
    const auto registered = g_fonts.find(command.font_id);
    if (registered == g_fonts.end()) {
      SetError("INVALID_REQUEST", "The requested font is not registered.");
      return false;
    }
    resources->emplace(registered->first, registered->second);
  }
  return true;
}

bool ValidateNewCommandIds(const Document& document,
                           const EditTransaction& transaction) {
  std::set<std::string> ids = document.reserved_ids;
  CollectDocumentToolIds(document, &ids);
  for (const EditCommand& command : transaction.commands) {
    std::vector<std::string_view> new_ids;
    if (command.type == EditType::kPagesInsert) {
      new_ids.push_back(command.page_id);
    } else if (command.type == EditType::kTextInsert ||
               command.type == EditType::kImageInsert ||
               command.type == EditType::kContentInsert ||
               command.type == EditType::kAnnotationAdd ||
               command.type == EditType::kObjectsGroup ||
               command.type == EditType::kFormCreate ||
               command.type == EditType::kTextReflow) {
      new_ids.push_back(command.target_id);
    } else if (command.type == EditType::kPagesDuplicate ||
               command.type == EditType::kPagesImport ||
               command.type == EditType::kObjectsCopy) {
      for (size_t index = 1; index < command.ids.size(); index += 2) {
        new_ids.push_back(command.ids[index]);
      }
    }
    for (std::string_view new_id : new_ids) {
      if (!new_id.empty() && !ids.insert(std::string(new_id)).second) {
        SetError("INVALID_REQUEST",
                 "A new page or object ID was already used.");
        return false;
      }
    }
  }
  return true;
}

std::set<std::string> ChangedPageSet(const EditTransaction& transaction) {
  std::set<std::string> pages;
  for (const EditCommand& command : transaction.commands) {
    if (!command.page_id.empty()) {
      pages.insert(command.page_id);
    }
    if (command.type == EditType::kPagesRotate ||
        command.type == EditType::kPagesCrop ||
        command.type == EditType::kPagesDelete ||
        command.type == EditType::kPagesReorder) {
      pages.insert(command.ids.begin(), command.ids.end());
    } else if (command.type == EditType::kPagesDuplicate ||
               command.type == EditType::kPagesImport) {
      for (size_t index = 1; index < command.ids.size(); index += 2) {
        pages.insert(command.ids[index]);
      }
    }
  }
  return pages;
}

void AppendPageOrder(std::string* output, const CandidateMetadata& metadata) {
  output->push_back('[');
  for (size_t index = 0; index < metadata.pages.size(); ++index) {
    if (index) {
      output->push_back(',');
    }
    AppendJsonString(output, metadata.pages[index].id);
  }
  output->push_back(']');
}

void AppendChangedPages(std::string* output,
                        const EditTransaction& transaction,
                        const CandidateMetadata& metadata) {
  const std::set<std::string> changed = ChangedPageSet(transaction);
  const bool forms_changed = std::any_of(transaction.commands.begin(), transaction.commands.end(),
      [](const EditCommand& command) {
        return command.type == EditType::kFormFill || command.type == EditType::kFormUpdate;
      });
  output->push_back('[');
  bool first = true;
  for (const PageIdentity& page : metadata.pages) {
    if (!forms_changed && !changed.contains(page.id)) {
      continue;
    }
    if (!first) {
      output->push_back(',');
    }
    first = false;
    AppendJsonString(output, page.id);
  }
  output->push_back(']');
}

std::string SerializePreviewResult(const Document& document,
                                   uint32_t base_revision,
                                   const EditTransaction& transaction,
                                   const CandidateMetadata& metadata) {
  std::string output;
  output.append("{\"docId\":");
  AppendJsonString(&output, document.document_id);
  output.append(",\"baseRevision\":");
  AppendJsonUnsigned(&output, base_revision);
  output.append(",\"pageOrder\":");
  AppendPageOrder(&output, metadata);
  output.append(",\"changedPageIds\":");
  AppendChangedPages(&output, transaction, metadata);
  output.push_back('}');
  return output;
}

std::string SerializeCommitResult(const Document& document,
                                  uint32_t revision,
                                  size_t undoable_count,
                                  bool can_redo,
                                  const EditTransaction& transaction,
                                  const CandidateMetadata& metadata) {
  std::string output;
  output.append("{\"docId\":");
  AppendJsonString(&output, document.document_id);
  output.append(",\"revision\":");
  AppendJsonUnsigned(&output, revision);
  output.append(",\"changedPageIds\":");
  AppendChangedPages(&output, transaction, metadata);
  output.append(",\"pageOrder\":");
  AppendPageOrder(&output, metadata);
  output.append(",\"canUndo\":");
  output.append(undoable_count > 0 ? "true" : "false");
  output.append(",\"canRedo\":");
  output.append(can_redo ? "true" : "false");
  output.push_back('}');
  return output;
}

std::string SerializeLayoutResult(const Rect& bounds,
                                  bool overflow,
                                  const EditCommand& edit) {
  std::string output;
  output.append("{\"bounds\":");
  AppendRect(&output, bounds);
  output.append(",\"overflow\":");
  output.append(overflow ? "true" : "false");
  output.append(",\"lines\":[");
  if (!edit.text.empty()) {
    output.append("{\"bounds\":");
    AppendRect(&output, bounds);
    output.append(",\"range\":[0,");
    AppendJsonUnsigned(&output, Utf16Length(edit.text));
    output.append("]}");
  }
  output.push_back(']');
  if (!edit.font_id.empty()) {
    output.append(",\"replacementFontId\":");
    AppendJsonString(&output, edit.font_id);
  }
  output.push_back('}');
  return output;
}

std::string SerializeTextInsertLayoutResult(
    const TextInsertLayoutResult& layout,
    std::string_view font_id) {
  std::string output;
  output.append("{\"bounds\":");
  AppendRect(&output, layout.bounds);
  output.append(",\"overflow\":");
  output.append(layout.overflow ? "true" : "false");
  output.append(",\"lines\":[");
  for (size_t index = 0; index < layout.lines.size(); ++index) {
    if (index) {
      output.push_back(',');
    }
    output.append("{\"bounds\":");
    AppendRect(&output, layout.lines[index].bounds);
    output.append(",\"range\":[");
    AppendJsonUnsigned(&output, layout.lines[index].start_utf16);
    output.push_back(',');
    AppendJsonUnsigned(&output, layout.lines[index].end_utf16);
    output.append("]}");
  }
  output.push_back(']');
  if (!font_id.empty()) {
    output.append(",\"replacementFontId\":");
    AppendJsonString(&output, font_id);
  }
  output.push_back('}');
  return output;
}

void ReserveMetadataIds(const CandidateMetadata& metadata,
                        std::set<std::string>* reserved_ids) {
  for (const PageIdentity& page : metadata.pages) {
    reserved_ids->insert(page.id);
    for (const ObjectIdentity& object : page.objects) {
      AddIdentityIds(object, reserved_ids);
    }
  }
}

void ReserveTransactionIds(const EditTransaction& transaction,
                           std::set<std::string>* reserved_ids) {
  for (const EditCommand& command : transaction.commands) {
    if (command.type == EditType::kPagesInsert) {
      reserved_ids->insert(command.page_id);
    } else if (command.type == EditType::kTextInsert ||
               command.type == EditType::kImageInsert ||
               command.type == EditType::kContentInsert ||
               command.type == EditType::kAnnotationAdd ||
               command.type == EditType::kObjectsGroup ||
               command.type == EditType::kFormCreate ||
               command.type == EditType::kTextReflow) {
      reserved_ids->insert(command.target_id);
    } else if (command.type == EditType::kPagesDuplicate ||
               command.type == EditType::kPagesImport ||
               command.type == EditType::kObjectsCopy) {
      for (size_t index = 1; index < command.ids.size(); index += 2) {
        reserved_ids->insert(command.ids[index]);
      }
    }
  }
}

void InstallCandidate(Document* document,
                      FPDF_DOCUMENT candidate,
                      CandidateMetadata metadata) {
  FPDF_DOCUMENT previous = document->pdf;
  document->pdf = candidate;
  document->metadata = std::move(metadata);
  FPDF_CloseDocument(previous);
}

FPDF_DWORD SaveFlags(const Document& document) {
  bool has_registered_font = false;
  bool has_no_subsetting_font = false;
  for (const EditTransaction& transaction : document.transactions) {
    for (const EditCommand& command : transaction.commands) {
      if (command.font_id.empty()) {
        continue;
      }
      has_registered_font = true;
      const auto resource = document.font_resources.find(command.font_id);
      if (resource != document.font_resources.end() &&
          resource->second->face.no_subsetting) {
        has_no_subsetting_font = true;
      }
    }
  }
  FPDF_DWORD flags = FPDF_NO_INCREMENTAL;
  if (has_registered_font && !has_no_subsetting_font) {
    flags |= FPDF_SUBSET_NEW_FONTS;
  }
  return flags;
}

struct BinaryPdfWriter : FPDF_FILEWRITE {
  BinaryPdfWriter() {
    version = 1;
    WriteBlock = [](FPDF_FILEWRITE* self, const void* data,
                    unsigned long size) -> int {
      auto* writer = static_cast<BinaryPdfWriter*>(self);
      if (writer->failed ||
          size > std::numeric_limits<uint32_t>::max() - writer->bytes.size()) {
        writer->failed = true;
        return 0;
      }
      try {
        const uint8_t* first = static_cast<const uint8_t*>(data);
        writer->bytes.insert(writer->bytes.end(), first, first + size);
      } catch (...) {
        writer->failed = true;
        return 0;
      }
      return 1;
    };
  }

  std::vector<uint8_t> bytes;
  bool failed = false;
};

bool SavePdfToMemory(Document* document) {
  const FPDF_DWORD flags = SaveFlags(*document);
  BinaryPdfWriter writer;
  if (!FPDF_SaveAsCopy(document->pdf, &writer, flags) || writer.failed) {
    SetError("SAVE_FAILED", "The edited PDF could not be serialized.");
    return false;
  }
  g_binary.swap(writer.bytes);
  return true;
}

struct DestinationPdfWriter : FPDF_FILEWRITE {
  explicit DestinationPdfWriter(DestinationFile* destination)
      : destination(destination) {
    version = 1;
    WriteBlock = [](FPDF_FILEWRITE* self, const void* data,
                    unsigned long size) -> int {
      auto* writer = static_cast<DestinationPdfWriter*>(self);
      if (writer->failed || !writer->destination->Write(
                                static_cast<const uint8_t*>(data), size)) {
        writer->failed = true;
        return 0;
      }
      return 1;
    };
  }

  DestinationFile* destination;
  bool failed = false;
};

bool SavePdfToFile(Document* document, std::string_view destination) {
  const FPDF_DWORD flags = SaveFlags(*document);
  DestinationFile output;
  if (!output.Open(destination)) {
    SetError("SAVE_FAILED", "The destination file could not be opened.");
    return false;
  }
  DestinationPdfWriter writer(&output);
  if (!FPDF_SaveAsCopy(document->pdf, &writer, flags) || writer.failed ||
      !output.Finish()) {
    SetError("SAVE_FAILED", "The edited PDF could not be written.");
    return false;
  }
  return true;
}

bool BuildExtractedPdf(Document* document,
                       const char* const* page_ids,
                       uint32_t page_count,
                       FPDF_DOCUMENT* result) {
  if (!page_ids || page_count == 0 || page_count > document->metadata.pages.size()) {
    SetError("INVALID_REQUEST", "Select at least one distinct current page ID.");
    return false;
  }
  const unsigned long permissions = FPDF_GetDocPermissions(document->pdf);
  if (permissions != 0xffffffffUL &&
      (!(permissions & (1UL << 4)) || !(permissions & (1UL << 10)))) {
    SetError("UNSUPPORTED_CAPABILITY",
             "PDF copy and document-assembly permissions are required for extraction.");
    return false;
  }
  if (FPDF_GetSecurityHandlerRevision(document->pdf) >= 0) {
    SetError("UNSUPPORTED_CAPABILITY",
             "Extracting encrypted PDFs without preserving their protection is not supported.");
    return false;
  }
  CPDF_Document* native = CPDFDocumentFromFPDFDocument(document->pdf);
  const CPDF_Dictionary* catalog = native ? native->GetRoot() : nullptr;
  if (!catalog) { SetUnexpectedError(); return false; }
  for (const char* key : {"Outlines", "StructTreeRoot", "AcroForm", "Names",
                          "Dests", "PageLabels", "OCProperties", "OpenAction",
                          "AA", "AF", "Perms", "OutputIntents"}) {
    if (catalog->KeyExist(key)) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Document-level navigation, form, structure or appearance semantics cannot be extracted safely.");
      return false;
    }
  }
  std::vector<int> indices;
  indices.reserve(page_count);
  std::set<std::string> unique_ids;
  for (uint32_t offset = 0; offset < page_count; ++offset) {
    if (!ValidateId(page_ids[offset], "Page ID")) return false;
    const std::string_view id(page_ids[offset]);
    const auto index = FindPageIndex(document->metadata, id);
    if (!index || !unique_ids.emplace(id).second) {
      SetError("INVALID_REQUEST", "Page IDs must exist and be distinct.");
      return false;
    }
    if (!ValidateExtractablePageFeatures(document->pdf, static_cast<int>(*index)))
      return false;
    indices.push_back(static_cast<int>(*index));
  }
  ScopedDocument extracted(FPDF_CreateNewDocument());
  if (!extracted.get() ||
      !FPDF_ImportPagesByIndex(extracted.get(), document->pdf, indices.data(),
                               static_cast<unsigned long>(indices.size()), 0)) {
    SetError("CORE_UNAVAILABLE", "The selected pages could not be copied to a new PDF.");
    return false;
  }
  *result = extracted.release();
  return true;
}

std::string SerializeExtractedPagesResult(const Document& document,
                                          const char* const* page_ids,
                                          uint32_t page_count,
                                          std::string_view kind) {
  std::string result = "{\"kind\":";
  AppendJsonString(&result, kind);
  result.append(",\"sourceRevision\":");
  AppendJsonUnsigned(&result, document.revision);
  result.append(",\"pageIds\":[");
  for (uint32_t offset = 0; offset < page_count; ++offset) {
    if (offset) result.push_back(',');
    AppendJsonString(&result, page_ids[offset]);
  }
  result.append("]}");
  return result;
}

bool RequireEditingAllowed(const Document& document) {
  if (document.editing_allowed) {
    return true;
  }
  SetError("UNSUPPORTED_CAPABILITY",
           "Editing requires an unsigned PDF opened with modification permission.");
  return false;
}

bool RequireTransactionAllowed(const Document& document, const EditTransaction& transaction) {
  if (HasSignedSignature(document.pdf)) {
    SetError("UNSUPPORTED_CAPABILITY", "Editing a digitally signed PDF is not enabled.");
    return false;
  }
  const unsigned long permissions = FPDF_GetDocPermissions(document.pdf);
  for (const auto& command : transaction.commands) {
    const unsigned long bit = command.type == EditType::kFormFill ? (1UL << 8) :
        (command.type == EditType::kAnnotationAdd ||
         command.type == EditType::kAnnotationUpdate ||
         command.type == EditType::kAnnotationDelete) ? (1UL << 5) : (1UL << 3);
    if (permissions != 0xffffffffUL && !(permissions & bit)) {
      SetError("UNSUPPORTED_CAPABILITY", "The PDF permissions do not allow this operation.");
      return false;
    }
  }
  return true;
}

bool ValidateBaseRevision(const Document& document, uint32_t base_revision) {
  if (base_revision == document.revision) {
    return true;
  }
  SetError("STALE_REVISION",
           "The document changed after this transaction was prepared.");
  return false;
}

const char* PreviewGenericTransaction(Document* document,
                                      uint32_t base_revision,
                                      const EditTransaction& transaction) {
  if (!RequireTransactionAllowed(*document, transaction) ||
      !ValidateBaseRevision(*document, base_revision) ||
      !ValidateNewCommandIds(*document, transaction)) {
    return nullptr;
  }
  auto resources = document->font_resources;
  if (!AddRequiredFontResources(transaction, &resources)) {
    return nullptr;
  }
  auto transactions = document->transactions;
  transactions.push_back(transaction);
  FPDF_DOCUMENT rebuilt = nullptr;
  CandidateMetadata metadata;
  if (!RebuildCandidate(document, transactions, resources, &rebuilt,
                        &metadata)) {
    return nullptr;
  }
  ScopedDocument candidate(rebuilt);
  g_result =
      SerializePreviewResult(*document, base_revision, transaction, metadata);
  return g_result.c_str();
}

const char* CommitGenericTransaction(Document* document,
                                     uint32_t base_revision,
                                     EditTransaction transaction) {
  if (!RequireTransactionAllowed(*document, transaction) ||
      !ValidateBaseRevision(*document, base_revision)) {
    return nullptr;
  }
  if (document->revision == std::numeric_limits<uint32_t>::max()) {
    SetError("RESOURCE_LIMIT", "The document revision limit was reached.");
    return nullptr;
  }
  if (document->transaction_ids.contains(transaction.id)) {
    SetError("INVALID_REQUEST", "The transaction ID was already used.");
    return nullptr;
  }
  if (!ValidateNewCommandIds(*document, transaction)) {
    return nullptr;
  }
  auto resources = document->font_resources;
  if (!AddRequiredFontResources(transaction, &resources)) {
    return nullptr;
  }
  auto transactions = document->transactions;
  transactions.push_back(transaction);
  FPDF_DOCUMENT rebuilt = nullptr;
  CandidateMetadata metadata;
  if (!RebuildCandidate(document, transactions, resources, &rebuilt,
                        &metadata)) {
    return nullptr;
  }
  ScopedDocument candidate(rebuilt);
  const size_t undoable_count =
      std::min(kUndoLimit, document->undoable_count + 1);
  std::string result =
      SerializeCommitResult(*document, document->revision + 1, undoable_count,
                            false, transaction, metadata);

  ReserveTransactionIds(transaction, &document->reserved_ids);
  ReserveMetadataIds(metadata, &document->reserved_ids);
  InstallCandidate(document, candidate.release(), std::move(metadata));
  document->transactions.swap(transactions);
  document->font_resources.swap(resources);
  document->transaction_ids.insert(transaction.id);
  document->redo_transactions.clear();
  document->undoable_count = undoable_count;
  ++document->revision;
  g_result.swap(result);
  return g_result.c_str();
}

#include "recovery_document.h"

}  // namespace

extern "C" {

uint32_t pde_abi_version(void) {
  return kAbiVersion;
}

const char* pde_capabilities(void) {
  return Guard<const char*>(nullptr, []() -> const char* {
    BeginOperation();
    g_result.assign(kCapabilitiesJson.data(), kCapabilitiesJson.size());
    return g_result.c_str();
  });
}

int pde_initialize(void) {
  return Guard<int>(0, []() {
    BeginOperation();
    if (!g_initialized) {
      FPDF_InitLibrary();
      g_initialized = true;
    }
    return 1;
  });
}

void pde_shutdown(void) {
  try {
    BeginOperation();
    if (!g_initialized) {
      return;
    }
    g_documents.clear();
    g_fonts.clear();
    FPDF_DestroyLibrary();
    g_initialized = false;
  } catch (...) {
    SetUnexpectedError();
  }
}

uint32_t pde_open_memory(const uint8_t* bytes,
                         uint32_t length,
                         const char* document_id,
                         const char* source_id,
                         const char* password_utf8) {
  return Guard<uint32_t>(0, [&]() {
    BeginOperation();
    if (!RequireInitialized() || !ValidateId(document_id, "Document ID") ||
        !ValidateId(source_id, "Source ID") ||
        !ValidateUtf8Argument(password_utf8 ? password_utf8 : "", "Password",
                              true)) {
      return 0U;
    }
    if (!bytes || length == 0) {
      SetError("INVALID_REQUEST", "PDF bytes are required.");
      return 0U;
    }
    if (DocumentIdIsOpen(document_id)) {
      SetError("INVALID_REQUEST", "The document ID is already open.");
      return 0U;
    }

    auto document = std::make_unique<Document>();
    document->document_id = document_id;
    document->source_id = source_id;
    document->memory_source.assign(bytes, bytes + length);
    document->source_size = length;
    document->source_password = password_utf8 ? password_utf8 : "";
    const char* password = document->source_password.empty()
                               ? nullptr : document->source_password.c_str();
    document->pdf =
        FPDF_LoadMemDocument64(document->memory_source.data(),
                               document->memory_source.size(), password);
    if (!document->pdf) {
      SetPdfOpenError();
      return 0U;
    }
    document->editing_allowed = EditingIsAllowed(document->pdf);

    const uint32_t handle = AllocateHandle();
    if (handle == 0) {
      SetError("RESOURCE_LIMIT", "No document handles are available.");
      return 0U;
    }
    document->handle = handle;
    document->session_id = AllocateSessionId();
    if (!BuildInitialMetadata(document.get())) {
      return 0U;
    }
    g_documents.emplace(handle, std::move(document));
    return handle;
  });
}

uint32_t pde_open_file_utf8(const char* path_utf8,
                            const char* document_id,
                            const char* source_id,
                            const char* password_utf8) {
  return Guard<uint32_t>(0, [&]() {
    BeginOperation();
    if (!RequireInitialized() ||
        !ValidateUtf8Argument(path_utf8, "PDF path", false) ||
        !ValidateId(document_id, "Document ID") ||
        !ValidateId(source_id, "Source ID") ||
        !ValidateUtf8Argument(password_utf8 ? password_utf8 : "", "Password",
                              true)) {
      return 0U;
    }
    if (DocumentIdIsOpen(document_id)) {
      SetError("INVALID_REQUEST", "The document ID is already open.");
      return 0U;
    }

    auto document = std::make_unique<Document>();
    document->document_id = document_id;
    document->source_id = source_id;
    document->source_path = pdf_editor::NativeFilePathUtf8(path_utf8);
    document->file_source = FileAccessIface::Create();
    if (document->source_path.empty() || !document->file_source ||
        !document->file_source->Open(document->source_path.c_str())) {
      SetError("INVALID_REQUEST", "The PDF source could not be opened.");
      return 0U;
    }
    document->source_size = document->file_source->GetSize();
    if (document->source_size <= 0) {
      SetError("INVALID_REQUEST", "The PDF source is empty or unavailable.");
      return 0U;
    }

    document->source_password = password_utf8 ? password_utf8 : "";
    const char* password = document->source_password.empty()
                               ? nullptr : document->source_password.c_str();
    document->pdf = FPDF_LoadDocument(document->source_path.c_str(), password);
    if (!document->pdf) {
      SetPdfOpenError();
      return 0U;
    }
    document->editing_allowed = EditingIsAllowed(document->pdf);

    const uint32_t handle = AllocateHandle();
    if (handle == 0) {
      SetError("RESOURCE_LIMIT", "No document handles are available.");
      return 0U;
    }
    document->handle = handle;
    document->session_id = AllocateSessionId();
    if (!BuildInitialMetadata(document.get())) {
      return 0U;
    }
    g_documents.emplace(handle, std::move(document));
    return handle;
  });
}

const char* pde_describe_forms(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    const Document* value = FindDocument(document);
    if (!value) return nullptr;
    g_result = SerializeForms(*value);
    return g_result.c_str();
  });
}

const char* pde_describe_outline(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    const Document* value = FindDocument(document);
    if (!value) return nullptr;
    g_result = SerializeOutline(*value);
    return g_result.c_str();
  });
}

const char* pde_describe_annotations(uint32_t document, uint32_t page_index) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    const Document* value = FindDocument(document);
    if (!value) return nullptr;
    if (page_index >= value->metadata.pages.size()) {
      SetError("INVALID_REQUEST", "The annotation page does not exist.");
      return nullptr;
    }
    g_result = SerializeAnnotations(*value, page_index);
    return g_result.empty() ? nullptr : g_result.c_str();
  });
}

const char* pde_recovery_resources(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    const Document* value = FindDocument(document);
    if (!value) return nullptr;
    g_result = "{\"fonts\":[";
    bool first = true;
    for (const auto& [id, font] : value->font_resources) {
      if (!first) g_result += ',';
      first = false;
      AppendJsonString(&g_result, id);
    }
    g_result += "],\"fontFaces\":[";
    first = true;
    for (const auto& [id, font] : value->font_resources) {
      if (!first) g_result += ',';
      first = false;
      AppendFontFaceInfo(&g_result, font->face, id);
    }
    g_result += "],\"resources\":[";
    first = true;
    for (const auto& [id, image] : value->image_resources) {
      if (!first) g_result += ',';
      first = false;
      g_result += "{\"id\":";
      AppendJsonString(&g_result, id);
      g_result += ",\"kind\":\"image\",\"width\":" + std::to_string(image->width) +
                  ",\"height\":" + std::to_string(image->height) + '}';
    }
    for (const auto& [id, pdf] : value->pdf_resources) {
      if (!first) g_result += ',';
      first = false;
      g_result += "{\"id\":";
      AppendJsonString(&g_result, id);
      g_result += ",\"kind\":\"pdf\",\"pageCount\":" + std::to_string(pdf->page_count) + '}';
    }
    g_result += "]}";
    return g_result.c_str();
  });
}

const char* pde_export_recovery(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    Document* value = FindDocument(document);
    if (!value || !BuildRecoverySnapshot(value, &g_binary)) return nullptr;
    if (g_binary.size() > std::numeric_limits<uint32_t>::max()) {
      g_binary.clear();
      SetError("RESOURCE_LIMIT", "This recovery snapshot requires native file storage.");
      return nullptr;
    }
    g_result = RecoverySnapshotInfo(*value, "bytes");
    return g_result.c_str();
  });
}

const char* pde_export_recovery_file_utf8(uint32_t document, const char* path_utf8) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    Document* value = FindDocument(document);
    if (!value || !ValidateUtf8Argument(path_utf8, "Recovery path", false)) return nullptr;
    std::vector<uint8_t> snapshot;
    if (!BuildRecoverySnapshot(value, &snapshot)) return nullptr;
    DestinationFile destination;
    if (!destination.Open(path_utf8) || !destination.Write(snapshot.data(), snapshot.size()) ||
        !destination.Finish()) {
      SetError("SAVE_FAILED", "The recovery snapshot could not be written to its staging file.");
      return nullptr;
    }
    g_result = RecoverySnapshotInfo(*value, "native-file");
    return g_result.c_str();
  });
}

uint32_t pde_restore_recovery(const uint8_t* bytes, uint32_t length,
                              const char* password_utf8) {
  return Guard<uint32_t>(0, [&]() -> uint32_t {
    BeginOperation();
    if (!RequireInitialized() || !bytes || !length ||
        !ValidateUtf8Argument(password_utf8 ? password_utf8 : "", "Password", true)) {
      if (g_error_code.empty()) SetError("INVALID_REQUEST", "Recovery bytes are required.");
      return 0;
    }
    return RestoreRecoverySnapshot({bytes, length}, password_utf8);
  });
}

uint32_t pde_restore_recovery_file_utf8(const char* path_utf8,
                                        const char* password_utf8) {
  return Guard<uint32_t>(0, [&]() -> uint32_t {
    BeginOperation();
    if (!RequireInitialized() || !ValidateUtf8Argument(path_utf8, "Recovery path", false) ||
        !ValidateUtf8Argument(password_utf8 ? password_utf8 : "", "Password", true)) return 0;
    Document source;
    source.file_source = FileAccessIface::Create();
    const std::string native_path = pdf_editor::NativeFilePathUtf8(path_utf8);
    if (native_path.empty() || !source.file_source || !source.file_source->Open(native_path.c_str())) {
      SetError("INVALID_REQUEST", "The recovery snapshot could not be opened.");
      return 0;
    }
    const int64_t size = source.file_source->GetSize();
    if (size <= 0 || static_cast<uint64_t>(size) > std::numeric_limits<size_t>::max()) {
      SetError("INVALID_REQUEST", "The recovery snapshot size is invalid.");
      return 0;
    }
    std::vector<uint8_t> bytes(static_cast<size_t>(size));
    if (!ReadFileSource(&source, 0, bytes.data(), bytes.size())) {
      SetError("INVALID_REQUEST", "The recovery snapshot could not be read.");
      return 0;
    }
    return RestoreRecoverySnapshot(bytes, password_utf8);
  });
}

const char* pde_document_id(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    const Document* value = FindDocument(document);
    if (!value) return nullptr;
    g_result = value->document_id;
    return g_result.c_str();
  });
}

uint32_t pde_document_revision(uint32_t document) {
  return Guard<uint32_t>(0, [&]() -> uint32_t {
    BeginOperation();
    const Document* value = FindDocument(document);
    return value ? value->revision : 0;
  });
}

int pde_close(uint32_t document) {
  return Guard<int>(0, [&]() {
    BeginOperation();
    if (!RequireInitialized()) {
      return 0;
    }
    const auto found = g_documents.find(document);
    if (found == g_documents.end()) {
      SetError("DOCUMENT_NOT_FOUND", "The document handle is not open.");
      return 0;
    }
    g_documents.erase(found);
    return 1;
  });
}

const char* pde_document_info(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    g_result = SerializeDocumentInfo(*value);
    return g_result.c_str();
  });
}

const char* pde_describe_page(uint32_t document, uint32_t page_index) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    PageData page;
    if (!BuildPageData(value, page_index, &page)) {
      return nullptr;
    }
    g_result = SerializePage(page);
    return g_result.c_str();
  });
}

const char* pde_extract_page(uint32_t document, uint32_t page_index) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    PageData page;
    if (!BuildPageData(value, page_index, &page)) {
      return nullptr;
    }
    g_result = SerializeTextBlocks(page.text_blocks);
    return g_result.c_str();
  });
}

const char* pde_render(uint32_t document,
                       uint32_t page_index,
                       uint32_t width,
                       uint32_t height,
                       int32_t offset_x,
                       int32_t offset_y,
                       uint32_t full_width,
                       uint32_t full_height) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (page_index > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        page_index >= static_cast<uint32_t>(FPDF_GetPageCount(value->pdf))) {
      SetError("INVALID_REQUEST", "The page index is out of range.");
      return nullptr;
    }
    if (width == 0 || height == 0 || full_width == 0 || full_height == 0 ||
        width > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        height > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        full_width > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        full_height > static_cast<uint32_t>(std::numeric_limits<int>::max()) ||
        offset_x > 0 || offset_y > 0) {
      SetError("INVALID_REQUEST", "Render dimensions and offsets are invalid.");
      return nullptr;
    }
    if (static_cast<uint64_t>(-static_cast<int64_t>(offset_x)) + width >
            full_width ||
        static_cast<uint64_t>(-static_cast<int64_t>(offset_y)) + height >
            full_height) {
      SetError("INVALID_REQUEST",
               "The render viewport is outside the full page.");
      return nullptr;
    }

    const uint64_t stride64 = static_cast<uint64_t>(width) * 4;
    const uint64_t byte_size64 = stride64 * height;
    if (stride64 > static_cast<uint64_t>(std::numeric_limits<int>::max()) ||
        byte_size64 > std::numeric_limits<uint32_t>::max() ||
        byte_size64 > std::numeric_limits<size_t>::max()) {
      SetError("RESOURCE_LIMIT", "The render bitmap is too large.");
      return nullptr;
    }

    ScopedPage page(FPDF_LoadPage(value->pdf, static_cast<int>(page_index)));
    if (!page.get()) {
      SetError("CORE_UNAVAILABLE", "The PDF page could not be loaded.");
      return nullptr;
    }

    const int stride = static_cast<int>(stride64);
    g_binary.resize(static_cast<size_t>(byte_size64));
    ScopedBitmap bitmap(
        FPDFBitmap_CreateEx(static_cast<int>(width), static_cast<int>(height),
                            FPDFBitmap_BGRA, g_binary.data(), stride));
    if (!bitmap.get()) {
      SetAllocationError();
      return nullptr;
    }
    if (!FPDFBitmap_FillRect(bitmap.get(), 0, 0, static_cast<int>(width),
                             static_cast<int>(height), 0xffffffff)) {
      SetUnexpectedError();
      return nullptr;
    }
    FPDF_RenderPageBitmap(bitmap.get(), page.get(), offset_x, offset_y,
                          static_cast<int>(full_width),
                          static_cast<int>(full_height), 0, FPDF_ANNOT);
    if (CPDFDocumentFromFPDFDocument(value->pdf)->GetRoot()->KeyExist("AcroForm")) {
      FPDF_FORMFILLINFO callbacks{};
      callbacks.version = 2;
      std::unique_ptr<std::remove_pointer_t<FPDF_FORMHANDLE>,
                      decltype(&FPDFDOC_ExitFormFillEnvironment)> form(
          FPDFDOC_InitFormFillEnvironment(value->pdf, &callbacks),
          &FPDFDOC_ExitFormFillEnvironment);
      if (!form) {
        SetError("CORE_UNAVAILABLE", "The form appearances could not be rendered.");
        return nullptr;
      }
      // Draw existing widget appearances only. No document/page actions or
      // JavaScript callbacks are executed by the editor.
      FORM_OnAfterLoadPage(page.get(), form.get());
      FPDF_FFLDraw(form.get(), bitmap.get(), page.get(), offset_x, offset_y,
                   static_cast<int>(full_width), static_cast<int>(full_height), 0, 0);
      FORM_OnBeforeClosePage(page.get(), form.get());
    }
    for (size_t offset = 0; offset < g_binary.size(); offset += 4) {
      std::swap(g_binary[offset], g_binary[offset + 2]);
    }

    g_result.append("{\"width\":");
    AppendJsonUnsigned(&g_result, width);
    g_result.append(",\"height\":");
    AppendJsonUnsigned(&g_result, height);
    g_result.append(",\"stride\":");
    AppendJsonUnsigned(&g_result, stride64);
    g_result.append(",\"format\":\"rgba\",\"revision\":");
    AppendJsonUnsigned(&g_result, value->revision);
    g_result.push_back('}');
    return g_result.c_str();
  });
}

const char* pde_save_memory(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    std::string result;
    result.append("{\"docId\":");
    AppendJsonString(&result, value->document_id);
    result.append(",\"savedRevision\":");
    AppendJsonUnsigned(&result, value->revision);
    result.append(",\"kind\":\"bytes\"}");
    const bool saved = value->transactions.empty() ? CopySourceToMemory(value)
                                                   : SavePdfToMemory(value);
    if (!saved) {
      return nullptr;
    }
    g_result.swap(result);
    return g_result.c_str();
  });
}

const char* pde_extract_pages_memory(uint32_t document,
                                     const char* const* page_ids,
                                     uint32_t page_count) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) return nullptr;
    Document* value = FindDocument(document);
    if (!value) return nullptr;
    FPDF_DOCUMENT pdf = nullptr;
    if (!BuildExtractedPdf(value, page_ids, page_count, &pdf)) return nullptr;
    ScopedDocument extracted(pdf);
    BinaryPdfWriter writer;
    if (!FPDF_SaveAsCopy(extracted.get(), &writer, SaveFlags(*value)) ||
        writer.failed || writer.bytes.empty()) {
      SetError("SAVE_FAILED", "The extracted PDF could not be serialized.");
      return nullptr;
    }
    std::string result = SerializeExtractedPagesResult(
        *value, page_ids, page_count, "bytes");
    g_binary.swap(writer.bytes);
    g_result.swap(result);
    return g_result.c_str();
  });
}

const char* pde_extract_pages_file_utf8(uint32_t document,
                                        const char* const* page_ids,
                                        uint32_t page_count,
                                        const char* staging_path_utf8) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized() ||
        !ValidateUtf8Argument(staging_path_utf8, "Staging path", false))
      return nullptr;
    Document* value = FindDocument(document);
    if (!value) return nullptr;
    FPDF_DOCUMENT pdf = nullptr;
    if (!BuildExtractedPdf(value, page_ids, page_count, &pdf)) return nullptr;
    ScopedDocument extracted(pdf);
    std::string result = SerializeExtractedPagesResult(
        *value, page_ids, page_count, "native-file");
    DestinationFile output;
    if (!output.Open(staging_path_utf8)) {
      SetError("SAVE_FAILED", "The extraction staging file could not be created.");
      return nullptr;
    }
    DestinationPdfWriter writer(&output);
    if (!FPDF_SaveAsCopy(extracted.get(), &writer, SaveFlags(*value)) ||
        writer.failed || !output.Finish()) {
      SetError("SAVE_FAILED", "The extracted PDF could not be written.");
      return nullptr;
    }
    g_result.swap(result);
    return g_result.c_str();
  });
}

int pde_save_file_utf8(uint32_t document, const char* destination_utf8) {
  return Guard<int>(0, [&]() {
    BeginOperation();
    if (!RequireInitialized() ||
        !ValidateUtf8Argument(destination_utf8, "Destination path", false)) {
      return 0;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return 0;
    }
    const bool saved = value->transactions.empty()
                           ? CopySourceToFile(value, destination_utf8)
                           : SavePdfToFile(value, destination_utf8);
    if (!saved) {
      return 0;
    }
    return 1;
  });
}

uint32_t pde_text_edit_stride(void) {
  return static_cast<uint32_t>(sizeof(PdeTextEdit));
}

uint32_t pde_edit_command_stride(void) {
  return static_cast<uint32_t>(sizeof(PdeEditCommand));
}

int pde_register_truetype_font(const char* font_id,
                               const uint8_t* bytes,
                               uint32_t length) {
  return Guard<int>(0, [&]() {
    BeginOperation();
    return RegisterFontResource(font_id, bytes, length, 0,
                                /*legacy_truetype_only=*/true)
               ? 1
               : 0;
  });
}

const char* pde_font_faces(const uint8_t* bytes, uint32_t length) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    if (!bytes || length == 0 || length > kMaxFontBytes) {
      SetError("INVALID_REQUEST", "Font bytes are required.");
      return nullptr;
    }
    std::vector<pdf_editor::FontFaceInfo> faces;
    std::string error_code;
    std::string error_message;
    if (!pdf_editor::InspectFontFaces(std::span<const uint8_t>(bytes, length),
                                      &faces, &error_code, &error_message)) {
      SetError(std::move(error_code), std::move(error_message));
      return nullptr;
    }
    g_result.push_back('[');
    for (size_t index = 0; index < faces.size(); ++index) {
      if (index) {
        g_result.push_back(',');
      }
      AppendFontFaceInfo(&g_result, faces[index]);
    }
    g_result.push_back(']');
    return g_result.c_str();
  });
}

const char* pde_register_font(const char* font_id,
                              const uint8_t* bytes,
                              uint32_t length,
                              uint32_t face_index) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    const std::shared_ptr<const FontResource> resource = RegisterFontResource(
        font_id, bytes, length, face_index, /*legacy_truetype_only=*/false);
    if (!resource) {
      return nullptr;
    }
    AppendFontFaceInfo(&g_result, resource->face, resource->id);
    return g_result.c_str();
  });
}

int pde_register_rgba_image(uint32_t document,
                            const char* id,
                            uint32_t width,
                            uint32_t height,
                            const uint8_t* rgba,
                            uint32_t length) {
  return Guard<int>(0, [&]() {
    BeginOperation();
    if (!RequireInitialized() || !ValidateId(id, "Resource ID")) {
      return 0;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return 0;
    }
    const uint64_t expected =
        static_cast<uint64_t>(width) * static_cast<uint64_t>(height) * 4;
    if (width == 0 || height == 0 || !rgba || expected != length) {
      SetError("INVALID_REQUEST",
               "RGBA8 image bytes must exactly match width * height * 4.");
      return 0;
    }
    if (value->pdf_resources.contains(id)) {
      SetError("INVALID_REQUEST",
               "The resource ID is already registered with another kind.");
      return 0;
    }
    const auto existing = value->image_resources.find(id);
    if (existing != value->image_resources.end()) {
      if (existing->second->width == width &&
          existing->second->height == height &&
          existing->second->rgba.size() == length &&
          std::equal(existing->second->rgba.begin(),
                     existing->second->rgba.end(), rgba)) {
        return 1;
      }
      SetError("INVALID_REQUEST",
               "The resource ID is already registered with different bytes.");
      return 0;
    }
    auto resource = std::make_shared<ImageResource>();
    resource->id = id;
    resource->width = width;
    resource->height = height;
    resource->rgba.assign(rgba, rgba + length);
    value->image_resources.emplace(resource->id, std::move(resource));
    return 1;
  });
}

const char* pde_register_pdf_resource(uint32_t document,
                                      const char* id,
                                      const uint8_t* bytes,
                                      uint32_t length) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized() || !ValidateId(id, "Resource ID")) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (!bytes || length == 0) {
      SetError("INVALID_REQUEST", "Immutable PDF resource bytes are required.");
      return nullptr;
    }
    if (value->image_resources.contains(id)) {
      SetError("INVALID_REQUEST",
               "The resource ID is already registered with another kind.");
      return nullptr;
    }
    const auto existing = value->pdf_resources.find(id);
    if (existing != value->pdf_resources.end()) {
      if (existing->second->bytes.size() != length ||
          !std::equal(existing->second->bytes.begin(),
                      existing->second->bytes.end(), bytes)) {
        SetError("INVALID_REQUEST",
                 "The resource ID is already registered with different bytes.");
        return nullptr;
      }
      g_result.append("{\"id\":");
      AppendJsonString(&g_result, existing->second->id);
      g_result.append(",\"kind\":\"pdf\",\"pageCount\":");
      AppendJsonUnsigned(&g_result, existing->second->page_count);
      g_result.push_back('}');
      return g_result.c_str();
    }
    ScopedDocument resource_pdf(FPDF_LoadMemDocument64(bytes, length, nullptr));
    if (!resource_pdf.get()) {
      SetError("INVALID_REQUEST",
               "The resource must be an unencrypted readable PDF.");
      return nullptr;
    }
    const int page_count = FPDF_GetPageCount(resource_pdf.get());
    if (page_count <= 0) {
      SetError("INVALID_REQUEST", "The PDF resource contains no pages.");
      return nullptr;
    }
    auto resource = std::make_shared<PdfResource>();
    resource->id = id;
    resource->bytes.assign(bytes, bytes + length);
    resource->page_count = static_cast<uint32_t>(page_count);
    value->pdf_resources.emplace(resource->id, resource);
    g_result.append("{\"id\":");
    AppendJsonString(&g_result, resource->id);
    g_result.append(",\"kind\":\"pdf\",\"pageCount\":");
    AppendJsonUnsigned(&g_result, resource->page_count);
    g_result.push_back('}');
    return g_result.c_str();
  });
}

const char* pde_preview_text(uint32_t document, const PdeTextEdit* edit) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value || !RequireEditingAllowed(*value)) {
      return nullptr;
    }
    if (!edit) {
      SetError("INVALID_REQUEST", "A text edit preview is required.");
      return nullptr;
    }
    EditTransaction preview;
    preview.id = "preview";
    preview.commands.resize(1);
    if (!CopyTextEdit(*value, *edit, &preview.commands[0])) {
      return nullptr;
    }
    auto resources = value->font_resources;
    if (!AddRequiredFontResources(preview, &resources)) {
      return nullptr;
    }
    auto transactions = value->transactions;
    transactions.push_back(preview);
    Rect bounds;
    bool overflow = false;
    FPDF_DOCUMENT rebuilt = nullptr;
    CandidateMetadata metadata;
    TextInsertLayoutResult paragraph_layout;
    if (!RebuildCandidate(value, transactions, resources, &rebuilt, &metadata,
                          &bounds, &overflow, &paragraph_layout)) {
      return nullptr;
    }
    ScopedDocument candidate(rebuilt);
    g_result = paragraph_layout.lines.empty()
        ? SerializeLayoutResult(bounds, overflow, preview.commands[0])
        : SerializeTextInsertLayoutResult(paragraph_layout, preview.commands[0].font_id);
    return g_result.c_str();
  });
}

const char* pde_apply_text(uint32_t document,
                           uint32_t base_revision,
                           const char* transaction_id,
                           const PdeTextEdit* edits,
                           uint32_t count) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    EditTransaction transaction;
    if (!BuildTextTransaction(*value, transaction_id, edits, count,
                              &transaction)) {
      return nullptr;
    }
    return CommitGenericTransaction(value, base_revision,
                                    std::move(transaction));
  });
}

const char* pde_preview_commands(uint32_t document,
                                 uint32_t base_revision,
                                 const PdeEditCommand* commands,
                                 uint32_t count) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    EditTransaction transaction;
    if (!BuildCommandTransaction(nullptr, commands, count, &transaction)) {
      return nullptr;
    }
    return PreviewGenericTransaction(value, base_revision, transaction);
  });
}

const char* pde_preview_text_insert(uint32_t document,
                                    uint32_t base_revision,
                                    const PdeEditCommand* command) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (!command || (command->type != static_cast<uint32_t>(EditType::kTextInsert) &&
                     command->type != static_cast<uint32_t>(EditType::kTextReflow))) {
      SetError("INVALID_REQUEST",
               "Text layout preview requires one insertion or paragraph reflow command.");
      return nullptr;
    }
    EditTransaction transaction;
    if (!BuildCommandTransaction(nullptr, command, 1, &transaction) ||
        !RequireEditingAllowed(*value) ||
        !ValidateBaseRevision(*value, base_revision) ||
        !ValidateNewCommandIds(*value, transaction)) {
      return nullptr;
    }
    auto resources = value->font_resources;
    if (!AddRequiredFontResources(transaction, &resources)) {
      return nullptr;
    }
    auto transactions = value->transactions;
    transactions.push_back(transaction);
    FPDF_DOCUMENT rebuilt = nullptr;
    CandidateMetadata metadata;
    TextInsertLayoutResult layout;
    if (!RebuildCandidate(value, transactions, resources, &rebuilt, &metadata,
                          nullptr, nullptr, &layout, true)) {
      return nullptr;
    }
    ScopedDocument candidate(rebuilt);
    g_result = SerializeTextInsertLayoutResult(
        layout, transaction.commands.front().font_id);
    return g_result.c_str();
  });
}

const char* pde_apply_commands(uint32_t document,
                               uint32_t base_revision,
                               const char* transaction_id,
                               const PdeEditCommand* commands,
                               uint32_t count) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (!ValidateId(transaction_id, "Transaction ID")) {
      return nullptr;
    }
    EditTransaction transaction;
    if (!BuildCommandTransaction(transaction_id, commands, count,
                                 &transaction)) {
      return nullptr;
    }
    return CommitGenericTransaction(value, base_revision,
                                    std::move(transaction));
  });
}

const char* pde_confirm_save(uint32_t document, uint32_t saved_revision) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (saved_revision > value->revision) {
      SetError("INVALID_REQUEST",
               "The confirmed saved revision is newer than the document.");
      return nullptr;
    }
    value->saved_revision = saved_revision;
    g_result = SerializeDocumentInfo(*value);
    return g_result.c_str();
  });
}

const char* pde_undo(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (value->undoable_count == 0 || value->transactions.empty()) {
      SetError("UNSUPPORTED_CAPABILITY", "There is no edit to undo.");
      return nullptr;
    }
    if (value->revision == std::numeric_limits<uint32_t>::max()) {
      SetError("RESOURCE_LIMIT", "The document revision limit was reached.");
      return nullptr;
    }

    const EditTransaction transaction = value->transactions.back();
    auto transactions = value->transactions;
    transactions.pop_back();
    auto redo = value->redo_transactions;
    redo.push_back(transaction);
    FPDF_DOCUMENT rebuilt = nullptr;
    CandidateMetadata metadata;
    if (!RebuildCandidate(value, transactions, value->font_resources, &rebuilt,
                          &metadata)) {
      return nullptr;
    }
    ScopedDocument candidate(rebuilt);
    const size_t undoable_count = value->undoable_count - 1;
    std::string result =
        SerializeCommitResult(*value, value->revision + 1, undoable_count, true,
                              transaction, metadata);

    InstallCandidate(value, candidate.release(), std::move(metadata));
    value->transactions.swap(transactions);
    value->redo_transactions.swap(redo);
    value->undoable_count = undoable_count;
    ++value->revision;
    g_result.swap(result);
    return g_result.c_str();
  });
}

const char* pde_redo(uint32_t document) {
  return Guard<const char*>(nullptr, [&]() -> const char* {
    BeginOperation();
    if (!RequireInitialized()) {
      return nullptr;
    }
    Document* value = FindDocument(document);
    if (!value) {
      return nullptr;
    }
    if (value->redo_transactions.empty()) {
      SetError("UNSUPPORTED_CAPABILITY", "There is no edit to redo.");
      return nullptr;
    }
    if (value->revision == std::numeric_limits<uint32_t>::max()) {
      SetError("RESOURCE_LIMIT", "The document revision limit was reached.");
      return nullptr;
    }

    const EditTransaction transaction = value->redo_transactions.back();
    auto transactions = value->transactions;
    transactions.push_back(transaction);
    auto redo = value->redo_transactions;
    redo.pop_back();
    FPDF_DOCUMENT rebuilt = nullptr;
    CandidateMetadata metadata;
    if (!RebuildCandidate(value, transactions, value->font_resources, &rebuilt,
                          &metadata)) {
      return nullptr;
    }
    ScopedDocument candidate(rebuilt);
    const size_t undoable_count =
        std::min(kUndoLimit, value->undoable_count + 1);
    std::string result =
        SerializeCommitResult(*value, value->revision + 1, undoable_count,
                              !redo.empty(), transaction, metadata);

    InstallCandidate(value, candidate.release(), std::move(metadata));
    value->transactions.swap(transactions);
    value->redo_transactions.swap(redo);
    value->undoable_count = undoable_count;
    ++value->revision;
    g_result.swap(result);
    return g_result.c_str();
  });
}

const uint8_t* pde_binary_data(void) {
  return g_binary.empty() ? nullptr : g_binary.data();
}

uint32_t pde_binary_size(void) {
  return static_cast<uint32_t>(g_binary.size());
}

const char* pde_error_code(void) {
  return g_error_code.c_str();
}

const char* pde_error_message(void) {
  return g_error_message.c_str();
}

}  // extern "C"
