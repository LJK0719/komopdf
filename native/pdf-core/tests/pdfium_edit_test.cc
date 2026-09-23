#include <cstdio>
#include <cstdlib>
#include <iomanip>
#include <fstream>
#include <iterator>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include "form_edit.h"
#include "form_fields.h"
#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_docpagedata.h"
#include "core/fpdfapi/page/cpdf_page.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "public/fpdf_annot.h"
#include "public/fpdf_edit.h"
#include "public/fpdf_formfill.h"
#include "public/fpdf_save.h"
#include "public/fpdf_text.h"
#include "public/fpdfview.h"

namespace {
void Require(bool value, const char* message) {
  if (!value) { std::fprintf(stderr, "FAIL: %s\n", message); std::exit(1); }
}
std::string Stream(const std::string& data, const std::string& entries = "") {
  return "<< /Length " + std::to_string(data.size()) + " " + entries +
      " >>\nstream\n" + data + "\nendstream";
}
std::string Pdf(const std::vector<std::string>& objects) {
  std::ostringstream out;
  out << "%PDF-1.7\n";
  std::vector<std::streamoff> offsets;
  for (size_t i = 0; i < objects.size(); ++i) {
    offsets.push_back(out.tellp());
    out << i + 1 << " 0 obj\n" << objects[i] << "\nendobj\n";
  }
  const auto xref = out.tellp();
  out << "xref\n0 " << objects.size() + 1 << "\n0000000000 65535 f \n";
  for (auto offset : offsets) out << std::setw(10) << std::setfill('0') << offset << " 00000 n \n";
  out << "trailer\n<< /Size " << objects.size() + 1 << " /Root 1 0 R >>\nstartxref\n" << xref << "\n%%EOF\n";
  return out.str();
}
struct Writer : FPDF_FILEWRITE {
  Writer() {
    version = 1;
    WriteBlock = [](FPDF_FILEWRITE* self, const void* data, unsigned long size) -> int {
      auto* writer = static_cast<Writer*>(self);
      writer->bytes.append(static_cast<const char*>(data), size);
      return 1;
    };
  }
  std::string bytes;
};
std::u16string Text(FPDF_PAGE page) {
  FPDF_TEXTPAGE text = FPDFText_LoadPage(page);
  Require(text != nullptr, "load text");
  const int count = FPDFText_CountChars(text);
  Require(count >= 0, "count text");
  std::vector<unsigned short> chars(static_cast<size_t>(count) + 1);
  const int copied = FPDFText_GetText(text, 0, count, chars.data());
  FPDFText_ClosePage(text);
  std::u16string result;
  for (int i = 0; i < copied - 1; ++i) result.push_back(static_cast<char16_t>(chars[i]));
  return result;
}
uint64_t RenderHash(FPDF_PAGE page) {
  FPDF_BITMAP bitmap = FPDFBitmap_Create(300, 300, 0);
  Require(bitmap != nullptr, "allocate render bitmap");
  FPDFBitmap_FillRect(bitmap, 0, 0, 300, 300, 0xffffffff);
  FPDF_RenderPageBitmap(bitmap, page, 0, 0, 300, 300, 0, FPDF_ANNOT);
  const auto* bytes = static_cast<const unsigned char*>(FPDFBitmap_GetBuffer(bitmap));
  uint64_t hash = 1469598103934665603ULL;
  for (int i = 0; i < FPDFBitmap_GetStride(bitmap) * 300; ++i) hash = (hash ^ bytes[i]) * 1099511628211ULL;
  FPDFBitmap_Destroy(bitmap);
  return hash;
}
void CheckSavedText(FPDF_DOCUMENT document, const std::vector<std::u16string>& expected) {
  Writer writer;
  Require(FPDF_SaveAsCopy(document, &writer, FPDF_NO_INCREMENTAL), "save PDF");
  FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(writer.bytes.data(), writer.bytes.size(), nullptr);
  Require(reopened != nullptr, "reopen saved PDF");
  for (size_t index = 0; index < expected.size(); ++index) {
    FPDF_PAGE page = FPDF_LoadPage(reopened, static_cast<int>(index));
    Require(page != nullptr, "load saved page");
    Require(Text(page) == expected[index], "saved text differs from expected");
    FPDF_ClosePage(page);
  }
  FPDF_CloseDocument(reopened);
}
void TestActualText() {
  const std::string bytes = Pdf({
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    Stream("BT /F1 20 Tf 30 200 Td /Span << /ActualText (ORIGINAL) >> BDC (ORIGINAL) Tj EMC ET"),
  });
  FPDF_DOCUMENT doc = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
  Require(doc != nullptr, "open ActualText fixture");
  FPDF_PAGE page = FPDF_LoadPage(doc, 0);
  Require(page != nullptr && Text(page) == u"ORIGINAL", "initial ActualText");
  const auto before = RenderHash(page);
  auto object = FPDFPage_GetObject(page, 0);
  const unsigned short replacement[]{'C', 'H', 'A', 'N', 'G', 'E', 'D', 0};
  Require(FPDFText_SetText(object, replacement), "set marked text");
  auto mark = FPDFPageObj_GetMark(object, 0);
  Require(FPDFPageObjMark_SetStringParam(doc, object, mark, "ActualText", "CHANGED"), "sync ActualText");
  Require(FPDFPage_GenerateContent(page), "generate marked content");
  Require(RenderHash(page) != before, "marked text pixels must change");
  FPDF_ClosePage(page);
  CheckSavedText(doc, {u"CHANGED"});
  FPDF_CloseDocument(doc);
  std::puts("PASS actualtext: render, semantic update, save and reopen");
}
void TestSharedForm() {
  const std::string bytes = Pdf({
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>",
    Stream("q /Fm Do Q"),
    Stream("BT /F1 20 Tf 30 200 Td (ORIGINAL) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Font << /F1 7 0 R >> >>"),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  FPDF_DOCUMENT doc = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
  Require(doc != nullptr, "open shared Form fixture");
  FPDF_PAGE page = FPDF_LoadPage(doc, 0);
  Require(page != nullptr, "load shared Form page");
  auto path = pdf_editor::PrepareFormPath(CPDFPageFromFPDFPage(page), std::vector<size_t>{0});
  Require(path.has_value(), "prepare isolated Form instance");
  auto object = FPDFFormObj_GetObject(FPDFPage_GetObject(page, 0), 0);
  const unsigned short replacement[]{'C', 'H', 'A', 'N', 'G', 'E', 'D', 0};
  Require(FPDFText_SetText(object, replacement), "change nested text");
  pdf_editor::GeneratePreparedFormPath(*path);
  FPDF_ClosePage(page);
  CheckSavedText(doc, {u"CHANGED", u"ORIGINAL"});
  FPDF_CloseDocument(doc);
  std::puts("PASS shared_form: only selected instance changes after save and reopen");
}
void TestCjkSubset(const char* font_path) {
  std::ifstream input(font_path, std::ios::binary);
  Require(input.good(), "open verified CJK font");
  const std::vector<uint8_t> font_bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
  Require(!font_bytes.empty() && font_bytes.size() < UINT32_MAX, "read CJK font bytes");
  auto add_text = [&](FPDF_DOCUMENT doc, FPDF_PAGE page, const std::u16string& text) {
    auto font = FPDFText_LoadFont(doc, font_bytes.data(), static_cast<uint32_t>(font_bytes.size()), FPDF_FONT_TRUETYPE, 1);
    Require(font != nullptr, "load CJK TrueType CID font");
    auto object = FPDFPageObj_CreateTextObj(doc, font, 20);
    std::vector<unsigned short> utf16(text.begin(), text.end());
    utf16.push_back(0);
    Require(object != nullptr && FPDFText_SetText(object, utf16.data()), "set CJK text");
    FPDFPageObj_Transform(object, 1, 0, 0, 1, 30, 200);
    FPDFPage_InsertObject(page, object);
    FPDFFont_Close(font);
  };
  FPDF_DOCUMENT doc = FPDF_CreateNewDocument();
  FPDF_PAGE page = FPDFPage_New(doc, 0, 300, 300);
  Require(doc != nullptr && page != nullptr, "new CJK document");
  add_text(doc, page, u"旧文");
  Require(FPDFPage_GenerateContent(page), "generate initial CJK content");
  Writer source;
  Require(FPDF_SaveAsCopy(doc, &source, FPDF_NO_INCREMENTAL | FPDF_SUBSET_NEW_FONTS), "save initial CJK subset");
  Require(source.bytes.size() < font_bytes.size() / 4, "initial font was not substantially subsetted");
  FPDF_ClosePage(page);
  FPDF_CloseDocument(doc);

  doc = FPDF_LoadMemDocument64(source.bytes.data(), source.bytes.size(), nullptr);
  page = FPDF_LoadPage(doc, 0);
  Require(page != nullptr && Text(page) == u"旧文", "reopen original CJK subset");
  const auto before = RenderHash(page);
  auto old = FPDFPage_GetObject(page, 0);
  Require(FPDFPage_RemoveObject(page, old), "remove original CJK object, not cover it");
  FPDFPageObj_Destroy(old);
  add_text(doc, page, u"新字测试");
  Require(FPDFPage_GenerateContent(page), "generate replacement CJK content");
  Require(Text(page) == u"新字测试" && RenderHash(page) != before, "CJK replacement must change text and pixels");
  Writer output;
  Require(FPDF_SaveAsCopy(doc, &output, FPDF_NO_INCREMENTAL | FPDF_SUBSET_NEW_FONTS), "save replacement CJK subset");
  Require(output.bytes.size() < font_bytes.size() / 4, "replacement font was not substantially subsetted");
  FPDF_ClosePage(page);
  FPDF_CloseDocument(doc);
  doc = FPDF_LoadMemDocument64(output.bytes.data(), output.bytes.size(), nullptr);
  page = FPDF_LoadPage(doc, 0);
  Require(page != nullptr && Text(page) == u"新字测试", "saved new CJK characters must extract correctly without old text");
  FPDF_ClosePage(page);
  FPDF_CloseDocument(doc);
  std::printf("PASS cjk_subset: new Chinese glyphs replace old text; source=%zu output=%zu font=%zu bytes\n", source.bytes.size(), output.bytes.size(), font_bytes.size());
}

void TestFields() {
  FPDF_DOCUMENT doc = FPDF_CreateNewDocument();
  FPDF_PAGE page = FPDFPage_New(doc, 0, 300, 300);
  Require(doc != nullptr && page != nullptr, "new field document");
  {
    auto* document = CPDFDocumentFromFPDFDocument(doc);
    auto* native_page = CPDFPageFromFPDFPage(page);
    auto font = CPDF_DocPageData::FromDocument(document)->GetStandardFont("Helvetica", nullptr);
    Require(font != nullptr, "field font");
    Require(pdf_editor::CreateTextField(document, native_page, L"Name", {20, 200, 200, 230}, font->GetMutableFontDict()) != nullptr, "create text field with AP");
    Require(pdf_editor::CreateCheckboxField(document, native_page, L"Approved", {20, 150, 40, 170}, true) != nullptr, "create checkbox with AP states");
  }
  FPDF_ClosePage(page);
  Writer writer;
  Require(FPDF_SaveAsCopy(doc, &writer, FPDF_NO_INCREMENTAL), "save fields");
  FPDF_CloseDocument(doc);
  doc = FPDF_LoadMemDocument64(writer.bytes.data(), writer.bytes.size(), nullptr);
  Require(doc != nullptr, "reopen fields");
  FPDF_FORMFILLINFO info{};
  info.version = 1;
  auto form = FPDFDOC_InitFormFillEnvironment(doc, &info);
  Require(form != nullptr, "initialize form environment");
  page = FPDF_LoadPage(doc, 0);
  Require(page != nullptr && FPDFPage_GetAnnotCount(page) == 2, "two real annotations");
  for (int index = 0; index < 2; ++index) {
    auto annotation = FPDFPage_GetAnnot(page, index);
    Require(FPDFAnnot_GetSubtype(annotation) == FPDF_ANNOT_WIDGET, "real Widget subtype");
    const int expected = index == 0 ? FPDF_FORMFIELD_TEXTFIELD : FPDF_FORMFIELD_CHECKBOX;
    Require(FPDFAnnot_GetFormFieldType(form, annotation) == expected, "real AcroForm field type");
    FPDFPage_CloseAnnot(annotation);
  }
  FPDF_ClosePage(page);
  FPDFDOC_ExitFormFillEnvironment(form);
  FPDF_CloseDocument(doc);
  std::puts("PASS fields: text and checkbox survive as real Widgets after reopen");
}
}
int main(int argc, char** argv) {
  Require(argc == 2, "pass the verified CJK font path");
  FPDF_InitLibrary();
  TestActualText();
  TestSharedForm();
  TestFields();
  TestCjkSubset(argv[1]);
  FPDF_DestroyLibrary();
  return 0;
}
