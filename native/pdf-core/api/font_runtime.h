#ifndef PDF_EDITOR_FONT_RUNTIME_H_
#define PDF_EDITOR_FONT_RUNTIME_H_

#include <stdint.h>

#include <span>
#include <string>
#include <vector>

#include "public/fpdf_edit.h"

namespace pdf_editor {

enum class FontFormat {
  kTrueType,
  kOpenTypeCff,
  // CFF2 source faces are instantiated to standalone CFF1 in PrepareFontFace().
  kOpenTypeCff2,
};

struct FontFaceInfo {
  uint32_t index = 0;
  std::string family;
  std::string style;
  FontFormat format = FontFormat::kTrueType;
  uint16_t weight = 400;
  bool italic = false;
  uint16_t fs_type = 0;
  bool editable_embedding = false;
  bool no_subsetting = false;
};

struct PreparedFontFace {
  FontFaceInfo info;
  // Standalone SFNT; CFF2 sources are pinned at default axis values and
  // converted to static CFF1 before shaping or embedding in PDF.
  std::vector<uint8_t> sfnt;
};

const char* FontFormatName(FontFormat format);

bool InspectFontFaces(std::span<const uint8_t> bytes,
                      std::vector<FontFaceInfo>* faces,
                      std::string* error_code,
                      std::string* error_message);

bool PrepareFontFace(std::span<const uint8_t> bytes,
                     uint32_t face_index,
                     PreparedFontFace* face,
                     std::string* error_code,
                     std::string* error_message);

// Loads a validated standalone face as a composite PDF font with one BMP
// character code per Unicode value. TrueType uses CIDFontType2, FontFile2, and
// CIDToGIDMap. OpenType/CFF (including prepared static CFF2 instances) uses
// CIDFontType0, FontFile3 /OpenType, and a
// custom Encoding CMap from character codes to glyph CIDs. Both representations
// carry an exact ToUnicode map, including distinct Unicode aliases of one glyph.
FPDF_FONT LoadFontFace(FPDF_DOCUMENT document,
                       const FontFaceInfo& info,
                       std::span<const uint8_t> sfnt,
                       std::string* error_message);

}  // namespace pdf_editor

#endif  // PDF_EDITOR_FONT_RUNTIME_H_
