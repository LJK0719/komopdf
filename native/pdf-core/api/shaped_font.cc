#include "shaped_font.h"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <set>
#include <span>
#include <string>
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
#include "fpdfsdk/cpdfsdk_helpers.h"

namespace pdf_editor {
namespace {

void SetError(std::string message, std::string* error_message) {
  if (error_message) {
    *error_message = std::move(message);
  }
}

void WriteU16(std::vector<uint8_t>* bytes, size_t offset, uint16_t value) {
  (*bytes)[offset] = static_cast<uint8_t>(value >> 8);
  (*bytes)[offset + 1] = static_cast<uint8_t>(value);
}

void AppendHexUnit(uint16_t value, std::string* output) {
  constexpr char kHex[] = "0123456789ABCDEF";
  output->push_back(kHex[(value >> 12) & 0x0f]);
  output->push_back(kHex[(value >> 8) & 0x0f]);
  output->push_back(kHex[(value >> 4) & 0x0f]);
  output->push_back(kHex[value & 0x0f]);
}

void AppendHexCode(uint16_t value, std::string* output) {
  output->push_back('<');
  AppendHexUnit(value, output);
  output->push_back('>');
}

void AppendUtf16Hex(const std::u16string& value, std::string* output) {
  output->push_back('<');
  for (char16_t unit : value) {
    AppendHexUnit(static_cast<uint16_t>(unit), output);
  }
  output->push_back('>');
}

bool IsValidUtf16(const std::u16string& value) {
  for (size_t index = 0; index < value.size(); ++index) {
    const uint16_t unit = static_cast<uint16_t>(value[index]);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index >= value.size()) {
        return false;
      }
      const uint16_t low = static_cast<uint16_t>(value[index]);
      if (low < 0xdc00 || low > 0xdfff) {
        return false;
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

bool ValidateAndSortMappings(
    std::span<const uint8_t> sfnt,
    std::span<const ShapedFontMapping> mappings,
    std::vector<ShapedFontMapping>* sorted,
    std::string* error_message) {
  if (mappings.empty()) {
    SetError("At least one shaped glyph mapping is required.", error_message);
    return false;
  }

  CFX_Font font;
  if (!font.LoadFaceZeroFromSpan(pdfium::span<const uint8_t>(sfnt),
                                 /*force_vertical=*/false,
                                 /*object_tag=*/0)) {
    SetError("PDFium could not read the shaped font face.", error_message);
    return false;
  }
  RetainPtr<CFX_Face> face = font.GetFace();
  const int glyph_count = face ? face->GetGlyphCount() : 0;
  if (glyph_count <= 0) {
    SetError("PDFium could not read the shaped font glyph count.",
             error_message);
    return false;
  }

  std::set<uint16_t> character_codes;
  sorted->assign(mappings.begin(), mappings.end());
  for (const ShapedFontMapping& mapping : *sorted) {
    if (mapping.character_code == 0) {
      SetError("PDF character code 0 is reserved for shaped fonts.",
               error_message);
      return false;
    }
    if (!character_codes.insert(mapping.character_code).second) {
      SetError("Shaped font PDF character codes must be unique.",
               error_message);
      return false;
    }
    if (mapping.glyph_id == 0 ||
        mapping.glyph_id >= static_cast<uint32_t>(glyph_count) ||
        mapping.glyph_id > std::numeric_limits<uint16_t>::max()) {
      SetError("A shaped font mapping contains an invalid glyph ID.",
               error_message);
      return false;
    }
    if (mapping.cluster_text.empty() ||
        !IsValidUtf16(mapping.cluster_text)) {
      SetError("Every shaped font mapping needs a valid UTF-16 cluster.",
               error_message);
      return false;
    }
  }
  std::sort(sorted->begin(), sorted->end(),
            [](const ShapedFontMapping& left,
               const ShapedFontMapping& right) {
              return left.character_code < right.character_code;
            });
  return true;
}

std::string BuildToUnicodeCMap(
    const std::vector<ShapedFontMapping>& mappings) {
  std::string output =
      "/CIDInit /ProcSet findresource begin\n"
      "12 dict begin\n"
      "begincmap\n"
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 "
      ">> def\n"
      "/CMapName /ShapedFont-ToUnicode def\n"
      "/CMapType 2 def\n"
      "1 begincodespacerange\n"
      "<0000> <FFFF>\n"
      "endcodespacerange\n";
  constexpr size_t kEntriesPerBlock = 100;
  for (size_t first = 0; first < mappings.size();
       first += kEntriesPerBlock) {
    const size_t count =
        std::min(kEntriesPerBlock, mappings.size() - first);
    output += std::to_string(count) + " beginbfchar\n";
    for (size_t offset = 0; offset < count; ++offset) {
      const ShapedFontMapping& mapping = mappings[first + offset];
      AppendHexCode(mapping.character_code, &output);
      output.push_back(' ');
      AppendUtf16Hex(mapping.cluster_text, &output);
      output.push_back('\n');
    }
    output += "endbfchar\n";
  }
  output +=
      "endcmap\n"
      "CMapName currentdict /CMap defineresource pop\n"
      "end\n"
      "end\n";
  return output;
}

std::string BuildCffEncodingCMap(
    const std::vector<ShapedFontMapping>& mappings) {
  std::string output =
      "/CIDInit /ProcSet findresource begin\n"
      "12 dict begin\n"
      "begincmap\n"
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 "
      ">> def\n"
      "/CMapName /ShapedFont-Encoding def\n"
      "/CMapType 1 def\n"
      "/WMode 0 def\n"
      "1 begincodespacerange\n"
      "<0000> <FFFF>\n"
      "endcodespacerange\n";
  constexpr size_t kEntriesPerBlock = 100;
  for (size_t first = 0; first < mappings.size();
       first += kEntriesPerBlock) {
    const size_t count =
        std::min(kEntriesPerBlock, mappings.size() - first);
    output += std::to_string(count) + " begincidchar\n";
    for (size_t offset = 0; offset < count; ++offset) {
      const ShapedFontMapping& mapping = mappings[first + offset];
      AppendHexCode(mapping.character_code, &output);
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
    const std::vector<ShapedFontMapping>& mappings) {
  const size_t entry_count =
      static_cast<size_t>(mappings.back().character_code) + 1;
  std::vector<uint8_t> output(entry_count * 2, 0);
  for (const ShapedFontMapping& mapping : mappings) {
    WriteU16(&output, static_cast<size_t>(mapping.character_code) * 2,
             static_cast<uint16_t>(mapping.glyph_id));
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

bool VerifyGlyphMappings(CPDF_Font* font,
                         const std::vector<ShapedFontMapping>& mappings,
                         bool verify_cids) {
  CPDF_CIDFont* cid_font = font ? font->AsCIDFont() : nullptr;
  if (!font || (verify_cids && !cid_font)) {
    return false;
  }
  for (const ShapedFontMapping& mapping : mappings) {
    if ((verify_cids &&
         cid_font->CIDFromCharCode(mapping.character_code) !=
             mapping.glyph_id) ||
        static_cast<uint32_t>(font->GlyphFromCharCode(
            mapping.character_code, /*pVertGlyph=*/nullptr)) !=
            mapping.glyph_id) {
      return false;
    }
  }
  return true;
}

}  // namespace

FPDF_FONT LoadShapedFontFace(
    FPDF_DOCUMENT document,
    const FontFaceInfo& info,
    std::span<const uint8_t> sfnt,
    std::span<const ShapedFontMapping> mappings,
    std::string* error_message) {
  if (error_message) {
    error_message->clear();
  }
  if (!document || sfnt.empty() ||
      sfnt.size() > std::numeric_limits<uint32_t>::max()) {
    SetError("A document and standalone SFNT face are required.",
             error_message);
    return nullptr;
  }

  if (info.format == FontFormat::kOpenTypeCff2) {
    std::vector<FontFaceInfo> prepared_faces;
    std::string code;
    std::string message;
    if (!InspectFontFaces(sfnt, &prepared_faces, &code, &message) ||
        prepared_faces.size() != 1 ||
        prepared_faces.front().format != FontFormat::kOpenTypeCff) {
      SetError("CFF2 must be instantiated to static CFF before PDF embedding.",
               error_message);
      return nullptr;
    }
  }

  std::vector<ShapedFontMapping> sorted_mappings;
  if (!ValidateAndSortMappings(sfnt, mappings, &sorted_mappings,
                               error_message)) {
    return nullptr;
  }
  const std::string to_unicode_cmap =
      BuildToUnicodeCMap(sorted_mappings);

  if (info.format == FontFormat::kTrueType) {
    const std::vector<uint8_t> cid_to_gid_map =
        BuildCidToGidMap(sorted_mappings);
    FPDF_FONT handle = FPDFText_LoadCidType2Font(
        document, sfnt.data(), static_cast<uint32_t>(sfnt.size()),
        to_unicode_cmap.c_str(), cid_to_gid_map.data(),
        static_cast<uint32_t>(cid_to_gid_map.size()));
    CPDF_Font* native_font = CPDFFontFromFPDFFont(handle);
    if (!handle || !ConfigureTrueTypeDictionary(handle) ||
        !VerifyGlyphMappings(native_font, sorted_mappings,
                             /*verify_cids=*/false)) {
      if (handle) {
        FPDFFont_Close(handle);
      }
      SetError("PDFium could not create the shaped TrueType CID font resource.",
               error_message);
      return nullptr;
    }
    return handle;
  }

  if (info.format != FontFormat::kOpenTypeCff &&
      info.format != FontFormat::kOpenTypeCff2) {
    SetError("The shaped font face has an unsupported format.", error_message);
    return nullptr;
  }
  CPDF_Document* native_document = CPDFDocumentFromFPDFDocument(document);
  if (!native_document) {
    SetError("PDFium could not access the target document.", error_message);
    return nullptr;
  }
  FPDF_FONT initial =
      FPDFText_LoadFont(document, sfnt.data(),
                        static_cast<uint32_t>(sfnt.size()), FPDF_FONT_TYPE1, 1);
  CPDF_Font* initial_font = CPDFFontFromFPDFFont(initial);
  RetainPtr<CPDF_Dictionary> root =
      initial_font ? initial_font->GetMutableFontDict() : nullptr;
  const std::string encoding_cmap =
      BuildCffEncodingCMap(sorted_mappings);
  if (!initial || !root ||
      !ConfigureOpenTypeCffDictionary(native_document, initial, encoding_cmap,
                                      to_unicode_cmap)) {
    if (initial) {
      FPDFFont_Close(initial);
    }
    SetError("PDFium could not create the shaped OpenType CFF font resource.",
             error_message);
    return nullptr;
  }

  // PDFium retains the initially parsed Identity-H font after its public handle
  // closes. A distinct indirect root dictionary is therefore required as the
  // cache key for the custom Encoding and ToUnicode CMaps.
  RetainPtr<CPDF_Dictionary> reloaded_root = ToDictionary(root->Clone());
  if (!reloaded_root) {
    FPDFFont_Close(initial);
    SetError("PDFium could not clone the shaped CFF font dictionary.",
             error_message);
    return nullptr;
  }
  native_document->AddIndirectObject(reloaded_root);
  FPDFFont_Close(initial);
  RetainPtr<CPDF_Font> reloaded =
      CPDF_DocPageData::FromDocument(native_document)->GetFont(reloaded_root);
  if (!VerifyGlyphMappings(reloaded.Get(), sorted_mappings,
                           /*verify_cids=*/true)) {
    SetError("PDFium did not load the shaped CFF character-to-glyph map.",
             error_message);
    return nullptr;
  }
  return FPDFFontFromCPDFFont(reloaded.Leak());
}

FPDF_FONT LoadShapedFontFace(
    FPDF_DOCUMENT document,
    const PreparedFontFace& face,
    std::span<const ShapedFontMapping> mappings,
    std::string* error_message) {
  return LoadShapedFontFace(document, face.info, face.sfnt, mappings,
                            error_message);
}

}  // namespace pdf_editor
