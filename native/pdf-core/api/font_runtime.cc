#include "font_runtime.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <map>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/fpdfapi/font/cpdf_cidfont.h"
#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_docpagedata.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fxcrt/bytestring.h"
#include "core/fxge/cfx_face.h"
#include "core/fxge/cfx_font.h"
#include "core/fxge/fx_font.h"
#include "core/fxge/fx_fontencoding.h"
#include "fpdfsdk/cpdfsdk_helpers.h"

namespace pdf_editor {
namespace {

constexpr uint32_t Tag(char a, char b, char c, char d) {
  return (static_cast<uint32_t>(static_cast<uint8_t>(a)) << 24) |
         (static_cast<uint32_t>(static_cast<uint8_t>(b)) << 16) |
         (static_cast<uint32_t>(static_cast<uint8_t>(c)) << 8) |
         static_cast<uint32_t>(static_cast<uint8_t>(d));
}

constexpr uint32_t kSfntTrueType = 0x00010000U;
constexpr uint32_t kSfntOpenType = Tag('O', 'T', 'T', 'O');
constexpr uint32_t kTtcTag = Tag('t', 't', 'c', 'f');
constexpr uint32_t kChecksumMagic = 0xb1b0afbaU;
constexpr uint32_t kHeadTag = Tag('h', 'e', 'a', 'd');
constexpr uint32_t kHheaTag = Tag('h', 'h', 'e', 'a');
constexpr uint32_t kHmtxTag = Tag('h', 'm', 't', 'x');
constexpr uint32_t kMaxpTag = Tag('m', 'a', 'x', 'p');
constexpr uint32_t kCmapTag = Tag('c', 'm', 'a', 'p');
constexpr uint32_t kNameTag = Tag('n', 'a', 'm', 'e');
constexpr uint32_t kOs2Tag = Tag('O', 'S', '/', '2');
constexpr uint32_t kGlyfTag = Tag('g', 'l', 'y', 'f');
constexpr uint32_t kLocaTag = Tag('l', 'o', 'c', 'a');
constexpr uint32_t kCffTag = Tag('C', 'F', 'F', ' ');
constexpr uint32_t kCff2Tag = Tag('C', 'F', 'F', '2');
constexpr uint32_t kMaxFaces = 1024;
constexpr uint16_t kMaxTables = 256;

uint16_t ReadU16(std::span<const uint8_t> bytes, size_t offset) {
  return static_cast<uint16_t>((static_cast<uint16_t>(bytes[offset]) << 8) |
                               bytes[offset + 1]);
}

int16_t ReadS16(std::span<const uint8_t> bytes, size_t offset) {
  return static_cast<int16_t>(ReadU16(bytes, offset));
}

uint32_t ReadU32(std::span<const uint8_t> bytes, size_t offset) {
  return (static_cast<uint32_t>(bytes[offset]) << 24) |
         (static_cast<uint32_t>(bytes[offset + 1]) << 16) |
         (static_cast<uint32_t>(bytes[offset + 2]) << 8) |
         static_cast<uint32_t>(bytes[offset + 3]);
}

void WriteU16(std::vector<uint8_t>* bytes, size_t offset, uint16_t value) {
  (*bytes)[offset] = static_cast<uint8_t>(value >> 8);
  (*bytes)[offset + 1] = static_cast<uint8_t>(value);
}

void WriteU32(std::vector<uint8_t>* bytes, size_t offset, uint32_t value) {
  (*bytes)[offset] = static_cast<uint8_t>(value >> 24);
  (*bytes)[offset + 1] = static_cast<uint8_t>(value >> 16);
  (*bytes)[offset + 2] = static_cast<uint8_t>(value >> 8);
  (*bytes)[offset + 3] = static_cast<uint8_t>(value);
}

bool RangeFits(size_t offset, size_t length, size_t size) {
  return offset <= size && length <= size - offset;
}

void SetFailure(std::string code,
                std::string message,
                std::string* error_code,
                std::string* error_message) {
  *error_code = std::move(code);
  *error_message = std::move(message);
}

struct TableRecord {
  uint32_t tag = 0;
  uint32_t checksum = 0;
  uint32_t offset = 0;
  uint32_t length = 0;
};

struct ParsedFace {
  FontFaceInfo info;
  uint32_t sfnt_version = 0;
  uint32_t directory_offset = 0;
  std::vector<TableRecord> tables;
};

struct ParsedContainer {
  bool collection = false;
  std::vector<ParsedFace> faces;
};

const TableRecord* FindTable(const ParsedFace& face, uint32_t tag) {
  const auto found = std::find_if(
      face.tables.begin(), face.tables.end(),
      [tag](const TableRecord& table) { return table.tag == tag; });
  return found == face.tables.end() ? nullptr : &*found;
}

uint32_t TableChecksum(std::span<const uint8_t> bytes,
                       const TableRecord& table) {
  uint32_t sum = 0;
  const size_t padded = (static_cast<size_t>(table.length) + 3U) & ~size_t{3U};
  for (size_t offset = 0; offset < padded; offset += 4) {
    uint32_t value = 0;
    for (size_t byte = 0; byte < 4; ++byte) {
      const size_t table_offset = offset + byte;
      uint8_t datum = 0;
      if (table_offset < table.length) {
        datum = bytes[table.offset + table_offset];
        if (table.tag == kHeadTag && table_offset >= 8 && table_offset < 12) {
          datum = 0;
        }
      }
      value = (value << 8) | datum;
    }
    sum += value;
  }
  return sum;
}

uint16_t GreatestPowerOfTwo(uint16_t value) {
  uint16_t result = 1;
  while (result <= value / 2) {
    result = static_cast<uint16_t>(result * 2);
  }
  return result;
}

uint16_t Log2(uint16_t value) {
  uint16_t result = 0;
  while (value > 1) {
    value = static_cast<uint16_t>(value / 2);
    ++result;
  }
  return result;
}

bool ValidateCmap(std::span<const uint8_t> bytes,
                  const TableRecord& table,
                  std::string* error_code,
                  std::string* error_message) {
  if (table.length < 4) {
    SetFailure("INVALID_REQUEST", "The font cmap table is truncated.",
               error_code, error_message);
    return false;
  }
  const size_t base = table.offset;
  const uint16_t count = ReadU16(bytes, base + 2);
  if (ReadU16(bytes, base) != 0 || count == 0 ||
      !RangeFits(4, static_cast<size_t>(count) * 8, table.length)) {
    SetFailure("INVALID_REQUEST", "The font cmap directory is invalid.",
               error_code, error_message);
    return false;
  }

  bool has_unicode = false;
  for (uint16_t index = 0; index < count; ++index) {
    const size_t record = base + 4 + static_cast<size_t>(index) * 8;
    const uint16_t platform = ReadU16(bytes, record);
    const uint16_t encoding = ReadU16(bytes, record + 2);
    const uint32_t relative = ReadU32(bytes, record + 4);
    if (relative > table.length || table.length - relative < 4) {
      SetFailure("INVALID_REQUEST", "A font cmap subtable is out of range.",
                 error_code, error_message);
      return false;
    }
    const size_t subtable = base + relative;
    const uint16_t format = ReadU16(bytes, subtable);
    uint32_t subtable_length = 0;
    if (format == 8 || format == 10 || format == 12 || format == 13) {
      if (table.length - relative < 8) {
        SetFailure("INVALID_REQUEST", "A font cmap subtable is truncated.",
                   error_code, error_message);
        return false;
      }
      subtable_length = ReadU32(bytes, subtable + 4);
    } else if (format == 14) {
      if (table.length - relative < 6) {
        SetFailure("INVALID_REQUEST", "A font cmap subtable is truncated.",
                   error_code, error_message);
        return false;
      }
      subtable_length = ReadU32(bytes, subtable + 2);
    } else {
      subtable_length = ReadU16(bytes, subtable + 2);
    }
    if (subtable_length < 4 || subtable_length > table.length - relative) {
      SetFailure("INVALID_REQUEST", "A font cmap subtable length is invalid.",
                 error_code, error_message);
      return false;
    }
    if (platform == 0 || (platform == 3 && (encoding == 1 || encoding == 10))) {
      has_unicode = true;
    }
  }
  if (!has_unicode) {
    SetFailure("UNSUPPORTED_CAPABILITY",
               "The font has no supported Unicode character map.", error_code,
               error_message);
    return false;
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

bool DecodeUtf16Be(std::span<const uint8_t> value, std::string* output) {
  if (value.size() % 2 != 0) {
    return false;
  }
  output->clear();
  for (size_t offset = 0; offset < value.size(); offset += 2) {
    uint32_t code_point = ReadU16(value, offset);
    if (code_point >= 0xd800 && code_point <= 0xdbff) {
      if (offset + 4 > value.size()) {
        return false;
      }
      const uint32_t low = ReadU16(value, offset + 2);
      if (low < 0xdc00 || low > 0xdfff) {
        return false;
      }
      code_point = 0x10000 + ((code_point - 0xd800) << 10) + (low - 0xdc00);
      offset += 2;
    } else if (code_point >= 0xdc00 && code_point <= 0xdfff) {
      return false;
    }
    if (code_point != 0) {
      AppendUtf8(code_point, output);
    }
  }
  return true;
}

std::string DecodeSingleByteName(std::span<const uint8_t> value) {
  std::string output;
  output.reserve(value.size());
  for (uint8_t byte : value) {
    if (byte == 0) {
      continue;
    }
    if (byte < 0x80) {
      output.push_back(static_cast<char>(byte));
    } else {
      AppendUtf8(0xfffd, &output);
    }
  }
  return output;
}

void TrimName(std::string* value) {
  while (!value->empty() &&
         std::isspace(static_cast<unsigned char>(value->front()))) {
    value->erase(value->begin());
  }
  while (!value->empty() &&
         std::isspace(static_cast<unsigned char>(value->back()))) {
    value->pop_back();
  }
}

struct NameChoice {
  int score = -1;
  std::string value;
};

int NameScore(uint16_t platform, uint16_t encoding, uint16_t language) {
  if (platform == 3 && (encoding == 1 || encoding == 10)) {
    return language == 0x0409 ? 100 : 80;
  }
  if (platform == 0) {
    return 70;
  }
  if (platform == 1) {
    return language == 0 ? 60 : 40;
  }
  return -1;
}

bool ReadNames(std::span<const uint8_t> bytes,
               const TableRecord& table,
               std::string* family,
               std::string* style,
               std::string* error_code,
               std::string* error_message) {
  if (table.length < 6) {
    SetFailure("INVALID_REQUEST", "The font name table is truncated.",
               error_code, error_message);
    return false;
  }
  const size_t base = table.offset;
  const uint16_t count = ReadU16(bytes, base + 2);
  const uint16_t storage_offset = ReadU16(bytes, base + 4);
  if (!RangeFits(6, static_cast<size_t>(count) * 12, table.length) ||
      storage_offset > table.length) {
    SetFailure("INVALID_REQUEST", "The font name table directory is invalid.",
               error_code, error_message);
    return false;
  }

  std::array<NameChoice, 5> choices;
  // 1/2 are legacy family/style, 16/17 are typographic family/style, and 6 is
  // the PostScript name fallback.
  constexpr std::array<uint16_t, 5> kNameIds = {1, 2, 16, 17, 6};
  for (uint16_t index = 0; index < count; ++index) {
    const size_t record = base + 6 + static_cast<size_t>(index) * 12;
    const uint16_t platform = ReadU16(bytes, record);
    const uint16_t encoding = ReadU16(bytes, record + 2);
    const uint16_t language = ReadU16(bytes, record + 4);
    const uint16_t name_id = ReadU16(bytes, record + 6);
    const uint16_t length = ReadU16(bytes, record + 8);
    const uint16_t offset = ReadU16(bytes, record + 10);
    const auto wanted = std::find(kNameIds.begin(), kNameIds.end(), name_id);
    if (wanted == kNameIds.end()) {
      continue;
    }
    const int score = NameScore(platform, encoding, language);
    if (score < 0) {
      continue;
    }
    const size_t string_offset = static_cast<size_t>(storage_offset) + offset;
    if (!RangeFits(string_offset, length, table.length)) {
      SetFailure("INVALID_REQUEST", "A font name string is out of range.",
                 error_code, error_message);
      return false;
    }
    std::string decoded;
    const auto value = bytes.subspan(base + string_offset, length);
    if (platform == 0 || platform == 3) {
      if (!DecodeUtf16Be(value, &decoded)) {
        continue;
      }
    } else {
      decoded = DecodeSingleByteName(value);
    }
    TrimName(&decoded);
    if (decoded.empty()) {
      continue;
    }
    NameChoice& choice =
        choices[static_cast<size_t>(wanted - kNameIds.begin())];
    if (score > choice.score) {
      choice.score = score;
      choice.value = std::move(decoded);
    }
  }

  *family = !choices[2].value.empty() ? choices[2].value : choices[0].value;
  if (family->empty()) {
    *family = choices[4].value;
  }
  *style = !choices[3].value.empty() ? choices[3].value : choices[1].value;
  if (style->empty()) {
    *style = "Regular";
  }
  if (family->empty()) {
    SetFailure("INVALID_REQUEST", "The font has no usable family name.",
               error_code, error_message);
    return false;
  }
  return true;
}

bool ParseFace(std::span<const uint8_t> bytes,
               uint32_t directory_offset,
               uint32_t face_index,
               ParsedFace* face,
               std::string* error_code,
               std::string* error_message) {
  if (!RangeFits(directory_offset, 12, bytes.size())) {
    SetFailure("INVALID_REQUEST", "A font face directory is out of range.",
               error_code, error_message);
    return false;
  }
  const uint32_t version = ReadU32(bytes, directory_offset);
  if (version != kSfntTrueType && version != kSfntOpenType) {
    SetFailure("UNSUPPORTED_CAPABILITY",
               "Only TrueType outlines and OpenType CFF fonts are supported.",
               error_code, error_message);
    return false;
  }
  const uint16_t table_count = ReadU16(bytes, directory_offset + 4);
  if (table_count == 0 || table_count > kMaxTables ||
      !RangeFits(directory_offset + 12, static_cast<size_t>(table_count) * 16,
                 bytes.size())) {
    SetFailure("INVALID_REQUEST", "The SFNT table directory is invalid.",
               error_code, error_message);
    return false;
  }
  const uint16_t power = GreatestPowerOfTwo(table_count);
  if (ReadU16(bytes, directory_offset + 6) != power * 16 ||
      ReadU16(bytes, directory_offset + 8) != Log2(power) ||
      ReadU16(bytes, directory_offset + 10) != table_count * 16 - power * 16) {
    SetFailure("INVALID_REQUEST", "The SFNT search fields are invalid.",
               error_code, error_message);
    return false;
  }

  face->info.index = face_index;
  face->sfnt_version = version;
  face->directory_offset = directory_offset;
  face->tables.clear();
  face->tables.reserve(table_count);
  std::set<uint32_t> tags;
  for (uint16_t index = 0; index < table_count; ++index) {
    const size_t entry =
        directory_offset + 12 + static_cast<size_t>(index) * 16;
    TableRecord table{ReadU32(bytes, entry), ReadU32(bytes, entry + 4),
                      ReadU32(bytes, entry + 8), ReadU32(bytes, entry + 12)};
    if (!tags.insert(table.tag).second ||
        !RangeFits(table.offset, table.length, bytes.size())) {
      SetFailure("INVALID_REQUEST",
                 "The SFNT table directory contains an invalid table.",
                 error_code, error_message);
      return false;
    }
    if (table.length > 0 && (table.offset & 3U) != 0) {
      SetFailure("INVALID_REQUEST", "An SFNT table is not 4-byte aligned.",
                 error_code, error_message);
      return false;
    }
    if (TableChecksum(bytes, table) != table.checksum) {
      SetFailure("INVALID_REQUEST", "An SFNT table checksum is invalid.",
                 error_code, error_message);
      return false;
    }
    face->tables.push_back(table);
  }

  const TableRecord* head = FindTable(*face, kHeadTag);
  const TableRecord* hhea = FindTable(*face, kHheaTag);
  const TableRecord* hmtx = FindTable(*face, kHmtxTag);
  const TableRecord* maxp = FindTable(*face, kMaxpTag);
  const TableRecord* cmap = FindTable(*face, kCmapTag);
  const TableRecord* name = FindTable(*face, kNameTag);
  const TableRecord* os2 = FindTable(*face, kOs2Tag);
  if (!head || !hhea || !hmtx || !maxp || !cmap || !name || !os2 ||
      head->length < 54 || hhea->length < 36 || maxp->length < 6 ||
      os2->length < 10) {
    SetFailure("INVALID_REQUEST", "The font is missing a required SFNT table.",
               error_code, error_message);
    return false;
  }
  if (ReadU32(bytes, head->offset + 12) != 0x5f0f3cf5U) {
    SetFailure("INVALID_REQUEST", "The font head table magic is invalid.",
               error_code, error_message);
    return false;
  }

  const uint16_t glyph_count = ReadU16(bytes, maxp->offset + 4);
  const uint16_t horizontal_metrics = ReadU16(bytes, hhea->offset + 34);
  if (glyph_count == 0 || horizontal_metrics == 0 ||
      horizontal_metrics > glyph_count) {
    SetFailure("INVALID_REQUEST", "The font glyph metrics are invalid.",
               error_code, error_message);
    return false;
  }
  const uint64_t hmtx_bytes =
      static_cast<uint64_t>(horizontal_metrics) * 4 +
      static_cast<uint64_t>(glyph_count - horizontal_metrics) * 2;
  if (hmtx_bytes > hmtx->length) {
    SetFailure("INVALID_REQUEST", "The font hmtx table is truncated.",
               error_code, error_message);
    return false;
  }

  if (version == kSfntTrueType) {
    const TableRecord* glyf = FindTable(*face, kGlyfTag);
    const TableRecord* loca = FindTable(*face, kLocaTag);
    if (!glyf || !loca) {
      SetFailure("INVALID_REQUEST",
                 "The TrueType font is missing glyf or loca data.", error_code,
                 error_message);
      return false;
    }
    const int16_t loca_format = ReadS16(bytes, head->offset + 50);
    const uint64_t loca_bytes =
        static_cast<uint64_t>(glyph_count + 1) * (loca_format == 0 ? 2 : 4);
    if ((loca_format != 0 && loca_format != 1) || loca_bytes > loca->length) {
      SetFailure("INVALID_REQUEST", "The TrueType loca table is invalid.",
                 error_code, error_message);
      return false;
    }
    face->info.format = FontFormat::kTrueType;
  } else {
    const TableRecord* cff = FindTable(*face, kCffTag);
    if (!cff || cff->length < 4 || bytes[cff->offset] != 1) {
      SetFailure(
          FindTable(*face, kCff2Tag) ? "UNSUPPORTED_CAPABILITY"
                                     : "INVALID_REQUEST",
          FindTable(*face, kCff2Tag)
              ? "OpenType CFF2 fonts are not supported for PDF embedding."
              : "The OpenType font has no valid CFF table.",
          error_code, error_message);
      return false;
    }
    const uint8_t cff_header_size = bytes[cff->offset + 2];
    if (cff_header_size < 4 || cff_header_size > cff->length) {
      SetFailure("INVALID_REQUEST", "The OpenType CFF header is invalid.",
                 error_code, error_message);
      return false;
    }
    face->info.format = FontFormat::kOpenTypeCff;
  }

  if (!ValidateCmap(bytes, *cmap, error_code, error_message) ||
      !ReadNames(bytes, *name, &face->info.family, &face->info.style,
                 error_code, error_message)) {
    return false;
  }

  face->info.weight = ReadU16(bytes, os2->offset + 4);
  if (face->info.weight < 1 || face->info.weight > 1000) {
    face->info.weight = 400;
  }
  face->info.fs_type = ReadU16(bytes, os2->offset + 8);
  const bool installable = (face->info.fs_type & 0x000eU) == 0;
  const bool editable = (face->info.fs_type & 0x0008U) != 0;
  const bool restricted = (face->info.fs_type & 0x0002U) != 0;
  const bool bitmap_only = (face->info.fs_type & 0x0200U) != 0;
  face->info.editable_embedding =
      !restricted && !bitmap_only && (installable || editable);
  face->info.no_subsetting = (face->info.fs_type & 0x0100U) != 0;

  const uint16_t mac_style = ReadU16(bytes, head->offset + 44);
  face->info.italic = (mac_style & 0x0002U) != 0;
  if (os2->length >= 64) {
    face->info.italic =
        face->info.italic || (ReadU16(bytes, os2->offset + 62) & 0x0001U) != 0;
  }
  std::string lower_style = face->info.style;
  std::transform(lower_style.begin(), lower_style.end(), lower_style.begin(),
                 [](unsigned char value) {
                   return static_cast<char>(std::tolower(value));
                 });
  face->info.italic = face->info.italic ||
                      lower_style.find("italic") != std::string::npos ||
                      lower_style.find("oblique") != std::string::npos;
  return true;
}

bool ParseContainer(std::span<const uint8_t> bytes,
                    ParsedContainer* container,
                    std::string* error_code,
                    std::string* error_message) {
  if (bytes.size() < 12) {
    SetFailure("INVALID_REQUEST", "Font bytes are truncated.", error_code,
               error_message);
    return false;
  }
  std::vector<uint32_t> offsets;
  if (ReadU32(bytes, 0) == kTtcTag) {
    container->collection = true;
    const uint32_t version = ReadU32(bytes, 4);
    const uint32_t count = ReadU32(bytes, 8);
    if ((version != 0x00010000U && version != 0x00020000U) || count == 0 ||
        count > kMaxFaces ||
        !RangeFits(12, static_cast<size_t>(count) * 4, bytes.size())) {
      SetFailure("INVALID_REQUEST",
                 "The TrueType Collection header is invalid.", error_code,
                 error_message);
      return false;
    }
    offsets.reserve(count);
    for (uint32_t index = 0; index < count; ++index) {
      offsets.push_back(ReadU32(bytes, 12 + static_cast<size_t>(index) * 4));
    }
    if (version == 0x00020000U) {
      const size_t dsig = 12 + static_cast<size_t>(count) * 4;
      if (!RangeFits(dsig, 12, bytes.size())) {
        SetFailure("INVALID_REQUEST",
                   "The TrueType Collection DSIG header is truncated.",
                   error_code, error_message);
        return false;
      }
      const uint32_t dsig_length = ReadU32(bytes, dsig + 4);
      const uint32_t dsig_offset = ReadU32(bytes, dsig + 8);
      if (dsig_length != 0 &&
          !RangeFits(dsig_offset, dsig_length, bytes.size())) {
        SetFailure("INVALID_REQUEST",
                   "The TrueType Collection DSIG is invalid.", error_code,
                   error_message);
        return false;
      }
    }
  } else {
    container->collection = false;
    offsets.push_back(0);
  }

  container->faces.clear();
  container->faces.reserve(offsets.size());
  for (uint32_t index = 0; index < offsets.size(); ++index) {
    ParsedFace face;
    if (!ParseFace(bytes, offsets[index], index, &face, error_code,
                   error_message)) {
      return false;
    }
    container->faces.push_back(std::move(face));
  }
  return true;
}

std::vector<uint8_t> ExtractFace(std::span<const uint8_t> bytes,
                                 const ParsedFace& face) {
  std::vector<TableRecord> tables = face.tables;
  std::sort(tables.begin(), tables.end(),
            [](const TableRecord& left, const TableRecord& right) {
              return left.tag < right.tag;
            });
  const size_t directory_size = 12 + tables.size() * 16;
  size_t total_size = (directory_size + 3U) & ~size_t{3U};
  for (const TableRecord& table : tables) {
    total_size += (static_cast<size_t>(table.length) + 3U) & ~size_t{3U};
  }
  if (total_size > std::numeric_limits<uint32_t>::max()) {
    return {};
  }

  std::vector<uint8_t> output(total_size, 0);
  WriteU32(&output, 0, face.sfnt_version);
  WriteU16(&output, 4, static_cast<uint16_t>(tables.size()));
  const uint16_t power =
      GreatestPowerOfTwo(static_cast<uint16_t>(tables.size()));
  WriteU16(&output, 6, static_cast<uint16_t>(power * 16));
  WriteU16(&output, 8, Log2(power));
  WriteU16(&output, 10, static_cast<uint16_t>(tables.size() * 16 - power * 16));

  size_t destination = (directory_size + 3U) & ~size_t{3U};
  size_t head_destination = 0;
  for (size_t index = 0; index < tables.size(); ++index) {
    const TableRecord& source = tables[index];
    const size_t entry = 12 + index * 16;
    WriteU32(&output, entry, source.tag);
    WriteU32(&output, entry + 8, static_cast<uint32_t>(destination));
    WriteU32(&output, entry + 12, source.length);
    std::copy_n(bytes.begin() + source.offset, source.length,
                output.begin() + destination);
    if (source.tag == kHeadTag) {
      head_destination = destination;
      std::fill(output.begin() + destination + 8,
                output.begin() + destination + 12, 0);
    }
    const TableRecord copied{source.tag, 0, static_cast<uint32_t>(destination),
                             source.length};
    WriteU32(&output, entry + 4, TableChecksum(output, copied));
    destination += (static_cast<size_t>(source.length) + 3U) & ~size_t{3U};
  }
  if (head_destination == 0) {
    return {};
  }

  uint32_t checksum = 0;
  for (size_t offset = 0; offset < output.size(); offset += 4) {
    checksum += ReadU32(output, offset);
  }
  WriteU32(&output, head_destination + 8, kChecksumMagic - checksum);
  return output;
}

struct BmpGlyphMapping {
  uint16_t unicode = 0;
  uint16_t glyph_id = 0;
};

struct BmpCodeRange {
  uint16_t first = 0;
  uint16_t last = 0;
};

struct CidCodeRange {
  uint16_t first = 0;
  uint16_t last = 0;
  uint16_t first_cid = 0;
};

void AppendHexCode(uint16_t value, std::string* output) {
  constexpr char kHex[] = "0123456789ABCDEF";
  output->push_back('<');
  output->push_back(kHex[(value >> 12) & 0x0f]);
  output->push_back(kHex[(value >> 8) & 0x0f]);
  output->push_back(kHex[(value >> 4) & 0x0f]);
  output->push_back(kHex[value & 0x0f]);
  output->push_back('>');
}

bool BuildBmpGlyphMappings(std::span<const uint8_t> sfnt,
                           std::vector<BmpGlyphMapping>* mappings,
                           std::string* error_message) {
  CFX_Font font;
  if (!font.LoadFaceZeroFromSpan(pdfium::span<const uint8_t>(sfnt),
                                 /*force_vertical=*/false,
                                 /*object_tag=*/0)) {
    *error_message = "PDFium could not read the selected font face.";
    return false;
  }
  RetainPtr<CFX_Face> face = font.GetFace();
  if (!face || !face->SelectCharMap(fxge::FontEncoding::kUnicode)) {
    *error_message = "PDFium could not select the font Unicode character map.";
    return false;
  }

  mappings->clear();
  for (const CharCodeAndIndex& item : font.GetCharCodesAndIndices(0xffff)) {
    if (item.glyph_index == 0 || item.glyph_index > 0xffff ||
        (item.char_code >= 0xd800 && item.char_code <= 0xdfff)) {
      continue;
    }
    mappings->push_back(
        {static_cast<uint16_t>(item.char_code),
         static_cast<uint16_t>(item.glyph_index)});
  }
  if (mappings->empty()) {
    *error_message = "The selected font has no usable BMP characters.";
    return false;
  }
  return true;
}

std::string BuildToUnicodeCMap(
    const std::vector<BmpGlyphMapping>& mappings) {
  std::vector<BmpCodeRange> ranges;
  ranges.reserve(mappings.size());
  for (size_t index = 0; index < mappings.size();) {
    BmpCodeRange range{mappings[index].unicode, mappings[index].unicode};
    ++index;
    while (index < mappings.size() && range.last != 0xffff &&
           mappings[index].unicode == range.last + 1 &&
           (mappings[index].unicode >> 8) == (range.first >> 8)) {
      range.last = mappings[index].unicode;
      ++index;
    }
    ranges.push_back(range);
  }

  std::string output =
      "/CIDInit /ProcSet findresource begin\n"
      "12 dict begin\n"
      "begincmap\n"
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 "
      ">> def\n"
      "/CMapName /RegisteredFont-ToUnicode def\n"
      "/CMapType 2 def\n"
      "1 begincodespacerange\n"
      "<0000> <FFFF>\n"
      "endcodespacerange\n";
  constexpr size_t kEntriesPerBlock = 100;
  for (size_t first = 0; first < ranges.size();
       first += kEntriesPerBlock) {
    const size_t count =
        std::min(kEntriesPerBlock, ranges.size() - first);
    output += std::to_string(count) + " beginbfrange\n";
    for (size_t offset = 0; offset < count; ++offset) {
      const BmpCodeRange& range = ranges[first + offset];
      AppendHexCode(range.first, &output);
      output.push_back(' ');
      AppendHexCode(range.last, &output);
      output.push_back(' ');
      AppendHexCode(range.first, &output);
      output.push_back('\n');
    }
    output += "endbfrange\n";
  }
  output +=
      "endcmap\n"
      "CMapName currentdict /CMap defineresource pop\n"
      "end\n"
      "end\n";
  return output;
}

std::string BuildCffEncodingCMap(
    const std::vector<BmpGlyphMapping>& mappings) {
  std::vector<CidCodeRange> ranges;
  std::vector<BmpGlyphMapping> singles;
  ranges.reserve(mappings.size());
  singles.reserve(mappings.size());
  for (size_t index = 0; index < mappings.size();) {
    const size_t first = index++;
    while (index < mappings.size() &&
           mappings[index].unicode == mappings[index - 1].unicode + 1 &&
           mappings[index].glyph_id == mappings[index - 1].glyph_id + 1) {
      ++index;
    }
    if (index - first > 1) {
      ranges.push_back({mappings[first].unicode, mappings[index - 1].unicode,
                        mappings[first].glyph_id});
    } else {
      singles.push_back(mappings[first]);
    }
  }

  std::string output =
      "/CIDInit /ProcSet findresource begin\n"
      "12 dict begin\n"
      "begincmap\n"
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 "
      ">> def\n"
      "/CMapName /RegisteredFont-Encoding def\n"
      "/CMapType 1 def\n"
      "/WMode 0 def\n"
      "1 begincodespacerange\n"
      "<0000> <FFFF>\n"
      "endcodespacerange\n";
  constexpr size_t kEntriesPerBlock = 100;
  for (size_t first = 0; first < ranges.size();
       first += kEntriesPerBlock) {
    const size_t count =
        std::min(kEntriesPerBlock, ranges.size() - first);
    output += std::to_string(count) + " begincidrange\n";
    for (size_t offset = 0; offset < count; ++offset) {
      const CidCodeRange& range = ranges[first + offset];
      AppendHexCode(range.first, &output);
      output.push_back(' ');
      AppendHexCode(range.last, &output);
      output.push_back(' ');
      output += std::to_string(range.first_cid);
      output.push_back('\n');
    }
    output += "endcidrange\n";
  }
  for (size_t first = 0; first < singles.size();
       first += kEntriesPerBlock) {
    const size_t count =
        std::min(kEntriesPerBlock, singles.size() - first);
    output += std::to_string(count) + " begincidchar\n";
    for (size_t offset = 0; offset < count; ++offset) {
      const BmpGlyphMapping& mapping = singles[first + offset];
      AppendHexCode(mapping.unicode, &output);
      output.push_back(' ');
      output += std::to_string(mapping.glyph_id);
      output.push_back('\n');
    }
    output += "endcidchar\n";
  }
  output +=
      "endcmap\n"
      "CMapName currentdict /CMap defineresource pop\n"
      "end\n"
      "end\n";
  return output;
}

std::vector<uint8_t> BuildCidToGidMap(
    const std::vector<BmpGlyphMapping>& mappings) {
  const size_t entry_count = static_cast<size_t>(mappings.back().unicode) + 1;
  std::vector<uint8_t> output(entry_count * 2, 0);
  for (const BmpGlyphMapping& mapping : mappings) {
    WriteU16(&output, static_cast<size_t>(mapping.unicode) * 2,
             mapping.glyph_id);
  }
  return output;
}

bool GetCompositeFontParts(FPDF_FONT handle,
                           RetainPtr<CPDF_Dictionary>* root,
                           RetainPtr<CPDF_Dictionary>* cid_font,
                           RetainPtr<CPDF_Dictionary>* descriptor) {
  CPDF_Font* font = CPDFFontFromFPDFFont(handle);
  *root = font ? font->GetMutableFontDict() : nullptr;
  RetainPtr<CPDF_Array> descendants =
      *root ? (*root)->GetMutableArrayFor("DescendantFonts") : nullptr;
  *cid_font = descendants && descendants->size() == 1
                  ? descendants->GetMutableDictAt(0)
                  : nullptr;
  *descriptor =
      *cid_font ? (*cid_font)->GetMutableDictFor("FontDescriptor") : nullptr;
  return *root && *cid_font && *descriptor;
}

void MarkFontSymbolic(CPDF_Dictionary* descriptor) {
  int flags = descriptor->GetIntegerFor("Flags");
  flags |= pdfium::kFontStyleSymbolic;
  flags &= ~pdfium::kFontStyleNonSymbolic;
  descriptor->SetNewFor<CPDF_Number>("Flags", flags);
}

bool ConfigureTrueTypeDictionary(FPDF_FONT handle) {
  RetainPtr<CPDF_Dictionary> root;
  RetainPtr<CPDF_Dictionary> cid_font;
  RetainPtr<CPDF_Dictionary> descriptor;
  if (!GetCompositeFontParts(handle, &root, &cid_font, &descriptor) ||
      cid_font->GetNameFor("Subtype") != "CIDFontType2" ||
      !root->GetStreamFor("ToUnicode") || !cid_font->GetArrayFor("W") ||
      !cid_font->GetStreamFor("CIDToGIDMap") ||
      !descriptor->GetStreamFor("FontFile2")) {
    return false;
  }
  MarkFontSymbolic(descriptor.Get());
  return true;
}

bool ConfigureOpenTypeCffDictionary(
    CPDF_Document* document,
    FPDF_FONT handle,
    const std::string& encoding_cmap,
    const std::string& to_unicode_cmap) {
  RetainPtr<CPDF_Dictionary> root;
  RetainPtr<CPDF_Dictionary> cid_font;
  RetainPtr<CPDF_Dictionary> descriptor;
  if (!document ||
      !GetCompositeFontParts(handle, &root, &cid_font, &descriptor) ||
      cid_font->GetNameFor("Subtype") != "CIDFontType0" ||
      !cid_font->GetArrayFor("W") || !descriptor->GetStreamFor("FontFile")) {
    return false;
  }

  auto encoding_stream = document->NewIndirect<CPDF_Stream>(
      ByteStringView(encoding_cmap.c_str()).unsigned_span());
  auto to_unicode_stream = document->NewIndirect<CPDF_Stream>(
      ByteStringView(to_unicode_cmap.c_str()).unsigned_span());
  root->SetNewFor<CPDF_Reference>("Encoding", document,
                                  encoding_stream->GetObjNum());
  root->SetNewFor<CPDF_Reference>("ToUnicode", document,
                                  to_unicode_stream->GetObjNum());
  cid_font->RemoveFor("CIDToGIDMap");

  descriptor->ReplaceKey("FontFile", "FontFile3");
  descriptor->RemoveFor("FontFile2");
  RetainPtr<CPDF_Stream> font_stream =
      descriptor->GetMutableStreamFor("FontFile3");
  RetainPtr<CPDF_Dictionary> stream_dict =
      font_stream ? font_stream->GetMutableDict() : nullptr;
  if (!stream_dict) {
    return false;
  }
  stream_dict->SetNewFor<CPDF_Name>("Subtype", "OpenType");
  stream_dict->RemoveFor("Length1");
  MarkFontSymbolic(descriptor.Get());
  return true;
}

}  // namespace

const char* FontFormatName(FontFormat format) {
  return format == FontFormat::kTrueType ? "ttf" : "otf";
}

bool InspectFontFaces(std::span<const uint8_t> bytes,
                      std::vector<FontFaceInfo>* faces,
                      std::string* error_code,
                      std::string* error_message) {
  ParsedContainer container;
  if (!ParseContainer(bytes, &container, error_code, error_message)) {
    return false;
  }
  faces->clear();
  faces->reserve(container.faces.size());
  for (const ParsedFace& face : container.faces) {
    faces->push_back(face.info);
  }
  return true;
}

bool PrepareFontFace(std::span<const uint8_t> bytes,
                     uint32_t face_index,
                     PreparedFontFace* face,
                     std::string* error_code,
                     std::string* error_message) {
  ParsedContainer container;
  if (!ParseContainer(bytes, &container, error_code, error_message)) {
    return false;
  }
  if (face_index >= container.faces.size()) {
    SetFailure("INVALID_REQUEST",
               "The requested font face index is out of range.", error_code,
               error_message);
    return false;
  }
  const ParsedFace& parsed = container.faces[face_index];
  face->info = parsed.info;
  if (container.collection) {
    face->sfnt = ExtractFace(bytes, parsed);
    if (face->sfnt.empty()) {
      SetFailure("RESOURCE_LIMIT",
                 "The selected collection face could not be extracted.",
                 error_code, error_message);
      return false;
    }
  } else {
    face->sfnt.assign(bytes.begin(), bytes.end());
  }
  return true;
}

FPDF_FONT LoadFontFace(FPDF_DOCUMENT document,
                       const FontFaceInfo& info,
                       std::span<const uint8_t> sfnt,
                       std::string* error_message) {
  std::vector<BmpGlyphMapping> mappings;
  if (!BuildBmpGlyphMappings(sfnt, &mappings, error_message)) {
    return nullptr;
  }
  const std::string to_unicode_cmap = BuildToUnicodeCMap(mappings);

  if (info.format == FontFormat::kTrueType) {
    const std::vector<uint8_t> cid_to_gid_map = BuildCidToGidMap(mappings);
    FPDF_FONT handle = FPDFText_LoadCidType2Font(
        document, sfnt.data(), static_cast<uint32_t>(sfnt.size()),
        to_unicode_cmap.c_str(), cid_to_gid_map.data(),
        static_cast<uint32_t>(cid_to_gid_map.size()));
    if (!handle || !ConfigureTrueTypeDictionary(handle)) {
      if (handle) {
        FPDFFont_Close(handle);
      }
      *error_message =
          "PDFium could not create a correct TrueType CID font resource.";
      return nullptr;
    }
    return handle;
  }

  FPDF_FONT initial =
      FPDFText_LoadFont(document, sfnt.data(),
                        static_cast<uint32_t>(sfnt.size()), FPDF_FONT_TYPE1, 1);
  CPDF_Document* native_document = CPDFDocumentFromFPDFDocument(document);
  CPDF_Font* initial_font = CPDFFontFromFPDFFont(initial);
  RetainPtr<CPDF_Dictionary> root =
      initial_font ? initial_font->GetMutableFontDict() : nullptr;
  const std::string encoding_cmap = BuildCffEncodingCMap(mappings);
  if (!initial || !root ||
      !ConfigureOpenTypeCffDictionary(native_document, initial, encoding_cmap,
                                      to_unicode_cmap)) {
    if (initial) {
      FPDFFont_Close(initial);
    }
    *error_message =
        "PDFium could not create a correct OpenType CFF font resource.";
    return nullptr;
  }

  // CPDF_DocPageData retains the font returned by FPDFText_LoadFont(), so
  // closing `initial` does not evict its already-parsed Identity-H CMap. Use a
  // distinct indirect root dictionary as the cache key. Its indirect descendant,
  // font program, Encoding, and ToUnicode resources remain immutable and
  // shared.
  RetainPtr<CPDF_Dictionary> reloaded_root = ToDictionary(root->Clone());
  if (!reloaded_root) {
    FPDFFont_Close(initial);
    *error_message =
        "PDFium could not clone the OpenType CFF font dictionary.";
    return nullptr;
  }
  native_document->AddIndirectObject(reloaded_root);
  FPDFFont_Close(initial);
  RetainPtr<CPDF_Font> reloaded =
      CPDF_DocPageData::FromDocument(native_document)->GetFont(reloaded_root);
  CPDF_CIDFont* reloaded_cid_font =
      reloaded ? reloaded->AsCIDFont() : nullptr;
  if (!reloaded_cid_font) {
    *error_message =
        "PDFium could not reload the OpenType CFF font character map.";
    return nullptr;
  }
  for (const BmpGlyphMapping& mapping : mappings) {
    if (reloaded_cid_font->CIDFromCharCode(mapping.unicode) !=
        mapping.glyph_id) {
      *error_message =
          "PDFium did not load the OpenType CFF character-to-glyph map.";
      return nullptr;
    }
  }
  const BmpGlyphMapping& probe = mappings.front();
  if (reloaded->GlyphFromCharCode(probe.unicode, /*pVertGlyph=*/nullptr) !=
      probe.glyph_id) {
    *error_message =
        "PDFium did not load the OpenType CFF glyph mapping.";
    return nullptr;
  }
  return FPDFFontFromCPDFFont(reloaded.Leak());
}

}  // namespace pdf_editor
