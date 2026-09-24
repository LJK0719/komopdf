#include "font_runtime.h"
#include "pdf_editor_api.h"
#include "shaped_font.h"
#include "text_shaping.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "public/fpdf_edit.h"
#include "public/fpdf_save.h"
#include "public/fpdf_text.h"
#include "public/fpdfview.h"

namespace {

void Require(bool ok, const char* message) {
  if (!ok) {
    std::fprintf(stderr, "CFF2 test failed: %s [%s: %s]\n", message,
                 pde_error_code(), pde_error_message());
    std::exit(1);
  }
}

struct BufferWriter {
  FPDF_FILEWRITE writer{1, &Write};
  std::vector<uint8_t> bytes;

  static int Write(FPDF_FILEWRITE* writer, const void* data,
                   unsigned long size) {
    auto* self = reinterpret_cast<BufferWriter*>(writer);
    const auto* start = static_cast<const uint8_t*>(data);
    self->bytes.insert(self->bytes.end(), start, start + size);
    return 1;
  }
};

void CheckShaping(const pdf_editor::ShapedText& before,
                  const pdf_editor::ShapedText& after) {
  std::fprintf(stderr, "cff2 before=%zu after=%zu missing=%zu text=%zu/%zu\n",
               before.glyphs.size(), after.glyphs.size(),
               after.missing_glyphs.size(), before.logical_text.size(),
               after.logical_text.size());
  for (const auto& glyph : before.glyphs) {
    std::fprintf(stderr, "  raw glyph=%u cluster=%u-%u advance=%g\n", glyph.glyph_id,
                 glyph.cluster.start, glyph.cluster.end, glyph.x_advance);
  }
  for (const auto& glyph : after.glyphs) {
    std::fprintf(stderr, "  static glyph=%u cluster=%u-%u advance=%g\n", glyph.glyph_id,
                 glyph.cluster.start, glyph.cluster.end, glyph.x_advance);
  }
  Require(!before.glyphs.empty() && before.glyphs.size() == after.glyphs.size() &&
              before.logical_text == after.logical_text &&
              after.missing_glyphs.empty(),
          "default-axis instance preserves text and number of glyphs");
  for (size_t index = 0; index < before.glyphs.size(); ++index) {
    const auto& original = before.glyphs[index];
    const auto& converted = after.glyphs[index];
    Require(original.glyph_id == converted.glyph_id &&
                original.cluster.start == converted.cluster.start &&
                original.cluster.end == converted.cluster.end &&
                std::abs(original.x_advance - converted.x_advance) < 0.02f,
            "CFF2 and CFF1 default instances shape to identical glyphs/advances");
  }
}

void CheckPdfFont(FPDF_PAGE page, bool expect_subset) {
  bool found = false;
  for (int index = 0; index < FPDFPage_CountObjects(page); ++index) {
    FPDF_PAGEOBJECT object = FPDFPage_GetObject(page, index);
    if (FPDFPageObj_GetType(object) != FPDF_PAGEOBJ_TEXT) {
      continue;
    }
    CPDF_Font* font = CPDFFontFromFPDFFont(FPDFTextObj_GetFont(object));
    const auto root = font->GetFontDict();
    const auto children = root->GetArrayFor("DescendantFonts");
    const auto cid = children && children->size() == 1
                         ? children->GetDictAt(0)
                         : nullptr;
    const auto descriptor = cid ? cid->GetDictFor("FontDescriptor") : nullptr;
    const auto stream = descriptor ? descriptor->GetStreamFor("FontFile3") : nullptr;
    Require(cid && cid->GetNameFor("Subtype") == "CIDFontType0" &&
                root->GetStreamFor("ToUnicode") && stream &&
                stream->GetDict()->GetNameFor("Subtype") == "OpenType" &&
                !descriptor->GetStreamFor("FontFile2"),
            "reopened PDF has CFF CID font, ToUnicode and FontFile3/OpenType");
    found = true;
    if (expect_subset) {
      Require(root->GetByteStringFor("BaseFont").Contains("+"),
              "saved font has been subsetted");
    }
  }
  Require(found, "reopened page contains actual text objects");
}

void CheckText(FPDF_DOCUMENT document) {
  FPDF_PAGE page = FPDF_LoadPage(document, 0);
  Require(page != nullptr, "reopen page");
  CheckPdfFont(page, /*expect_subset=*/true);
  FPDF_BITMAP bitmap = FPDFBitmap_Create(380, 160, /*alpha=*/0);
  Require(bitmap != nullptr, "create page bitmap");
  FPDFBitmap_FillRect(bitmap, 0, 0, 380, 160, 0xffffffff);
  FPDF_RenderPageBitmap(bitmap, page, 0, 0, 380, 160, 0, 0);
  const auto* pixels = static_cast<const uint8_t*>(FPDFBitmap_GetBuffer(bitmap));
  const int stride = FPDFBitmap_GetStride(bitmap);
  size_t dark = 0;
  for (int y = 0; y < 160; ++y) {
    for (int x = 0; x < 380; ++x) {
      const size_t offset = static_cast<size_t>(y) * stride + x * 4;
      dark += pixels[offset] < 128 && pixels[offset + 1] < 128 &&
              pixels[offset + 2] < 128;
    }
  }
  FPDFBitmap_Destroy(bitmap);
  Require(dark > 100, "saved PDF renders actual CFF outlines");
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  Require(text != nullptr, "load independent PDF text page");
  const int count = FPDFText_CountChars(text);
  Require(count >= 5, "extract saved PDF chars");
  std::vector<unsigned short> buffer(static_cast<size_t>(count) + 8);
  const int copied = FPDFText_GetText(text, 0, count, buffer.data());
  Require(copied > 0, "extract saved PDF text");
  const std::u16string extracted(buffer.begin(), buffer.begin() + copied - 1);
  Require(extracted.find(u"office") != std::u16string::npos,
          "reopened PDF text extraction yields the original ligature-containing word");
  FPDFText_ClosePage(text);
  FPDF_ClosePage(page);
}

}  // namespace

int main(int argc, char** argv) {
  Require(argc == 3, "pass Adobe CFF2 OTF and output PDF paths");
  // Adobe Variable Font Prototype 1.004, AdobeVFPrototype.otf,
  // https://github.com/adobe-fonts/adobe-variable-font-prototype/releases/tag/1.004
  // Original OFL-1.1 license: testdata/AdobeVFPrototype-LICENSE.md.
  std::ifstream file(argv[1], std::ios::binary);
  Require(file.good(), "read original OFL CFF2 fixture");
  const std::vector<uint8_t> source(std::istreambuf_iterator<char>{file}, {});
  std::vector<pdf_editor::FontFaceInfo> faces;
  std::string code;
  std::string error;
  Require(pdf_editor::InspectFontFaces(source, &faces, &code, &error) &&
              faces.size() == 1 &&
              faces.front().format == pdf_editor::FontFormat::kOpenTypeCff2 &&
              faces.front().editable_embedding,
          "register genuine CFF2-only OpenType variable font");
  pdf_editor::PreparedFontFace prepared;
  if (!pdf_editor::PrepareFontFace(source, 0, &prepared, &code, &error)) {
    std::fprintf(stderr, "CFF2 preparation failed [%s: %s]\n", code.c_str(),
                 error.c_str());
    return 1;
  }
  Require(prepared.info.format == pdf_editor::FontFormat::kOpenTypeCff2 &&
              prepared.sfnt != source,
          "instantiate the real CFF2 outlines rather than relabeling them");
  std::vector<pdf_editor::FontFaceInfo> converted_faces;
  Require(pdf_editor::InspectFontFaces(prepared.sfnt, &converted_faces, &code,
                                      &error) &&
              converted_faces.size() == 1 &&
              converted_faces.front().format == pdf_editor::FontFormat::kOpenTypeCff,
          "prepared SFNT contains valid static CFF1 outlines");

  pdf_editor::ShapedText before;
  pdf_editor::ShapedText after;
  pdf_editor::TextShapingOptions options;
  Require(pdf_editor::ShapeText(source, "office", options, &before, &error),
          "shape original CFF2 text");
  Require(pdf_editor::ShapeText(prepared.sfnt, "office", options, &after,
                                &error),
          "shape converted CFF1 text");
  std::ofstream instance(std::string(argv[2]) + ".otf", std::ios::binary);
  instance.write(reinterpret_cast<const char*>(prepared.sfnt.data()),
                 static_cast<std::streamsize>(prepared.sfnt.size()));
  instance.close();
  CheckShaping(before, after);

  FPDF_InitLibrary();
  FPDF_DOCUMENT document = FPDF_CreateNewDocument();
  Require(document != nullptr, "create PDF document");
  FPDF_PAGE page = FPDFPage_New(document, 0, 380, 160);
  Require(page != nullptr, "create PDF page");
  std::vector<pdf_editor::ShapedFontMapping> mappings;
  std::vector<uint32_t> codes;
  for (size_t index = 0; index < after.glyphs.size(); ++index) {
    const auto& glyph = after.glyphs[index];
    const auto codepoint = static_cast<uint16_t>(index + 1);
    mappings.push_back({codepoint, glyph.glyph_id,
                        after.logical_text.substr(
                            glyph.cluster.start,
                            glyph.cluster.end - glyph.cluster.start)});
    codes.push_back(codepoint);
  }
  Require(pdf_editor::LoadShapedFontFace(document, faces.front(), source,
                                          mappings, &error) == nullptr &&
              error.find("instantiated") != std::string::npos,
          "do not embed raw variable CFF2 as a static OpenType font");
  Require(pdf_editor::LoadFontFace(document, faces.front(), source, &error) ==
              nullptr &&
              error.find("instantiated") != std::string::npos,
          "ordinary font import also refuses uninstantiated CFF2");
  FPDF_FONT font = pdf_editor::LoadShapedFontFace(document, prepared, mappings,
                                                  &error);
  Require(font != nullptr, "embed static CFF derived from original CFF2 font");
  FPDF_PAGEOBJECT object = FPDFPageObj_CreateTextObj(document, font, 30.0f);
  Require(object && FPDFText_SetCharcodes(object, codes.data(), codes.size()),
          "create text object with independent PDF character codes");
  FPDFPageObj_Transform(object, 1, 0, 0, 1, 50, 60);
  FPDF_PAGEOBJECTMARK mark = FPDFPageObj_AddMark(object, "Span");
  Require(mark != nullptr &&
              FPDFPageObjMark_SetStringParam(document, object, mark,
                                             "ActualText", "office"),
          "wrap placed ligature cluster with exact logical text mark");
  FPDFPage_InsertObject(page, object);
  Require(FPDFPage_GenerateContent(page), "write real glyph content to page");
  FPDFFont_Close(font);
  FPDF_ClosePage(page);

  BufferWriter writer;
  Require(FPDF_SaveAsCopy(document, &writer.writer,
                          FPDF_NO_INCREMENTAL | FPDF_SUBSET_NEW_FONTS),
          "save PDF with embedded CFF1 instance and subset");
  FPDF_CloseDocument(document);
  Require(!writer.bytes.empty(), "PDF save produced bytes");
  std::ofstream output(argv[2], std::ios::binary);
  output.write(reinterpret_cast<const char*>(writer.bytes.data()),
               static_cast<std::streamsize>(writer.bytes.size()));
  Require(output.good(), "write PDF for independent text extraction");
  output.close();
  FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(writer.bytes.data(),
                                                  writer.bytes.size(), nullptr);
  Require(reopened != nullptr, "open saved CFF2-derived PDF");
  CheckText(reopened);
  FPDF_CloseDocument(reopened);
  FPDF_DestroyLibrary();

  Require(pde_initialize() == 1, "initialize production C ABI");
  const char* listed = pde_font_faces(source.data(),
                                       static_cast<uint32_t>(source.size()));
  Require(listed && std::string(listed).find("\"format\":\"otf\"") !=
                        std::string::npos,
          "public font listing recognizes CFF2 as an OpenType face");
  const char* registered = pde_register_font(
      "cff2-prototype", source.data(), static_cast<uint32_t>(source.size()), 0);
  Require(registered != nullptr, "register CFF2 font through public ABI");
  const uint32_t session = pde_open_memory(
      writer.bytes.data(), static_cast<uint32_t>(writer.bytes.size()),
      "cff2-insert-session", "cff2-source", nullptr);
  Require(session != 0, "open registered-font PDF");
  const char* description = pde_describe_page(session, 0);
  Require(description != nullptr, "describe registered-font page");
  std::string page_json(description);
  const size_t page_start = page_json.find("{\"id\":\"");
  Require(page_start != std::string::npos, "read persistent page ID");
  const size_t id_start = page_start + std::string("{\"id\":\"").size();
  const size_t id_end = page_json.find('"', id_start);
  Require(id_end != std::string::npos, "read page ID terminator");
  const std::string page_id = page_json.substr(id_start, id_end - id_start);
  PdeEditCommand insert{};
  insert.type = 3;
  insert.page_id = page_id.c_str();
  insert.target_id = "cff2-paragraph";
  insert.font_id = "cff2-prototype";
  insert.text_utf8 = "office";
  insert.flags = 3 | 16 | 1024;
  insert.values[0] = 50;
  insert.values[1] = 20;
  insert.values[2] = 290;
  insert.values[3] = 100;
  insert.values[4] = 24;
  insert.values[9] = 1.3;
  Require(pde_apply_commands(session, 0, "cff2-paragraph-insert", &insert, 1) !=
              nullptr,
          "insert shaped CFF2 paragraph through public ABI");
  Require(pde_save_memory(session) != nullptr, "save CFF2 paragraph through public ABI");
  std::vector<uint8_t> paragraph_pdf(pde_binary_data(),
                                     pde_binary_data() + pde_binary_size());
  std::ofstream paragraph_output(std::string(argv[2]) + ".paragraph.pdf",
                                 std::ios::binary);
  paragraph_output.write(
      reinterpret_cast<const char*>(paragraph_pdf.data()),
      static_cast<std::streamsize>(paragraph_pdf.size()));
  Require(paragraph_output.good(), "write inserted paragraph for independent extraction");
  paragraph_output.close();
  Require(pde_close(session) == 1, "close registered-font PDF");
  const uint32_t reopened_session = pde_open_memory(
      paragraph_pdf.data(), static_cast<uint32_t>(paragraph_pdf.size()),
      "cff2-reopened-session", "cff2-paragraph-saved", nullptr);
  Require(reopened_session != 0, "reopen inserted CFF2 paragraph");
  const char* text_json = pde_extract_page(reopened_session, 0);
  Require(text_json && std::string(text_json).find("office") != std::string::npos,
          "reopened logical paragraph retains exact Unicode text");
  Require(pde_save_memory(reopened_session) != nullptr,
          "save reopened CFF2 paragraph a second time");
  const std::vector<uint8_t> second_save(pde_binary_data(),
                                         pde_binary_data() + pde_binary_size());
  Require(pde_close(reopened_session) == 1, "close reopened CFF2 paragraph");
  const uint32_t twice_reopened = pde_open_memory(
      second_save.data(), static_cast<uint32_t>(second_save.size()),
      "cff2-second-reopen", "cff2-second-save", nullptr);
  Require(twice_reopened != 0, "reopen twice-saved CFF2 paragraph");
  text_json = pde_extract_page(twice_reopened, 0);
  Require(text_json && std::string(text_json).find("office") != std::string::npos,
          "second save retains the custom CMap and Unicode extraction");
  Require(pde_close(twice_reopened) == 1, "close second reopened PDF");
  pde_shutdown();
  std::printf("cff2_font_test:ok font_bytes=%zu pdf_bytes=%zu glyphs=%zu\n",
              prepared.sfnt.size(), writer.bytes.size(), after.glyphs.size());
  return 0;
}
