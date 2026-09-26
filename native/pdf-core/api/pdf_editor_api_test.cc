#include "pdf_editor_api.h"
#include "native_file_path.h"
#include "text_shaping.h"
#include "tagged_content.h"
#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_textobject.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "public/fpdf_edit.h"
#include "public/fpdf_text.h"
#include "public/fpdfview.h"

#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <iomanip>
#include <limits>
#include <map>
#include <sstream>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace {

void Require(bool value, const char* message) {
  if (!value) {
    std::fprintf(stderr, "FAIL: %s [%s: %s]\n", message, pde_error_code(),
                 pde_error_message());
    std::exit(1);
  }
}

std::string RequireResult(const char* value, const char* message) {
  Require(value != nullptr, message);
  return value;
}

std::string Stream(const std::string& data, const std::string& entries = "") {
  return "<< /Length " + std::to_string(data.size()) + " " + entries +
         " >>\nstream\n" + data + "\nendstream";
}

std::string Pdf(const std::vector<std::string>& objects) {
  std::ostringstream output;
  output << "%PDF-1.7\n";
  std::vector<std::streamoff> offsets;
  for (size_t index = 0; index < objects.size(); ++index) {
    offsets.push_back(output.tellp());
    output << index + 1 << " 0 obj\n" << objects[index] << "\nendobj\n";
  }
  const std::streamoff xref = output.tellp();
  output << "xref\n0 " << objects.size() + 1 << "\n0000000000 65535 f \n";
  for (const std::streamoff offset : offsets) {
    output << std::setw(10) << std::setfill('0') << offset << " 00000 n \n";
  }
  output << "trailer\n<< /Size " << objects.size() + 1
         << " /Root 1 0 R >>\nstartxref\n"
         << xref << "\n%%EOF\n";
  return output.str();
}

size_t Count(std::string_view text, std::string_view token) {
  size_t result = 0;
  size_t offset = 0;
  while ((offset = text.find(token, offset)) != std::string_view::npos) {
    ++result;
    offset += token.size();
  }
  return result;
}

double JsonNumberAfter(std::string_view json,
                       std::string_view marker,
                       size_t occurrence = 0) {
  size_t offset = 0;
  for (size_t index = 0; index <= occurrence; ++index) {
    offset = json.find(marker, offset);
    Require(offset != std::string_view::npos, "JSON number marker");
    if (index != occurrence) {
      offset += marker.size();
    }
  }
  const std::string tail(json.substr(offset + marker.size()));
  char* end = nullptr;
  const double value = std::strtod(tail.c_str(), &end);
  Require(end && end != tail.c_str(), "JSON number value");
  return value;
}

uint64_t TestStableIdHash(std::string_view value) {
  uint64_t hash = 1469598103934665603ULL;
  for (uint8_t byte : value) {
    hash ^= byte;
    hash *= 1099511628211ULL;
  }
  return hash;
}

void RemoveUnicodeFixture() {
#if defined(_WIN32)
  DeleteFileW(L"pde-中文-test.pdf");
#else
  std::remove("pde-\xE4\xB8\xAD\xE6\x96\x87-test.pdf");
#endif
}

std::vector<std::string> TextBlockIds(std::string_view page) {
  std::vector<std::string> ids;
  constexpr std::string_view marker = "\"textBlock\":{\"id\":\"";
  size_t offset = 0;
  while ((offset = page.find(marker, offset)) != std::string_view::npos) {
    offset += marker.size();
    const size_t end = page.find('"', offset);
    Require(end != std::string_view::npos, "text block ID terminator");
    ids.emplace_back(page.substr(offset, end - offset));
    offset = end + 1;
  }
  return ids;
}

std::string JsonStringAfter(std::string_view json,
                            std::string_view marker,
                            size_t offset = 0) {
  offset = json.find(marker, offset);
  Require(offset != std::string_view::npos, "JSON marker");
  offset += marker.size();
  const size_t end = json.find('"', offset);
  Require(end != std::string_view::npos, "JSON string terminator");
  return std::string(json.substr(offset, end - offset));
}

std::string PageIdFromDescription(std::string_view page) {
  return JsonStringAfter(page, "{\"id\":\"");
}

std::string FirstObjectId(std::string_view page) {
  const size_t objects = page.find("\"objects\":[");
  Require(objects != std::string_view::npos, "objects array");
  return JsonStringAfter(page, "{\"id\":\"", objects);
}

std::array<uint8_t, 4> PixelAt(const std::vector<uint8_t>& pixels,
                               uint32_t width,
                               uint32_t x,
                               uint32_t y) {
  const size_t offset = (static_cast<size_t>(y) * width + x) * 4;
  Require(offset + 4 <= pixels.size(), "render pixel coordinate");
  return {pixels[offset], pixels[offset + 1], pixels[offset + 2],
          pixels[offset + 3]};
}

std::vector<uint8_t> RenderPixels(uint32_t document,
                                  uint32_t page_index,
                                  uint32_t width,
                                  uint32_t height) {
  Require(pde_render(document, page_index, width, height, 0, 0, width,
                     height) != nullptr,
          "render edited page");
  return std::vector<uint8_t>(pde_binary_data(),
                              pde_binary_data() + pde_binary_size());
}

void TestNativeLongPath() {
#if defined(_WIN32)
  std::vector<std::string> directories;
  std::string directory = "pde-long-" + std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64());
  for (size_t index = 0; index < 7; ++index) {
    if (index) directory += "/" + std::string(45, 'a') + std::to_string(index);
    Require(CreateDirectoryW(pdf_editor::NativeWidePath(directory).c_str(), nullptr) != 0,
            "create owned long-path fixture directory");
    directories.push_back(directory);
  }
  const std::string path = directory + "/\xE4\xB8\xAD\xE6\x96\x87.pdf";
  const std::string extract_path = directory + "/\xE6\x8F\x90\xE5\x8F\x96.pdf";
  const std::string recovery_path = path + ".recovery";
  Require(path.size() > 260, "fixture genuinely exceeds MAX_PATH");
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "long-path", "long-path-source", nullptr);
  Require(doc != 0 && pde_save_file_utf8(doc, path.c_str()) == 1, "save beyond MAX_PATH");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const char* ids[]{page_id.c_str()};
  Require(pde_extract_pages_file_utf8(doc, ids, 1, extract_path.c_str()) != nullptr &&
              pde_binary_size() == 0,
          "extract staging PDF at UTF-8 path beyond MAX_PATH without copying bytes");
  Require(pde_export_recovery_file_utf8(doc, recovery_path.c_str()) != nullptr, "snapshot beyond MAX_PATH");
  Require(pde_close(doc) == 1, "close long-path source");
  const uint32_t reopened = pde_open_file_utf8(path.c_str(), "long-reopen", "long-file", nullptr);
  Require(reopened != 0 && pde_close(reopened) == 1, "open Unicode PDF beyond MAX_PATH");
  const uint32_t extracted = pde_open_file_utf8(
      extract_path.c_str(), "long-extract", "long-extract-file", nullptr);
  Require(extracted != 0 && pde_close(extracted) == 1,
          "open extracted Unicode PDF beyond MAX_PATH");
  const uint32_t restored = pde_restore_recovery_file_utf8(recovery_path.c_str(), nullptr);
  Require(restored != 0 && pde_close(restored) == 1, "restore snapshot beyond MAX_PATH");
  Require(DeleteFileW(pdf_editor::NativeWidePath(path).c_str()) != 0 &&
          DeleteFileW(pdf_editor::NativeWidePath(extract_path).c_str()) != 0 &&
          DeleteFileW(pdf_editor::NativeWidePath(recovery_path).c_str()) != 0,
          "remove only owned long-path fixture files");
  for (auto it = directories.rbegin(); it != directories.rend(); ++it)
    Require(RemoveDirectoryW(pdf_editor::NativeWidePath(*it).c_str()) != 0,
            "remove owned empty long-path fixture directories");
#endif
}

void TestRangeFormatting() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 120] "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 20 Tf 1 Tc 20 70 Td [(AB ) 30 (CD EF)] TJ ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "range-format", "range-source", nullptr);
  Require(doc != 0, "open range format fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "describe range fixture");
  const auto blocks = TextBlockIds(before);
  const std::string page = PageIdFromDescription(before);
  const char* ids[] = {blocks[0].c_str()};
  const auto original_pixels = RenderPixels(doc, 0, 480, 240);
  PdeEditCommand style{};
  style.type = 2; style.page_id = page.c_str(); style.ids = ids; style.id_count = 1;
  style.start_utf16 = 3; style.end_utf16 = 5; style.flags = 16 | 4;
  style.values[1] = 1;
  Require(pde_preview_commands(doc, 0, &style, 1) != nullptr, "preview range color");
  Require(before == pde_describe_page(doc, 0), "range preview does not mutate source");
  Require(pde_apply_commands(doc, 0, "range-color", &style, 1) != nullptr, "apply range color");
  const std::string colored = RequireResult(pde_describe_page(doc, 0), "describe split runs");
  Require(TextBlockIds(colored).size() == 3, "range produces three real runs");
  Require(TextBlockIds(colored)[0] == blocks[0], "leading run retains original identity");
  Require(colored.find("\"text\":\"AB \"") != std::string::npos &&
          colored.find("\"text\":\"CD\"") != std::string::npos &&
          colored.find("\"text\":\" EF\"") != std::string::npos,
          "all selected and unselected characters survive");
  const auto color_pixels = RenderPixels(doc, 0, 480, 240);
  bool found_red = false;
  for (size_t index = 0; index < original_pixels.size(); index += 4) {
    if (original_pixels[index + 1] != color_pixels[index + 1] ||
        original_pixels[index + 2] != color_pixels[index + 2]) {
      std::fprintf(stderr, "range pixel at %zu,%zu: %u,%u,%u -> %u,%u,%u\n%s\n%s\n",
                   (index / 4) % 480, (index / 4) / 480,
                   original_pixels[index], original_pixels[index + 1], original_pixels[index + 2],
                   color_pixels[index], color_pixels[index + 1], color_pixels[index + 2],
                   before.c_str(), colored.c_str());
      Require(false, "range color preserves glyph positioning and kerning exactly");
    }
    found_red |= color_pixels[index] > color_pixels[index + 1];
  }
  Require(found_red, "selected glyphs actually render red");
  Require(pde_save_memory(doc) != nullptr, "save range formatting");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "range-reopened", "range-saved", nullptr);
  Require(reopened != 0, "reopen range formatting");
  Require(RenderPixels(reopened, 0, 480, 240) == color_pixels, "saved range renders identically");
  Require(pde_close(reopened) == 1, "close range reopen");
  Require(pde_undo(doc) != nullptr, "undo range formatting");
  Require(RenderPixels(doc, 0, 480, 240) == original_pixels, "undo restores original glyphs");
  Require(pde_redo(doc) != nullptr, "redo range formatting");
  Require(TextBlockIds(pde_describe_page(doc, 0)) == TextBlockIds(colored),
          "redo retains split run identities");
  Require(pde_undo(doc) != nullptr, "undo before range size change");
  style.flags = 16 | 2 | 4; style.values[0] = 30;
  Require(pde_apply_commands(doc, 4, "range-size", &style, 1) != nullptr,
          "range font size and color share one transaction");
  const std::string enlarged = RequireResult(pde_describe_page(doc, 0), "describe enlarged range");
  Require(enlarged.find("\"fontSize\":30") != std::string::npos,
          "selected run carries new font size");
  Require(pde_export_recovery(doc) != nullptr, "export range recovery snapshot");
  const std::vector<uint8_t> snapshot(pde_binary_data(), pde_binary_data() + pde_binary_size());
  Require(pde_close(doc) == 1, "close range fixture");
  const uint32_t recovered = pde_restore_recovery(snapshot.data(), static_cast<uint32_t>(snapshot.size()), nullptr);
  Require(recovered != 0, "restore range recovery snapshot");
  Require(enlarged == pde_describe_page(recovered, 0), "recovery preserves range identities and formatting");
  Require(pde_undo(recovered) != nullptr && RenderPixels(recovered, 0, 480, 240) == original_pixels,
          "recovered formatting remains undoable");
  Require(pde_close(recovered) == 1, "close recovered range fixture");
}

void TestRecoveryHistory() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "recovery-history", "recovery-history-source", nullptr);
  Require(doc != 0, "open history recovery fixture");
  const std::string description = pde_describe_page(doc, 0);
  const std::string page_id = PageIdFromDescription(description);
  const std::string object_id = FirstObjectId(description);
  const char* ids[] = {object_id.c_str()};
  PdeEditCommand move{};
  move.type = 4; move.page_id = page_id.c_str(); move.ids = ids; move.id_count = 1;
  move.values[0] = 1; move.values[3] = 1; move.values[4] = 1;
  for (uint32_t index = 0; index < 105; ++index) {
    const std::string id = "history-" + std::to_string(index);
    Require(pde_apply_commands(doc, index, id.c_str(), &move, 1) != nullptr, "build complete recovery history");
  }
  Require(pde_save_memory(doc) != nullptr && pde_confirm_save(doc, 105) != nullptr,
          "mark recovery saved revision");
  for (int index = 0; index < 3; ++index) Require(pde_undo(doc) != nullptr, "keep redo history in snapshot");
  const std::string before = pde_describe_page(doc, 0);
  Require(pde_export_recovery(doc) != nullptr, "export more than 100 transactions");
  const std::vector<uint8_t> snapshot(pde_binary_data(), pde_binary_data() + pde_binary_size());
  Require(pde_close(doc) == 1, "close history source before recovery");
  const uint32_t recovered = pde_restore_recovery(snapshot.data(), static_cast<uint32_t>(snapshot.size()), nullptr);
  Require(recovered != 0 && before == pde_describe_page(recovered, 0), "recovery retains history older than undo limit");
  const std::string info = pde_document_info(recovered);
  Require(info.find("\"revision\":108,\"savedRevision\":105") != std::string::npos,
          "recovery retains revision and saved marker");
  for (int index = 0; index < 3; ++index) Require(pde_redo(recovered) != nullptr, "redo recovered transaction");
  const std::string moved = pde_describe_page(recovered, 0);
  Require(JsonNumberAfter(moved, "\"bounds\":{\"x\":") == 115,
          "all 105 transactions survive source replay");
  Require(pde_close(recovered) == 1, "close recovered history");
}

void TestAbi3Transactions() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
  });
  const std::string resource_pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 50] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("0 0 100 50 re f"),
  });
  const uint32_t document = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "doc-abi3", "source-abi3", nullptr);
  Require(document != 0, "open ABI3 transaction PDF");
  Require(pde_edit_command_stride() == sizeof(PdeEditCommand),
          "native ABI3 command stride");

  const std::string original_page = pde_describe_page(document, 0);
  const std::string original_page_id = PageIdFromDescription(original_page);
  const std::string original_object_id = FirstObjectId(original_page);
  const uint8_t rgba[] = {
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 255, 255, 255, 0,
  };
  Require(pde_register_rgba_image(document, "image-resource", 2, 2, rgba,
                                  sizeof(rgba)) == 1,
          "register immutable RGBA resource");
  Require(pde_register_rgba_image(document, "image-resource", 2, 2, rgba,
                                  sizeof(rgba)) == 1,
          "idempotent RGBA registration");
  const char* resource_info = pde_register_pdf_resource(
      document, "pdf-resource",
      reinterpret_cast<const uint8_t*>(resource_pdf.data()),
      static_cast<uint32_t>(resource_pdf.size()));
  Require(resource_info != nullptr &&
              std::string(resource_info).find("\"pageCount\":1") !=
                  std::string::npos,
          "register immutable PDF resource");

  PdeEditCommand failed[2]{};
  failed[0].type = 9;
  failed[0].page_id = "page-failed";
  failed[0].target_id = original_page_id.c_str();
  failed[0].values[0] = 200;
  failed[0].values[1] = 200;
  failed[1].type = 10;
  failed[1].page_id = "page-failed";
  failed[1].target_id = "image-failed";
  failed[1].resource_id = "missing-resource";
  failed[1].values[0] = 10;
  failed[1].values[1] = 10;
  failed[1].values[2] = 20;
  failed[1].values[3] = 20;
  Require(
      pde_apply_commands(document, 0, "tx-abi3-failed", failed, 2) == nullptr,
      "mixed candidate failure is rejected");
  Require(std::string(pde_document_info(document)).find("\"revision\":0") !=
              std::string::npos,
          "failed mixed transaction keeps revision");
  Require(std::string(pde_document_info(document)).find("page-failed") ==
              std::string::npos,
          "failed mixed transaction rolls back inserted page");

  const char* transformed_ids[] = {original_object_id.c_str()};
  const char* new_order[] = {"page-new", original_page_id.c_str()};
  PdeEditCommand commands[5]{};
  commands[0].type = 9;
  commands[0].page_id = "page-new";
  commands[0].target_id = original_page_id.c_str();
  commands[0].values[0] = 200;
  commands[0].values[1] = 200;
  commands[1].type = 10;
  commands[1].page_id = "page-new";
  commands[1].target_id = "image-new";
  commands[1].resource_id = "image-resource";
  commands[1].values[0] = 10;
  commands[1].values[1] = 10;
  commands[1].values[2] = 40;
  commands[1].values[3] = 40;
  commands[2].type = 11;
  commands[2].page_id = "page-new";
  commands[2].target_id = "form-new";
  commands[2].resource_id = "pdf-resource";
  commands[2].resource_page_index = 0;
  commands[2].values[0] = 60;
  commands[2].values[1] = 20;
  commands[2].values[2] = 100;
  commands[2].values[3] = 50;
  commands[3].type = 4;
  commands[3].page_id = original_page_id.c_str();
  commands[3].ids = transformed_ids;
  commands[3].id_count = 1;
  commands[3].values[0] = 1;
  commands[3].values[3] = 1;
  commands[3].values[4] = 5;
  commands[3].values[5] = 6;
  commands[4].type = 8;
  commands[4].ids = new_order;
  commands[4].id_count = 2;

  const char* preview = pde_preview_commands(document, 0, commands, 5);
  Require(preview != nullptr &&
              std::string(preview).find("\"pageOrder\":[\"page-new\",\"" +
                                        original_page_id + "\"]") !=
                  std::string::npos,
          "real mixed candidate preview");
  Require(std::string(pde_document_info(document)).find("page-new") ==
              std::string::npos,
          "mixed preview does not commit");

  const char* applied = pde_apply_commands(document, 0, "tx-abi3", commands, 5);
  Require(applied != nullptr &&
              std::string(applied).find("\"revision\":1") != std::string::npos,
          "commit mixed ABI3 transaction");
  const std::string inserted_page = pde_describe_page(document, 0);
  Require(PageIdFromDescription(inserted_page) == "page-new" &&
              inserted_page.find("\"id\":\"image-new\"") != std::string::npos &&
              inserted_page.find("\"id\":\"form-new\"") != std::string::npos &&
              inserted_page.find("\"type\":\"image\"") != std::string::npos &&
              inserted_page.find("\"type\":\"form\"") != std::string::npos,
          "RGBA and native PDF Form resources are inserted");
  const std::string moved_original = pde_describe_page(document, 1);
  Require(PageIdFromDescription(moved_original) == original_page_id &&
              moved_original.find("\"id\":\"" + original_object_id + "\"") !=
                  std::string::npos,
          "page and surviving object IDs remain stable after reorder");

  Require(pde_undo(document) != nullptr, "undo mixed ABI3 transaction");
  const std::string undone_page = pde_describe_page(document, 0);
  Require(PageIdFromDescription(undone_page) == original_page_id &&
              undone_page.find("\"id\":\"" + original_object_id + "\"") !=
                  std::string::npos,
          "undo restores stable source identities");
  Require(pde_redo(document) != nullptr, "redo mixed ABI3 transaction");
  const std::string redone_page = pde_describe_page(document, 0);
  Require(PageIdFromDescription(redone_page) == "page-new" &&
              redone_page.find("\"id\":\"image-new\"") != std::string::npos &&
              redone_page.find("\"id\":\"form-new\"") != std::string::npos,
          "redo restores stable inserted identities");

  const char* saved = pde_save_memory(document);
  Require(saved != nullptr && std::string(saved).find("\"savedRevision\":3") !=
                                  std::string::npos,
          "save exports the current revision");
  const std::vector<uint8_t> saved_pdf(pde_binary_data(),
                                       pde_binary_data() + pde_binary_size());
  Require(!saved_pdf.empty(), "mixed edited PDF serialized");
  const uint32_t reopened =
      pde_open_memory(saved_pdf.data(), static_cast<uint32_t>(saved_pdf.size()),
                      "doc-abi3-reopen", "source-abi3-reopen", nullptr);
  Require(reopened != 0, "reopen mixed edited PDF");
  const std::string reopened_page = pde_describe_page(reopened, 0);
  Require(reopened_page.find("\"type\":\"image\"") != std::string::npos &&
              reopened_page.find("\"type\":\"form\"") != std::string::npos,
          "RGBA image and native Form content survive save and reopen");
  Require(pde_close(reopened) == 1, "close reopened ABI3 PDF");
  Require(
      std::string(pde_document_info(document))
              .find("\"revision\":3,\"savedRevision\":0") != std::string::npos,
      "export does not confirm saved revision");
  const char* confirmed = pde_confirm_save(document, 3);
  Require(confirmed != nullptr &&
              std::string(confirmed).find(
                  "\"revision\":3,\"savedRevision\":3") != std::string::npos,
          "confirmSave advances only savedRevision");
  Require(pde_confirm_save(document, 4) == nullptr,
          "confirmSave rejects a future revision");
  Require(
      std::string(pde_document_info(document))
              .find("\"revision\":3,\"savedRevision\":3") != std::string::npos,
      "failed save confirmation is atomic");
  Require(pde_close(document) == 1, "close ABI3 transaction PDF");
}

void TestObjectAlignment() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f\n60 50 10 30 re f"),
  });
  const uint32_t document = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "doc-align", "source-align", nullptr);
  Require(document != 0, "open alignment fixture");
  const std::string before = RequireResult(pde_describe_page(document, 0), "describe alignment fixture");
  const std::string page_id = PageIdFromDescription(before);
  const std::string first = FirstObjectId(before);
  const size_t first_start = before.find("\"id\":\"", before.find("\"objects\":["));
  const size_t second_start = before.find("\"id\":\"", first_start + 1);
  Require(first_start != std::string::npos && second_start != std::string::npos,
          "alignment fixture has two objects");
  const std::string second = before.substr(second_start + 6, before.find('"', second_start + 6) - (second_start + 6));
  const char* ids[] = {first.c_str(), second.c_str()};
  Require(std::abs(JsonNumberAfter(before, "\"bounds\":{\"x\":", 0) - 10) < 0.01 &&
          std::abs(JsonNumberAfter(before, "\"bounds\":{\"x\":", 1) - 60) < 0.01,
          "source objects have distinct positions");
  PdeEditCommand command{};
  command.type = 21;
  command.page_id = page_id.c_str();
  command.ids = ids;
  command.id_count = 2;
  command.values[0] = 0;
  Require(pde_preview_commands(document, 0, &command, 1) != nullptr,
          "preview object alignment");
  Require(JsonNumberAfter(RequireResult(pde_describe_page(document, 0), "alignment preview unchanged"),
                          "\"bounds\":{\"x\":", 1) > 59,
          "alignment preview does not commit");
  Require(pde_apply_commands(document, 0, "align-left", &command, 1) != nullptr,
          "align two real PDF objects");
  const std::string aligned = RequireResult(pde_describe_page(document, 0), "describe aligned page");
  Require(std::abs(JsonNumberAfter(aligned, "\"bounds\":{\"x\":", 0) -
                   JsonNumberAfter(aligned, "\"bounds\":{\"x\":", 1)) < 0.01,
          "two native objects share left edge");
  Require(pde_undo(document) != nullptr, "undo alignment");
  const std::string undone = RequireResult(pde_describe_page(document, 0), "describe undo alignment");
  Require(JsonNumberAfter(undone, "\"bounds\":{\"x\":", 1) > 59,
          "undo restores original object position");
  Require(pde_redo(document) != nullptr, "redo alignment");
  Require(pde_save_memory(document) != nullptr, "save aligned PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
                                             "doc-align-reopen", "source-align-reopen", nullptr);
  Require(reopened != 0, "reopen aligned PDF");
  const std::string reopen_page = RequireResult(pde_describe_page(reopened, 0), "describe reopened aligned PDF");
  Require(std::abs(JsonNumberAfter(reopen_page, "\"bounds\":{\"x\":", 0) -
                   JsonNumberAfter(reopen_page, "\"bounds\":{\"x\":", 1)) < 0.01,
          "aligned native geometry survives save and reopen");
  Require(pde_close(reopened) == 1 && pde_close(document) == 1,
          "close alignment fixtures");
}

void TestObjectDistribution() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("10 10 10 10 re f\n60 10 10 10 re f\n200 10 10 10 re f"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "doc-distribute", "source-distribute", nullptr);
  Require(doc != 0, "open distribution fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "describe distribution fixture");
  const std::string page_id = PageIdFromDescription(before);
  std::vector<std::string> ids;
  size_t position = before.find("\"objects\":[");
  for (int index = 0; index < 3; ++index) {
    position = before.find("\"id\":\"", position + 1);
    Require(position != std::string::npos, "distribution fixture object IDs");
    ids.push_back(before.substr(position + 6, before.find('"', position + 6) - position - 6));
  }
  const char* targets[] = {ids[0].c_str(), ids[1].c_str(), ids[2].c_str()};
  PdeEditCommand distribute{};
  distribute.type = 24; distribute.page_id = page_id.c_str();
  distribute.ids = targets; distribute.id_count = 3;
  Require(pde_apply_commands(doc, 0, "distribute-three", &distribute, 1) != nullptr,
          "distribute three PDF objects in one real transaction");
  const std::string after = RequireResult(pde_describe_page(doc, 0), "describe distributed objects");
  Require(std::abs(JsonNumberAfter(after, "\"bounds\":{\"x\":", 0) - 10) < 0.01 &&
          std::abs(JsonNumberAfter(after, "\"bounds\":{\"x\":", 1) - 105) < 0.01 &&
          std::abs(JsonNumberAfter(after, "\"bounds\":{\"x\":", 2) - 200) < 0.01,
          "middle object center is evenly spaced; endpoints remain stable");
  Require(pde_undo(doc) != nullptr &&
          std::abs(JsonNumberAfter(RequireResult(pde_describe_page(doc, 0), "undo distribution"),
                                   "\"bounds\":{\"x\":", 1) - 60) < 0.01,
          "distribution undo restores middle geometry");
  Require(pde_redo(doc) != nullptr && pde_save_memory(doc) != nullptr,
          "redo distribution and save native PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
                                             "dist-reopened", "dist-saved", nullptr);
  Require(reopened != 0 &&
          std::abs(JsonNumberAfter(RequireResult(pde_describe_page(reopened, 0), "reopened distribution"),
                                   "\"bounds\":{\"x\":", 1) - 105) < 0.01,
          "real distributed geometry survives save and reopen");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close distribution fixtures");
}

void TestNestedObjectTransform() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] "
      "/Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>",
      Stream("q 1 0 0 1 30 50 cm /Fm Do Q q 1 0 0 1 130 50 cm /Fm Do Q"),
      Stream("0 0 20 10 re f", "/Type /XObject /Subtype /Form /BBox [0 0 50 20]"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "nested-transform", "shared-form", nullptr);
  Require(doc != 0, "open two instances of a shared Form stream");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "describe shared Form instances");
  Require(Count(before, "\"type\":\"path\"") == 2, "both nested paths are described");
  const std::string page_id = PageIdFromDescription(before);
  const std::string child_id = JsonStringAfter(before, "{\"id\":\"", before.find("\"type\":\"form\""));
  const char* selected[] = {child_id.c_str()};
  PdeEditCommand move{};
  move.type = 4; move.page_id = page_id.c_str(); move.ids = selected; move.id_count = 1;
  move.values[0] = 1; move.values[3] = 1; move.values[4] = 20;
  const auto original = RenderPixels(doc, 0, 240, 240);
  Require(pde_preview_commands(doc, 0, &move, 1) != nullptr &&
          std::string(pde_describe_page(doc, 0)) == before,
          "nested transform preview does not mutate either Form instance");
  Require(pde_apply_commands(doc, 0, "move-one-form-child", &move, 1) != nullptr,
          "move a nested path in normalized page coordinates");
  const std::string after = RequireResult(pde_describe_page(doc, 0), "describe isolated nested edit");
  Require(std::abs(JsonNumberAfter(after, "\"bounds\":{\"x\":", 1) -
                   JsonNumberAfter(before, "\"bounds\":{\"x\":", 1) - 20) < 0.01 &&
          std::abs(JsonNumberAfter(after, "\"bounds\":{\"x\":", 3) -
                   JsonNumberAfter(before, "\"bounds\":{\"x\":", 3)) < 0.01,
          "moving one Form child leaves the other shared instance unchanged");
  const auto changed = RenderPixels(doc, 0, 240, 240);
  Require(changed != original && pde_undo(doc) != nullptr &&
          RenderPixels(doc, 0, 240, 240) == original,
          "nested movement is visible and undo restores both instances");
  Require(pde_redo(doc) != nullptr && pde_save_memory(doc) != nullptr,
          "redo nested Form edit and save");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "nested-reopen", "nested-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 240, 240) == changed,
          "isolated Form child transformation survives save and reopen");
  const std::string reopened_page = RequireResult(pde_describe_page(reopened, 0), "describe reopened Form");
  const std::string child_to_delete = JsonStringAfter(reopened_page, "{\"id\":\"",
      reopened_page.find("\"type\":\"form\""));
  const std::string reopened_page_id = PageIdFromDescription(reopened_page);
  const char* removed[] = {child_to_delete.c_str()};
  PdeEditCommand clipped_move{};
  clipped_move.type = 4; clipped_move.page_id = reopened_page_id.c_str();
  clipped_move.ids = removed; clipped_move.id_count = 1;
  clipped_move.values[0] = 1; clipped_move.values[3] = 1; clipped_move.values[4] = 80;
  Require(pde_apply_commands(reopened, 0, "clipped-form-move", &clipped_move, 1) == nullptr &&
          std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
          RenderPixels(reopened, 0, 240, 240) == changed,
          "nested move outside the Form BBox fails without hiding PDF content");
  PdeEditCommand deletion{};
  deletion.type = 5; deletion.page_id = reopened_page_id.c_str();
  deletion.ids = removed; deletion.id_count = 1;
  Require(pde_apply_commands(reopened, 0, "delete-one-form-child", &deletion, 1) != nullptr,
          "delete a nested child from only one shared Form instance");
  const std::string deleted = RequireResult(pde_describe_page(reopened, 0), "describe nested deletion");
  Require(Count(deleted, "\"type\":\"path\"") == 1,
          "other shared Form instance survives nested deletion");
  Require(RenderPixels(reopened, 0, 240, 240) != changed,
          "nested child deletion changes PDF appearance");
  Require(pde_undo(reopened) != nullptr && RenderPixels(reopened, 0, 240, 240) == changed,
          "nested deletion undo restores the original instance");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close nested Form instances");
}

void TestNestedTextReplacement() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Outer 6 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Outer 6 0 R >> >> /Contents 5 0 R >>",
      Stream("q /Outer Do Q"),
      Stream("q /Inner Do Q q 1 0 0 1 0 -50 cm /Inner Do Q",
             "/Type /XObject /Subtype /Form /BBox [0 0 300 300] "
             "/Resources << /XObject << /Inner 7 0 R >> >>"),
      Stream("BT /F1 20 Tf 30 200 Td (ORIGINAL) Tj ET",
             "/Type /XObject /Subtype /Form /BBox [0 0 300 300] "
             "/Resources << /Font << /F1 8 0 R >> >>"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const auto* bytes = reinterpret_cast<const uint8_t*>(pdf.data());
  const uint32_t doc = pde_open_memory(bytes, static_cast<uint32_t>(pdf.size()),
                                        "nested-text", "shared-forms", nullptr);
  Require(doc != 0, "open doubly nested shared text fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "describe nested text");
  const auto block_ids = TextBlockIds(before);
  Require(block_ids.size() == 2 && Count(before, "\"editability\":\"direct\"") == 2,
          "both safe nested text blocks expose direct editing");
  const std::string page_id = PageIdFromDescription(before);
  const auto untouched_other_page = RenderPixels(doc, 1, 300, 300);
  PdeTextEdit edit{0, block_ids[0].c_str(), 0, 8, "CHANGED", nullptr};
  const std::string preview = RequireResult(pde_preview_text(doc, &edit),
                                             "preview nested text replacement");
  Require(std::string(pde_describe_page(doc, 0)) == before &&
              RenderPixels(doc, 1, 300, 300) == untouched_other_page,
          "nested text preview leaves selected and shared source pages untouched");
  Require(pde_apply_text(doc, 0, "change-one-nested-text", &edit, 1) != nullptr,
          "replace nested text within one shared Form instance");
  const std::string changed = RequireResult(pde_describe_page(doc, 0), "describe nested replacement");
  Require(Count(changed, "\"text\":\"CHANGED\"") == 1 &&
              Count(changed, "\"text\":\"ORIGINAL\"") == 1 &&
              std::abs(JsonNumberAfter(preview, "\"bounds\":{\"x\":") -
                       JsonNumberAfter(changed, "\"bounds\":{\"x\":", 2)) < 0.01 &&
              std::abs(JsonNumberAfter(preview, "\"y\":") -
                       JsonNumberAfter(changed, "\"y\":", 2)) < 0.01,
          "only one nested text changes and preview matches its page coordinates");
  Require(RenderPixels(doc, 1, 300, 300) == untouched_other_page &&
              Count(RequireResult(pde_describe_page(doc, 1), "shared second page"),
                    "\"text\":\"ORIGINAL\"") == 2,
          "other page's Form instances remain original");
  Require(pde_save_memory(doc) != nullptr, "save nested text replacement");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
                                             "nested-reopened", "saved-nested", nullptr);
  Require(reopened != 0, "reopen nested text replacement");
  const std::string restored = RequireResult(pde_describe_page(reopened, 0),
                                              "describe saved nested text");
  Require(Count(restored, "\"text\":\"CHANGED\"") == 1 &&
              Count(restored, "\"text\":\"ORIGINAL\"") == 1 &&
              RenderPixels(reopened, 1, 300, 300) == untouched_other_page,
          "nested text and sibling/page isolation survive PDF save and reopen");
  const std::string restored_page_id = PageIdFromDescription(restored);
  const auto restored_block_ids = TextBlockIds(restored);
  Require(restored_block_ids.size() == 2, "resolve nested style target after reopening");
  const char* selected[] = {restored_block_ids[0].c_str()};
  PdeEditCommand style{};
  style.type = 2;
  style.page_id = restored_page_id.c_str();
  style.ids = selected;
  style.id_count = 1;
  style.flags = 2 | 4 | 8;
  style.values[0] = 18;
  style.values[1] = 1;
  style.values[2] = 0;
  style.values[3] = 0;
  style.values[4] = 1;
  Require(pde_preview_commands(reopened, 0, &style, 1) != nullptr &&
              std::string(pde_describe_page(reopened, 0)) == restored,
          "whole-block nested style preview is non-mutating");
  Require(pde_apply_commands(reopened, 0, "style-one-nested-text", &style, 1) != nullptr,
          "apply style to only the selected nested text");
  const std::string styled = RequireResult(pde_describe_page(reopened, 0),
                                            "describe styled nested text");
  Require(styled.find("\"fontSize\":18,\"color\":[1,0,0],\"characterSpacing\":1") !=
              std::string::npos &&
              Count(styled, "\"text\":\"ORIGINAL\"") == 1 &&
              RenderPixels(reopened, 1, 300, 300) == untouched_other_page,
          "size, color and spacing change without altering sibling or shared page");
  PdeEditCommand range = style;
  range.flags |= 16;
  range.start_utf16 = 0;
  range.end_utf16 = 2;
  range.flags |= 32; range.values[5] = 1;
  Require(pde_preview_commands(reopened, 1, &range, 1) != nullptr &&
              std::string(pde_describe_page(reopened, 0)) == styled,
          "nested range formatting preview preserves the active Form");
  Require(pde_apply_commands(reopened, 1, "style-nested-range", &range, 1) != nullptr &&
              std::string(pde_describe_page(reopened, 0)).find("\"underline\":true") != std::string::npos &&
              RenderPixels(reopened, 1, 300, 300) == untouched_other_page &&
              pde_undo(reopened) != nullptr && std::string(pde_describe_page(reopened, 0)) == styled,
          "nested range underline is real, isolated and undone in one step");
  Require(pde_save_memory(reopened) != nullptr, "save styled nested Form");
  const std::vector<uint8_t> styled_pdf(pde_binary_data(),
                                         pde_binary_data() + pde_binary_size());
  const uint32_t styled_reopen = pde_open_memory(
      styled_pdf.data(), static_cast<uint32_t>(styled_pdf.size()),
      "nested-styled", "saved-style", nullptr);
  Require(styled_reopen != 0 &&
              RequireResult(pde_describe_page(styled_reopen, 0), "reopen nested style")
                      .find("\"fontSize\":18,\"color\":[1,0,0],\"characterSpacing\":1") !=
                  std::string::npos &&
              RenderPixels(styled_reopen, 1, 300, 300) == untouched_other_page,
          "nested whole-block style and shared Form isolation survive save and reopen");
  const std::string before_clear = RequireResult(
      pde_describe_page(styled_reopen, 0), "describe before clearing nested text");
  const auto clear_ids = TextBlockIds(before_clear);
  Require(clear_ids.size() == 2, "resolve nested text for clearing");
  PdeTextEdit clear{0, clear_ids[0].c_str(), 0, 7, "", nullptr};
  Require(pde_apply_text(styled_reopen, 0, "clear-one-nested-text", &clear, 1) != nullptr &&
              Count(RequireResult(pde_describe_page(styled_reopen, 0),
                                  "describe cleared nested text"),
                    "\"text\":\"ORIGINAL\"") == 1 &&
              RenderPixels(styled_reopen, 1, 300, 300) == untouched_other_page,
          "empty replacement removes only the selected nested text object");
  Require(pde_save_memory(styled_reopen) != nullptr,
          "save cleared nested text Form");
  const std::vector<uint8_t> cleared_pdf(pde_binary_data(),
                                           pde_binary_data() + pde_binary_size());
  const uint32_t cleared_reopen = pde_open_memory(
      cleared_pdf.data(), static_cast<uint32_t>(cleared_pdf.size()),
      "nested-cleared", "saved-clear", nullptr);
  Require(cleared_reopen != 0 &&
              Count(RequireResult(pde_describe_page(cleared_reopen, 0),
                                  "reopen cleared nested text"),
                    "\"text\":\"ORIGINAL\"") == 1 &&
              RenderPixels(cleared_reopen, 1, 300, 300) == untouched_other_page,
          "nested deletion survives save and reopen without mutating shared pages");
  Require(pde_undo(doc) != nullptr &&
              Count(RequireResult(pde_describe_page(doc, 0), "undo nested text"),
                    "\"text\":\"ORIGINAL\"") == 2 &&
              pde_redo(doc) != nullptr &&
              Count(RequireResult(pde_describe_page(doc, 0), "redo nested text"),
                    "\"text\":\"CHANGED\"") == 1,
          "nested text edit survives transaction undo and redo");
  PdeTextEdit partial{0, block_ids[0].c_str(), 0, 2, "UP", nullptr};
  Require(pde_apply_text(doc, 3, "edit-nested-utf16-range", &partial, 1) != nullptr &&
              Count(RequireResult(pde_describe_page(doc, 0), "partial nested edit"),
                    "\"text\":\"UPANGED\"") == 1,
          "UTF-16 subrange replacement retains the rest of the nested text");
  Require(pde_save_memory(doc) != nullptr, "save nested range replacement");
  const std::vector<uint8_t> partial_pdf(pde_binary_data(),
                                           pde_binary_data() + pde_binary_size());
  const uint32_t partial_reopen = pde_open_memory(
      partial_pdf.data(), static_cast<uint32_t>(partial_pdf.size()),
      "nested-range", "saved-range", nullptr);
  Require(partial_reopen != 0 &&
              Count(RequireResult(pde_describe_page(partial_reopen, 0),
                                  "reopen nested range replacement"),
                    "\"text\":\"UPANGED\"") == 1,
          "nested UTF-16 range replacement survives PDF save and reopen");
  Require(pde_close(partial_reopen) == 1 &&
              pde_close(cleared_reopen) == 1 && pde_close(styled_reopen) == 1 &&
              pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close nested text fixtures");

  const std::string tagged = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/StructParents 0 /Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>",
      Stream("/Fm Do"),
      Stream("BT /F1 20 Tf 30 200 Td (ORIGINAL) Tj ET",
             "/Type /XObject /Subtype /Form /BBox [0 0 300 300] "
             "/Resources << /Font << /F1 6 0 R >> >>"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t structured = pde_open_memory(
      reinterpret_cast<const uint8_t*>(tagged.data()), static_cast<uint32_t>(tagged.size()),
      "structured-form", "tagged-source", nullptr);
  Require(structured != 0, "open structured Form fixture");
  const std::string described = RequireResult(pde_describe_page(structured, 0),
                                                "describe structured Form");
  Require(described.find("\"editability\":\"geometry-only\"") == std::string::npos,
          "unmarked Form text remains editable on a page with unrelated structure metadata");
  const auto structured_ids = TextBlockIds(described);
  Require(structured_ids.size() == 1, "resolve structured text block");
  PdeTextEdit rejected{0, structured_ids[0].c_str(), 0, 8, "CHANGED", nullptr};
  Require(pde_preview_text(structured, &rejected) != nullptr &&
              pde_document_revision(structured) == 0 &&
              std::string(pde_describe_page(structured, 0)) == described,
          "unmarked Form text preview preserves unrelated page structure");
  const std::string structured_object_id =
      JsonStringAfter(described, "\"sourceObjectIds\":[\"");
  const std::string structured_page_id = PageIdFromDescription(described);
  const char* selected_object[]{structured_object_id.c_str()};
  PdeEditCommand structured_move{};
  structured_move.type = 4;
  structured_move.page_id = structured_page_id.c_str();
  structured_move.ids = selected_object;
  structured_move.id_count = 1;
  structured_move.values[0] = 1;
  structured_move.values[3] = 1;
  structured_move.values[4] = 1;
  Require(pde_preview_commands(structured, 0, &structured_move, 1) != nullptr &&
              pde_document_revision(structured) == 0,
          "unmarked nested geometry can move without changing tagged objects");
  Require(pde_close(structured) == 1, "close structured Form fixture");

  const std::string marked = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>",
      Stream("/Fm Do"),
      Stream("/Span << /ActualText (ORIGINAL) >> BDC "
             "BT /F1 20 Tf 30 200 Td (ORIGINAL) Tj ET EMC",
             "/Type /XObject /Subtype /Form /BBox [0 0 300 300] "
             "/Resources << /Font << /F1 6 0 R >> >>"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t marked_doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(marked.data()), static_cast<uint32_t>(marked.size()),
      "marked-form", "marked-source", nullptr);
  Require(marked_doc != 0, "open marked Form fixture");
  const std::string marked_page = RequireResult(pde_describe_page(marked_doc, 0),
                                                 "describe marked Form");
  const auto marked_ids = TextBlockIds(marked_page);
  Require(marked_ids.size() == 1 &&
              marked_page.find("\"editability\":\"geometry-only\"") == std::string::npos,
          "locally mapped ActualText inside a Form is editable");
  PdeTextEdit marked_edit{0, marked_ids[0].c_str(), 0, 8, "CHANGED", nullptr};
  Require(pde_preview_text(marked_doc, &marked_edit) != nullptr &&
              pde_document_revision(marked_doc) == 0 &&
              std::string(pde_describe_page(marked_doc, 0)) == marked_page,
          "marked nested text preview leaves active glyphs and ActualText unchanged");
  Require(pde_apply_text(marked_doc, 0, "replace-marked-form-text", &marked_edit, 1) != nullptr &&
              std::string(pde_describe_page(marked_doc, 0)).find("CHANGED") != std::string::npos &&
              pde_save_memory(marked_doc) != nullptr,
          "marked nested replacement updates ActualText and saves");
  const std::vector<uint8_t> marked_saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t marked_reopen = pde_open_memory(marked_saved.data(), static_cast<uint32_t>(marked_saved.size()),
      "marked-form-reopened", "marked-form-saved", nullptr);
  Require(marked_reopen != 0 && std::string(pde_describe_page(marked_reopen, 0)).find("CHANGED") != std::string::npos,
          "the changed marked Form text survives save/reopen");
  Require(pde_close(marked_reopen) == 1 && pde_close(marked_doc) == 1, "close marked Form fixture");
}

void TestNestedSharedFormTextTransformAndEdit() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>",
      Stream("q /Fm Do Q"),
      Stream("0 0 20 10 re f BT /F1 16 Tf 10 30 Td (Shared text) Tj ET",
             "/Type /XObject /Subtype /Form /BBox [0 0 200 100] "
             "/Resources << /Font << /F1 7 0 R >> >>"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const auto* bytes = reinterpret_cast<const uint8_t*>(pdf.data());
  const uint32_t doc = pde_open_memory(bytes, static_cast<uint32_t>(pdf.size()),
                                       "shared-form-text", "shared-form-source", nullptr);
  Require(doc != 0, "open shared Form text fixture");
  const std::string p0_before = RequireResult(pde_describe_page(doc, 0), "describe p0 before");
  const std::string p1_before = RequireResult(pde_describe_page(doc, 1), "describe p1 before");
  const std::string p0_id = PageIdFromDescription(p0_before);
  const std::string p1_id = PageIdFromDescription(p1_before);

  Require(p0_before.find("Shared text") != std::string::npos &&
          p1_before.find("Shared text") != std::string::npos,
          "both pages initially share the Form text object");

  const size_t text_pos = p0_before.find("\"type\":\"text\"");
  Require(text_pos != std::string::npos, "find nested text on p0");
  const size_t text_obj_start = p0_before.rfind("{\"id\":\"", text_pos);
  const std::string text_obj_id = JsonStringAfter(p0_before, "{\"id\":\"", text_obj_start);

  const size_t path_pos = p0_before.find("\"type\":\"path\"");
  Require(path_pos != std::string::npos, "find nested path on p0");
  const size_t path_obj_start = p0_before.rfind("{\"id\":\"", path_pos);
  const std::string path_obj_id = JsonStringAfter(p0_before, "{\"id\":\"", path_obj_start);

  const auto p0_orig_pixels = RenderPixels(doc, 0, 300, 300);
  const auto p1_orig_pixels = RenderPixels(doc, 1, 300, 300);

  // 1. Preview nested text transform
  const char* text_targets[] = {text_obj_id.c_str()};
  PdeEditCommand move_text{};
  move_text.type = 4;
  move_text.page_id = p0_id.c_str();
  move_text.ids = text_targets;
  move_text.id_count = 1;
  move_text.values[0] = 1; move_text.values[3] = 1;
  move_text.values[4] = 25; move_text.values[5] = 15;

  Require(pde_preview_commands(doc, 0, &move_text, 1) != nullptr &&
          std::string(pde_describe_page(doc, 0)) == p0_before &&
          std::string(pde_describe_page(doc, 1)) == p1_before &&
          RenderPixels(doc, 0, 300, 300) == p0_orig_pixels &&
          RenderPixels(doc, 1, 300, 300) == p1_orig_pixels,
          "preview of nested text transform leaves both shared pages untouched");

  // 2. Failure atomicity: batch with valid move + out-of-bounds move
  const char* path_targets[] = {path_obj_id.c_str()};
  PdeEditCommand move_bad = move_text;
  move_bad.ids = path_targets;
  move_bad.values[4] = 500;
  PdeEditCommand batch[2] = {move_text, move_bad};

  Require(pde_apply_commands(doc, 0, "failing-batch", batch, 2) == nullptr &&
          std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
          pde_document_revision(doc) == 0 &&
          std::string(pde_describe_page(doc, 0)) == p0_before &&
          RenderPixels(doc, 0, 300, 300) == p0_orig_pixels,
          "nested transform failure rejects the transaction without partial writes");

  // 3. Apply valid nested text transform on Page 0 (isolating Page 0's Form instance)
  Require(pde_apply_commands(doc, 0, "move-nested-text", &move_text, 1) != nullptr &&
          pde_document_revision(doc) == 1,
          "apply nested text transform to isolate shared Form on page 0");
  const std::string p0_after_move = RequireResult(pde_describe_page(doc, 0), "p0 after move");
  const std::string p1_after_move = RequireResult(pde_describe_page(doc, 1), "p1 after move");

  Require(RenderPixels(doc, 0, 300, 300) != p0_orig_pixels,
          "page 0 render changes after nested text movement");
  Require(RenderPixels(doc, 1, 300, 300) == p1_orig_pixels &&
          p1_after_move == p1_before,
          "page 1 remains completely identical and isolated");

  // 4. Undo / Redo
  Require(pde_undo(doc) != nullptr &&
          RenderPixels(doc, 0, 300, 300) == p0_orig_pixels &&
          std::string(pde_describe_page(doc, 0)) == p0_before,
          "undo restores original page 0 appearance and geometry");
  Require(pde_redo(doc) != nullptr &&
          RenderPixels(doc, 0, 300, 300) != p0_orig_pixels,
          "redo reapplies nested text transform");

  // 5. Save & Reopen
  Require(pde_save_memory(doc) != nullptr, "save nested text transform PDF");
  const std::vector<uint8_t> saved_pdf(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved_pdf.data(), static_cast<uint32_t>(saved_pdf.size()),
      "reopened-nested-text", "saved-nested-text", nullptr);
  Require(reopened != 0, "reopen PDF after nested text transform");

  const std::string p0_reopened = RequireResult(pde_describe_page(reopened, 0), "p0 reopened");
  const std::string p1_reopened = RequireResult(pde_describe_page(reopened, 1), "p1 reopened");
  Require(p0_reopened.find("Shared text") != std::string::npos &&
          p1_reopened.find("Shared text") != std::string::npos &&
          RenderPixels(reopened, 1, 300, 300) == p1_orig_pixels,
          "reopened PDF retains text on both pages and original appearance on page 1");

  // 6. Edit text inside the moved nested text object on reopened PDF
  const auto reopened_p0_block_ids = TextBlockIds(p0_reopened);
  Require(!reopened_p0_block_ids.empty(), "find text block on reopened page 0");
  PdeTextEdit replace_edit{0, reopened_p0_block_ids[0].c_str(), 0, 11, "Moved text", nullptr};

  Require(pde_apply_text(reopened, 0, "edit-moved-nested-text", &replace_edit, 1) != nullptr,
          "replace text in transformed nested text object");
  const std::string p0_edited = RequireResult(pde_describe_page(reopened, 0), "p0 edited");
  const std::string p1_edited = RequireResult(pde_describe_page(reopened, 1), "p1 edited");

  Require(p0_edited.find("Moved text") != std::string::npos &&
          p0_edited.find("Shared text") == std::string::npos &&
          p1_edited.find("Shared text") != std::string::npos &&
          RenderPixels(reopened, 1, 300, 300) == p1_orig_pixels,
          "text replacement on page 0 does not mutate shared page 1");

  // 7. Save and reopen again to verify second save of isolated Form
  Require(pde_save_memory(reopened) != nullptr, "save second edit of nested Form");
  const std::vector<uint8_t> twice_saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t twice_reopened = pde_open_memory(
      twice_saved.data(), static_cast<uint32_t>(twice_saved.size()),
      "twice-reopened", "twice-saved", nullptr);
  Require(twice_reopened != 0, "reopen twice-saved PDF");

  const std::string p0_twice = RequireResult(pde_describe_page(twice_reopened, 0), "p0 twice");
  const std::string p1_twice = RequireResult(pde_describe_page(twice_reopened, 1), "p1 twice");
  Require(p0_twice.find("Moved text") != std::string::npos &&
          p1_twice.find("Shared text") != std::string::npos &&
          RenderPixels(twice_reopened, 1, 300, 300) == p1_orig_pixels,
          "twice-reopened PDF cleanly maintains edited page 0 and untouched page 1");

  Require(pde_close(twice_reopened) == 1 &&
          pde_close(reopened) == 1 &&
          pde_close(doc) == 1,
          "close shared Form text transform fixtures");
}

void TestObjectGroup() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("q 0 0 1 rg 10 40 50 20 re f Q BT /F1 18 Tf 10 180 Td (Grouped text) Tj ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "group-doc", "group-source", nullptr);
  Require(doc != 0, "open real object group fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "describe group source");
  const std::string page_id = PageIdFromDescription(before);
  const std::string first = FirstObjectId(before);
  const size_t first_pos = before.find("\"id\":\"", before.find("\"objects\":["));
  const size_t next_pos = before.find("\"id\":\"", first_pos + 1);
  Require(first_pos != std::string::npos && next_pos != std::string::npos,
          "text and vector path have separate object identities");
  const std::string second = before.substr(next_pos + 6,
      before.find('"', next_pos + 6) - next_pos - 6);
  const char* selected[] = {first.c_str(), second.c_str()};
  PdeEditCommand group{};
  group.type = 26; group.page_id = page_id.c_str(); group.target_id = "group-alpha";
  group.ids = selected; group.id_count = 2;
  const auto pixels = RenderPixels(doc, 0, 240, 240);
  Require(pde_preview_commands(doc, 0, &group, 1) != nullptr &&
          std::string(pde_describe_page(doc, 0)) == before,
          "Form grouping preview is non-mutating");
  Require(pde_apply_commands(doc, 0, "group-originals", &group, 1) != nullptr,
          "group real text and vector objects as one Form transaction");
  const std::string grouped = RequireResult(pde_describe_page(doc, 0), "describe persisted Form group");
  Require(grouped.find("\"id\":\"group-alpha\"") != std::string::npos &&
          grouped.find("\"type\":\"group\"") != std::string::npos &&
          grouped.find("\"id\":\"" + first + "\"") != std::string::npos &&
          grouped.find("\"id\":\"" + second + "\"") != std::string::npos,
          "group root and original child IDs remain accessible as real objects");
  Require(RenderPixels(doc, 0, 240, 240) == pixels,
          "grouping preserves visible text and vector pixels");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_page(doc, 0)) == before,
          "group undo restores original top-level objects");
  Require(pde_redo(doc) != nullptr, "redo persistent group");
  const char* group_ids[] = {"group-alpha"};
  PdeEditCommand move{};
  move.type = 4; move.page_id = page_id.c_str(); move.ids = group_ids; move.id_count = 1;
  move.values[0] = 1; move.values[3] = 1; move.values[4] = 12;
  Require(pde_apply_commands(doc, 3, "move-group", &move, 1) != nullptr,
          "transform persistent Form as one object");
  const auto moved_pixels = RenderPixels(doc, 0, 240, 240);
  Require(moved_pixels != pixels && pde_save_memory(doc) != nullptr,
          "transformed group saves with changed visible position");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "group-reopen", "group-saved", nullptr);
  Require(reopened != 0, "reopen saved group form");
  const std::string reopened_desc = RequireResult(pde_describe_page(reopened, 0), "describe reopened group");
  Require(reopened_desc.find("\"id\":\"group-alpha\"") != std::string::npos &&
          reopened_desc.find("\"id\":\"" + first + "\"") != std::string::npos &&
          RenderPixels(reopened, 0, 240, 240) == moved_pixels,
          "group metadata and transformed glyphs survive PDF roundtrip");
  const std::string reopened_page = PageIdFromDescription(reopened_desc);
  PdeEditCommand ungroup{};
  ungroup.type = 27; ungroup.page_id = reopened_page.c_str();
  ungroup.target_id = "group-alpha";
  Require(pde_apply_commands(reopened, 0, "ungroup-reopened", &ungroup, 1) != nullptr,
          "ungroup saved Form into native text and vector objects");
  const std::string separated = RequireResult(pde_describe_page(reopened, 0), "describe ungrouped objects");
  Require(separated.find("\"type\":\"group\"") == std::string::npos &&
          separated.find("\"id\":\"" + first + "\"") != std::string::npos &&
          separated.find("\"id\":\"" + second + "\"") != std::string::npos &&
          RenderPixels(reopened, 0, 240, 240) == moved_pixels,
          "ungroup preserves original IDs and transformed PDF content");
  Require(pde_save_memory(reopened) != nullptr, "save ungrouped PDF");
  const std::vector<uint8_t> ungrouped(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t ungrouped_doc = pde_open_memory(ungrouped.data(), static_cast<uint32_t>(ungrouped.size()),
      "ungroup-reopen", "ungroup-saved", nullptr);
  Require(ungrouped_doc != 0 &&
          std::string(pde_describe_page(ungrouped_doc, 0)).find("\"type\":\"group\"") == std::string::npos &&
          RenderPixels(ungrouped_doc, 0, 240, 240) == moved_pixels,
          "ungrouped PDF survives save and reopen without losing appearance");
  Require(pde_undo(reopened) != nullptr &&
          std::string(pde_describe_page(reopened, 0)).find("\"type\":\"group\"") != std::string::npos,
          "ungroup undo restores persistent Form group");

  const uint32_t copies = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "group-copies", "group-copy-source", nullptr);
  Require(copies != 0, "open persistent group for copy and page duplication");
  const std::string copy_page_id = PageIdFromDescription(
      RequireResult(pde_describe_page(copies, 0), "describe copy source"));
  const char* object_pair[] = {"group-alpha", "group-copy"};
  PdeEditCommand copy{};
  copy.type = 16; copy.page_id = copy_page_id.c_str();
  copy.ids = object_pair; copy.id_count = 2; copy.values[0] = 80;
  Require(pde_apply_commands(copies, 0, "copy-persistent-group", &copy, 1) != nullptr,
          "copy Form group with new root and child identities");
  const auto copied_pixels = RenderPixels(copies, 0, 240, 240);
  Require(copied_pixels != moved_pixels && pde_save_memory(copies) != nullptr,
          "group copy visibly moves while the original remains");
  const std::vector<uint8_t> copied_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t copied_reopen = pde_open_memory(copied_bytes.data(),
      static_cast<uint32_t>(copied_bytes.size()), "copied-reopen", "copied-source", nullptr);
  const std::string copied_desc = RequireResult(pde_describe_page(copied_reopen, 0), "describe copied group");
  const std::string copy_members = copied_desc.substr(copied_desc.find("\"id\":\"group-copy\""));
  Require(copied_reopen != 0 && copied_desc.find("\"id\":\"group-alpha\"") != std::string::npos &&
          copied_desc.find("\"id\":\"group-copy\"") != std::string::npos &&
          copy_members.find("\"id\":\"" + first + "\"") == std::string::npos &&
          copy_members.find("\"id\":\"" + second + "\"") == std::string::npos &&
          RenderPixels(copied_reopen, 0, 240, 240) == copied_pixels,
          "original and cloned groups retain distinct child IDs after PDF roundtrip");

  const char* page_pair[] = {copy_page_id.c_str(), "group-page-copy"};
  PdeEditCommand duplicate{};
  duplicate.type = 12; duplicate.ids = page_pair; duplicate.id_count = 2;
  duplicate.target_id = copy_page_id.c_str();
  Require(pde_apply_commands(copies, 1, "duplicate-group-page", &duplicate, 1) != nullptr,
          "duplicate page containing two persistent groups");
  const std::string page_copy = RequireResult(pde_describe_page(copies, 1), "describe duplicated group page");
  Require(page_copy.find("\"type\":\"group\"") != std::string::npos &&
          page_copy.find("\"id\":\"group-alpha\"") == std::string::npos &&
          page_copy.find("\"id\":\"group-copy\"") == std::string::npos &&
          RenderPixels(copies, 1, 240, 240) == copied_pixels && pde_save_memory(copies) != nullptr,
          "page copy has independent group identities and equal visible PDF content");
  const std::vector<uint8_t> duplicated_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t duplicated_reopen = pde_open_memory(duplicated_bytes.data(),
      static_cast<uint32_t>(duplicated_bytes.size()), "duplicated-reopen", "duplicated-source", nullptr);
  const std::string duplicated_desc = RequireResult(
      pde_describe_page(duplicated_reopen, 1), "describe reopened group page");
  Require(duplicated_reopen != 0 &&
          duplicated_desc.find("\"id\":\"" + FirstObjectId(page_copy) + "\"") != std::string::npos &&
          duplicated_desc.find("\"type\":\"group\"") != std::string::npos &&
          RenderPixels(duplicated_reopen, 1, 240, 240) == copied_pixels,
          "duplicated page group identities and appearance survive save/reopen");
  Require(pde_close(duplicated_reopen) == 1 && pde_close(copied_reopen) == 1 &&
          pde_close(copies) == 1 && pde_close(ungrouped_doc) == 1 &&
          pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close native group fixtures");
}

void TestPageCrop() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [-10 -20 300 500] "
      "/CropBox [10 20 160 220] /Rotate 90 /UserUnit 2 "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("30 40 50 30 re f"),
  });
  const uint32_t document = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "crop-doc", "crop-source", nullptr);
  Require(document != 0, "open rotated CropBox fixture");
  const std::string before = RequireResult(pde_describe_page(document, 0), "describe original crop");
  const std::string page_id = PageIdFromDescription(before);
  const std::string object_id = FirstObjectId(before);
  const double width = JsonNumberAfter(before, "\"widthPt\":");
  const double height = JsonNumberAfter(before, "\"heightPt\":");
  Require(width > 40 && height > 40, "rotated UserUnit page has usable dimensions");
  const char* pages[] = {page_id.c_str()};
  PdeEditCommand crop{};
  crop.type = 25; crop.ids = pages; crop.id_count = 1;
  crop.values[0] = 10; crop.values[1] = 10;
  crop.values[2] = width - 20; crop.values[3] = height - 20;
  Require(pde_preview_commands(document, 0, &crop, 1) != nullptr &&
          std::string(pde_describe_page(document, 0)) == before,
          "page crop preview does not change original geometry");
  Require(pde_apply_commands(document, 0, "crop-real-page", &crop, 1) != nullptr,
          "crop a rotated PDF page through its native CropBox");
  const std::string cropped = RequireResult(pde_describe_page(document, 0), "describe cropped page");
  Require(std::abs(JsonNumberAfter(cropped, "\"widthPt\":") - (width - 20)) < 0.1 &&
          std::abs(JsonNumberAfter(cropped, "\"heightPt\":") - (height - 20)) < 0.1 &&
          cropped.find("\"id\":\"" + object_id + "\"") != std::string::npos,
          "crop changes real dimensions while retaining the original object ID");
  Require(pde_undo(document) != nullptr && std::string(pde_describe_page(document, 0)) == before,
          "crop undo restores original page bounds");
  Require(pde_redo(document) != nullptr && pde_save_memory(document) != nullptr,
          "redo crop and save to PDF bytes");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "crop-reopened", "crop-saved", nullptr);
  Require(reopened != 0 &&
          std::abs(JsonNumberAfter(RequireResult(pde_describe_page(reopened, 0), "reopened crop"),
                                   "\"widthPt\":") - (width - 20)) < 0.1,
          "native CropBox persists after save and reopen");
  Require(pde_close(reopened) == 1 && pde_close(document) == 1,
          "close crop fixtures");
}

void TestOutlineNavigation() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
      "<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 1 >>",
      "<< /Title (Chapter One) /Parent 5 0 R /Dest [3 0 R /Fit] >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "outline-doc", "outline-source", nullptr);
  Require(doc != 0, "open PDF with real outline destination");
  const std::string page = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "outline page"));
  const std::string entries = RequireResult(pde_describe_outline(doc), "read PDF outline");
  Require(entries.find("\"title\":\"Chapter One\"") != std::string::npos &&
          entries.find("\"pageId\":\"" + page + "\"") != std::string::npos &&
          entries.find("\"level\":0") != std::string::npos,
          "outline navigation resolves the actual in-document page ID");
  const char* pairs[] = {page.c_str(), "outline-copy"};
  PdeEditCommand duplicate{};
  duplicate.type = 12; duplicate.ids = pairs; duplicate.id_count = 2;
  duplicate.target_id = page.c_str();
  Require(pde_apply_commands(doc, 0, "copy-bookmarked-page", &duplicate, 1) != nullptr,
          "duplicate a bookmarked page without invalidating the source outline");
  Require(std::string(pde_describe_outline(doc)) == entries,
          "source bookmark stays attached to original page, not the duplicate");
  Require(pde_close(doc) == 1, "close outline fixture");
}

void TestLinkAnnotationNavigation() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << >> /Contents 5 0 R /Annots [ 7 0 R 8 0 R 9 0 R 10 0 R ] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << >> /Contents 6 0 R >>",
      Stream("q 1 0 0 rg 20 20 50 50 re f Q"),
      Stream("q 0 0 1 rg 30 30 60 60 re f Q"),
      // 7 0 obj: Direct internal Dest
      "<< /Type /Annot /Subtype /Link /Rect [20 200 120 230] /Dest [4 0 R /Fit] >>",
      // 8 0 obj: GoTo action Dest with XYZ location
      "<< /Type /Annot /Subtype /Link /Rect [20 160 120 190] "
      "/A << /S /GoTo /D [4 0 R /XYZ 15 250 1] >> >>",
      // 9 0 obj: External URI link - must not provide targetPageId
      "<< /Type /Annot /Subtype /Link /Rect [20 120 120 150] "
      "/A << /S /URI /URI (https://example.com) >> >>",
      // 10 0 obj: Broken Dest - non-existent target page
      "<< /Type /Annot /Subtype /Link /Rect [20 80 120 110] /Dest [99 0 R /Fit] >>",
  });

  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "link-doc", "link-source", nullptr);
  Require(doc != 0, "open PDF with link annotations");
  const std::string page1_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "page 1"));
  const std::string page2_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 1), "page 2"));

  const std::string annots = RequireResult(pde_describe_annotations(doc, 0), "describe link annotations on page 1");
  Require(annots.find("\"subtype\":\"link\"") != std::string::npos, "link annotations have subtype link");
  Require(annots.find("\"targetPageId\":\"" + page2_id + "\"") != std::string::npos, "valid link resolves to page 2 id");
  Require(annots.find("\"targetTopPt\":") != std::string::npos, "link with XYZ provides precise targetTopPt");
  Require(Count(annots, "\"targetPageId\":\"" + page2_id + "\"") == 2,
          "exactly the two resolvable internal links have targetPageId; external and broken links do not");

  // Duplicate page 2 and ensure link still points to original target page
  const char* duplicate_pair[] = {page2_id.c_str(), "page2-copy"};
  PdeEditCommand duplicate{};
  duplicate.type = 12; duplicate.ids = duplicate_pair; duplicate.id_count = 2;
  duplicate.target_id = page2_id.c_str();
  Require(pde_apply_commands(doc, 0, "duplicate-page2", &duplicate, 1) != nullptr,
          "duplicate target page without invalidating link resolution");

  const std::string annots_after_duplicate = RequireResult(pde_describe_annotations(doc, 0), "describe annotations after page duplicate");
  Require(Count(annots_after_duplicate, "\"targetPageId\":\"" + page2_id + "\"") == 2,
          "link targetPageId stays stably attached to original page ID after page edits");

  Require(pde_close(doc) == 1, "close link navigation fixture");
}

void TestPageDeleteDestinationIntegrity() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R /Annots [10 0 R 11 0 R] >>",
      // Page 1
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R /Annots [12 0 R] >>",
      // Page 2
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R >>",
      // Outlines root
      "<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 2 >>",
      // Bookmark 1: targets Page 0
      "<< /Title (Book 0) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
      // Bookmark 2: targets Page 2 via numeric index [2 /Fit]
      "<< /Title (Book 2) /Parent 6 0 R /Prev 7 0 R /Dest [2 /Fit] >>",
      // Page content
      Stream("10 10 20 20 re f"),
      // 10 0 obj: Link on Page 0 to Page 2 via numeric [2 /Fit]
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [2 /Fit] >>",
      // 11 0 obj: Link on Page 0 to Page 1 via [4 0 R /Fit]
      "<< /Type /Annot /Subtype /Link /Rect [10 40 50 60] /Dest [4 0 R /Fit] >>",
      // 12 0 obj: Link on Page 1 to Page 0 via [3 0 R /Fit]
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [3 0 R /Fit] >>",
  });

  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "delete-dest-doc", "delete-dest-source", nullptr);
  Require(doc != 0, "open 3-page destination integrity fixture");

  const std::string p0_desc = RequireResult(pde_describe_page(doc, 0), "p0");
  const std::string p1_desc = RequireResult(pde_describe_page(doc, 1), "p1");
  const std::string p2_desc = RequireResult(pde_describe_page(doc, 2), "p2");
  const std::string p0_id = PageIdFromDescription(p0_desc);
  const std::string p1_id = PageIdFromDescription(p1_desc);
  const std::string p2_id = PageIdFromDescription(p2_desc);

  // Test A: Attempt to delete Page 1 while Page 0 still has a link (11 0 R) to Page 1
  const char* del_p1[] = {p1_id.c_str()};
  PdeEditCommand cmd_del_p1{};
  cmd_del_p1.type = 7; cmd_del_p1.ids = del_p1; cmd_del_p1.id_count = 1;

  Require(pde_apply_commands(doc, 0, "del-p1-pruned", &cmd_del_p1, 1) != nullptr &&
          pde_document_revision(doc) == 1,
          "deleting page 1 prunes links that no longer have a target");
  const std::string remaining_links = RequireResult(pde_describe_annotations(doc, 0), "remaining links");
  Require(remaining_links.find("\"targetPageId\":\"" + p1_id + "\"") == std::string::npos &&
          remaining_links.find("\"targetPageId\":\"" + p2_id + "\"") != std::string::npos &&
          pde_undo(doc) != nullptr,
          "only the dangling link is removed and undo restores the pages");

  // Test B: Attempt to delete Page 2 while Book 2 points to Page 2
  const char* del_p2[] = {p2_id.c_str()};
  PdeEditCommand cmd_del_p2{};
  cmd_del_p2.type = 7; cmd_del_p2.ids = del_p2; cmd_del_p2.id_count = 1;

  Require(pde_apply_commands(doc, 2, "del-p2-pruned", &cmd_del_p2, 1) != nullptr &&
          pde_document_revision(doc) == 3,
          "deleting page 2 prunes its bookmark and incoming link");
  const std::string remaining_outline = RequireResult(pde_describe_outline(doc), "remaining outline");
  Require(remaining_outline.find("Book 2") == std::string::npos &&
          remaining_outline.find("Book 0") != std::string::npos,
          "bookmarks for surviving pages remain navigable");

  Require(pde_close(doc) == 1, "close first destination fixture");

  // Test C: Deleting Page 1 when NO surviving bookmark or link targets Page 1
  const std::string pdf_clean = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R /Annots [10 0 R] >>",
      // Page 1 (to be deleted; has a link to Page 0)
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R /Annots [11 0 R] >>",
      // Page 2
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R >>",
      // Outlines root
      "<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 2 >>",
      // Bookmark 1: targets Page 0
      "<< /Title (Book 0) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
      // Bookmark 2: targets Page 2 via numeric index [2 /Fit]
      "<< /Title (Book 2) /Parent 6 0 R /Prev 7 0 R /Dest [2 /Fit] >>",
      Stream("10 10 20 20 re f"),
      // 10 0 obj: Link on Page 0 to Page 2 via numeric [2 /Fit]
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [2 /Fit] >>",
      // 11 0 obj: Link on Page 1 to Page 0 via [3 0 R /Fit] (deleted with Page 1)
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [3 0 R /Fit] >>",
  });

  const uint32_t doc2 = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf_clean.data()), static_cast<uint32_t>(pdf_clean.size()),
      "delete-clean-doc", "delete-clean-source", nullptr);
  Require(doc2 != 0, "open clean deletion fixture");

  const std::string c_p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc2, 0), "c_p0"));
  const std::string c_p1_id = PageIdFromDescription(RequireResult(pde_describe_page(doc2, 1), "c_p1"));
  const std::string c_p2_id = PageIdFromDescription(RequireResult(pde_describe_page(doc2, 2), "c_p2"));

  const char* del_clean_p1[] = {c_p1_id.c_str()};
  PdeEditCommand cmd_del_clean_p1{};
  cmd_del_clean_p1.type = 7; cmd_del_clean_p1.ids = del_clean_p1; cmd_del_clean_p1.id_count = 1;

  Require(pde_apply_commands(doc2, 0, "del-p1-success", &cmd_del_clean_p1, 1) != nullptr &&
          pde_document_revision(doc2) == 1,
          "deleting page 1 succeeds because all surviving links/bookmarks target surviving pages");

  // Verify that on the remaining 2 pages (old p0 and old p2):
  // Old p0 (now index 0) has a link pointing to old p2 (now index 1, id c_p2_id)!
  const std::string p0_annots = RequireResult(pde_describe_annotations(doc2, 0), "p0 annots after del");
  Require(p0_annots.find("\"targetPageId\":\"" + c_p2_id + "\"") != std::string::npos,
          "numeric link destination on page 0 migrated cleanly to target page 2");

  // Verify bookmarks: Book 0 points to c_p0_id, Book 2 points to c_p2_id!
  const std::string outline = RequireResult(pde_describe_outline(doc2), "outline after del");
  Require(outline.find("\"title\":\"Book 0\",\"pageId\":\"" + c_p0_id + "\"") != std::string::npos &&
          outline.find("\"title\":\"Book 2\",\"pageId\":\"" + c_p2_id + "\"") != std::string::npos,
          "numeric bookmark destination migrated cleanly and resolves to target page 2");

  // Save and reopen
  Require(pde_save_memory(doc2) != nullptr, "save after clean page deletion");
  const std::vector<uint8_t> saved_del(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened_del = pde_open_memory(
      saved_del.data(), static_cast<uint32_t>(saved_del.size()),
      "reopened-del-doc", "saved-del-source", nullptr);
  Require(reopened_del != 0, "reopen PDF after page deletion");

  const std::string r_p1_desc = RequireResult(pde_describe_page(reopened_del, 1), "r_p1");
  const std::string r_p1_id = PageIdFromDescription(r_p1_desc);

  const std::string reopened_annots = RequireResult(pde_describe_annotations(reopened_del, 0), "reopened annots");
  Require(reopened_annots.find("\"targetPageId\":\"" + r_p1_id + "\"") != std::string::npos,
          "migrated link target persists through save and reopen");
  const std::string reopened_outline = RequireResult(pde_describe_outline(reopened_del), "reopened outline");
  Require(reopened_outline.find("\"title\":\"Book 2\",\"pageId\":\"" + r_p1_id + "\"") != std::string::npos,
          "migrated bookmark target persists through save and reopen");

  Require(pde_close(reopened_del) == 1 && pde_close(doc2) == 1,
          "close clean deletion fixtures");
}

void TestP1bTransactions() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("0 0 5 5 re f"),
  });
  const std::string resource_pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 80 60] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("10 10 30 20 re f"),
  });
  const uint32_t document = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "doc-p1b", "source-p1b", nullptr);
  Require(document != 0, "open P1b transaction PDF");
  const std::string initial_page = pde_describe_page(document, 0);
  const std::string source_page_id = PageIdFromDescription(initial_page);
  const std::string source_path_id = FirstObjectId(initial_page);

  const uint8_t red_rgba[] = {
      255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
  };
  const uint8_t blue_rgba[] = {
      0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255,
  };
  Require(pde_register_rgba_image(document, "red", 2, 2, red_rgba,
                                  sizeof(red_rgba)) == 1,
          "register red replacement resource");
  Require(pde_register_rgba_image(document, "blue", 2, 2, blue_rgba,
                                  sizeof(blue_rgba)) == 1,
          "register blue replacement resource");
  Require(pde_register_pdf_resource(
              document, "import-pages",
              reinterpret_cast<const uint8_t*>(resource_pdf.data()),
              static_cast<uint32_t>(resource_pdf.size())) != nullptr,
          "register page import resource");

  PdeEditCommand insert{};
  insert.type = 10;
  insert.page_id = source_page_id.c_str();
  insert.target_id = "image-source";
  insert.resource_id = "red";
  insert.values[0] = 10;
  insert.values[1] = 10;
  insert.values[2] = 20;
  insert.values[3] = 20;
  Require(pde_apply_commands(document, 0, "p1b-insert", &insert, 1) != nullptr,
          "insert source image for copy isolation");

  const char* copy_pairs[] = {source_path_id.c_str(), "path-copy",
                              "image-source", "image-copy"};
  PdeEditCommand copy_and_replace[2]{};
  copy_and_replace[0].type = 16;
  copy_and_replace[0].page_id = source_page_id.c_str();
  copy_and_replace[0].ids = copy_pairs;
  copy_and_replace[0].id_count = 4;
  copy_and_replace[0].values[0] = 40;
  copy_and_replace[1].type = 14;
  copy_and_replace[1].page_id = source_page_id.c_str();
  copy_and_replace[1].target_id = "image-copy";
  copy_and_replace[1].resource_id = "blue";
  Require(pde_apply_commands(document, 1, "p1b-copy-replace", copy_and_replace,
                             2) != nullptr,
          "copy top-level path/image and isolate replacement");
  const std::string copied_page = pde_describe_page(document, 0);
  Require(copied_page.find("\"id\":\"image-source\"") != std::string::npos &&
              copied_page.find("\"id\":\"image-copy\"") != std::string::npos &&
              copied_page.find("\"id\":\"path-copy\"") != std::string::npos,
          "copied objects retain stable explicit IDs");
  const std::vector<uint8_t> replaced_pixels =
      RenderPixels(document, 0, 100, 100);
  const auto source_pixel = PixelAt(replaced_pixels, 100, 15, 15);
  const auto copied_pixel = PixelAt(replaced_pixels, 100, 55, 15);
  Require(source_pixel[0] > 240 && source_pixel[1] < 15 && source_pixel[2] < 15,
          "replacing copied image leaves shared source image red");
  Require(copied_pixel[0] < 15 && copied_pixel[1] < 15 && copied_pixel[2] > 240,
          "copied image replacement is independently blue");

  PdeEditCommand crop{};
  crop.type = 15;
  crop.page_id = source_page_id.c_str();
  crop.target_id = "image-copy";
  crop.values[0] = 50;
  crop.values[1] = 10;
  crop.values[2] = 10;
  crop.values[3] = 20;
  Require(pde_apply_commands(document, 2, "p1b-crop", &crop, 1) != nullptr,
          "crop image with an object clipping path");
  const std::vector<uint8_t> cropped_pixels =
      RenderPixels(document, 0, 100, 100);
  const auto clipped_pixel = PixelAt(cropped_pixels, 100, 65, 15);
  Require(clipped_pixel[0] > 240 && clipped_pixel[1] > 240 &&
              clipped_pixel[2] > 240,
          "crop hides pixels without changing source bitmap");
  Require(pde_undo(document) != nullptr, "undo image crop");
  Require(RenderPixels(document, 0, 100, 100) == replaced_pixels,
          "crop undo restores exact rendered image state");
  Require(pde_redo(document) != nullptr, "redo image crop");
  Require(RenderPixels(document, 0, 100, 100) == cropped_pixels,
          "crop redo restores clipping path");

  const std::string source_before_pages = pde_describe_page(document, 0);
  const char* duplicate_pairs[] = {source_page_id.c_str(), "page-duplicate"};
  PdeEditCommand duplicate{};
  duplicate.type = 12;
  duplicate.target_id = source_page_id.c_str();
  duplicate.ids = duplicate_pairs;
  duplicate.id_count = 2;
  Require(pde_apply_commands(document, 5, "p1b-duplicate", &duplicate, 1) !=
              nullptr,
          "duplicate native PDF page without rasterization");
  Require(std::string(pde_describe_page(document, 0)) == source_before_pages,
          "page duplication leaves source page unchanged");
  const std::string duplicated_page = pde_describe_page(document, 1);
  Require(PageIdFromDescription(duplicated_page) == "page-duplicate" &&
              duplicated_page.find("\"type\":\"image\"") != std::string::npos &&
              duplicated_page.find("\"type\":\"path\"") != std::string::npos,
          "duplicated page keeps vector objects with stable generated IDs");

  const char* import_pairs[] = {"0", "page-imported"};
  PdeEditCommand import{};
  import.type = 13;
  import.target_id = "page-duplicate";
  import.resource_id = "import-pages";
  import.ids = import_pairs;
  import.id_count = 2;
  Require(pde_apply_commands(document, 6, "p1b-import", &import, 1) != nullptr,
          "import a direct PDF page resource");
  Require(std::string(pde_describe_page(document, 0)) == source_before_pages,
          "page import leaves the original source page unchanged");
  const std::string imported_page = pde_describe_page(document, 2);
  Require(PageIdFromDescription(imported_page) == "page-imported" &&
              imported_page.find("\"type\":\"path\"") != std::string::npos,
          "imported PDF page remains vector content");
  Require(pde_register_pdf_resource(
              document, "import-pages",
              reinterpret_cast<const uint8_t*>(resource_pdf.data()),
              static_cast<uint32_t>(resource_pdf.size())) != nullptr,
          "page import leaves immutable PDF resource bytes unchanged");

  const char* failed_duplicate_pairs[] = {source_page_id.c_str(),
                                          "page-rolled-back"};
  PdeEditCommand failed[2]{};
  failed[0].type = 12;
  failed[0].target_id = "page-imported";
  failed[0].ids = failed_duplicate_pairs;
  failed[0].id_count = 2;
  failed[1].type = 14;
  failed[1].page_id = source_page_id.c_str();
  failed[1].target_id = "image-source";
  failed[1].resource_id = "missing-image";
  Require(
      pde_apply_commands(document, 7, "p1b-failed-mixed", failed, 2) == nullptr,
      "mixed P1b candidate failure is rejected");
  Require(
      std::string(pde_document_info(document)).find("\"revision\":7") !=
              std::string::npos &&
          std::string(pde_document_info(document)).find("page-rolled-back") ==
              std::string::npos,
      "failed P1b batch rolls back page and object changes");

  Require(pde_save_memory(document) != nullptr,
          "save duplicated/imported/cropped P1b document");
  const std::vector<uint8_t> saved_pdf(pde_binary_data(),
                                       pde_binary_data() + pde_binary_size());
  const uint32_t reopened =
      pde_open_memory(saved_pdf.data(), static_cast<uint32_t>(saved_pdf.size()),
                      "doc-p1b-reopen", "source-p1b-reopen", nullptr);
  Require(reopened != 0, "reopen P1b edited PDF");
  Require(std::string(pde_document_info(reopened)).find("\"pageOrder\":[") !=
                  std::string::npos &&
              std::string(pde_describe_page(reopened, 0))
                      .find("\"type\":\"image\"") != std::string::npos &&
              std::string(pde_describe_page(reopened, 1))
                      .find("\"type\":\"image\"") != std::string::npos &&
              std::string(pde_describe_page(reopened, 2))
                      .find("\"type\":\"path\"") != std::string::npos,
          "P1b page/object edits survive save and reopen");
  Require(RenderPixels(reopened, 0, 100, 100) == cropped_pixels,
          "image replacement and crop survive save and reopen");
  Require(pde_close(reopened) == 1, "close reopened P1b PDF");
  Require(pde_close(document) == 1, "close P1b transaction PDF");
}

void TestTextTransactions() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      Stream("BT /F1 20 Tf 30 200 Td /Span << /ActualText (FIRST) >> "
             "BDC (FIRST) Tj EMC ET "
             "BT /F1 20 Tf 30 150 Td (SECOND) Tj ET"),
  });
  const uint32_t document = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "doc-edit", "source-edit", nullptr);
  Require(document != 0, "open editable PDF");
  Require(pde_text_edit_stride() == sizeof(PdeTextEdit), "native edit stride");

  const char* page_pointer = pde_describe_page(document, 0);
  Require(page_pointer != nullptr, "describe editable page");
  const std::vector<std::string> ids = TextBlockIds(page_pointer);
  Require(ids.size() == 2, "two editable text blocks");

  PdeTextEdit failed_edits[] = {
      {0, ids[0].c_str(), 0, 5, "CHANGED", nullptr},
      {0, ids[1].c_str(), 0, 999, "BROKEN", nullptr},
  };
  Require(pde_apply_text(document, 0, "tx-failed", failed_edits, 2) == nullptr,
          "failed batch is rejected");
  const char* after_failure = pde_extract_page(document, 0);
  Require(after_failure != nullptr &&
              std::string(after_failure).find("FIRST") != std::string::npos &&
              std::string(after_failure).find("CHANGED") == std::string::npos,
          "failed batch leaves committed text unchanged");
  Require(std::string(pde_document_info(document)).find("\"revision\":0") !=
              std::string::npos,
          "failed batch leaves revision unchanged");

  PdeTextEdit edit{0, ids[0].c_str(), 0, 5, "CHANGED", nullptr};
  const char* preview = pde_preview_text(document, &edit);
  Require(preview != nullptr &&
              std::string(preview).find("\"lines\":[{") != std::string::npos,
          "real text layout preview");
  Require(std::string(pde_extract_page(document, 0)).find("FIRST") !=
              std::string::npos,
          "preview does not change committed text");

  const char* applied = pde_apply_text(document, 0, "tx-change", &edit, 1);
  Require(
      applied != nullptr &&
          std::string(applied).find("\"revision\":1") != std::string::npos &&
          std::string(applied).find("\"canUndo\":true") != std::string::npos,
      "commit original text replacement");
  Require(std::string(pde_extract_page(document, 0)).find("CHANGED") !=
              std::string::npos,
          "ActualText and visible text changed together");

  const char* undone = pde_undo(document);
  Require(undone != nullptr &&
              std::string(undone).find("\"revision\":2") != std::string::npos &&
              std::string(undone).find("\"canRedo\":true") != std::string::npos,
          "undo rebuilds original source");
  Require(std::string(pde_extract_page(document, 0)).find("FIRST") !=
              std::string::npos,
          "undo restores original text");

  const char* redone = pde_redo(document);
  Require(redone != nullptr &&
              std::string(redone).find("\"revision\":3") != std::string::npos,
          "redo replays committed transaction");
  Require(std::string(pde_extract_page(document, 0)).find("CHANGED") !=
              std::string::npos,
          "redo restores replacement text");

  const char* saved = pde_save_memory(document);
  Require(saved != nullptr && std::string(saved).find("\"savedRevision\":3") !=
                                  std::string::npos,
          "edited save reports exported revision");
  const std::vector<uint8_t> saved_pdf(pde_binary_data(),
                                       pde_binary_data() + pde_binary_size());
  Require(
      std::string(pde_document_info(document))
              .find("\"revision\":3,\"savedRevision\":0") != std::string::npos,
      "edited export does not confirm saved revision");
  Require(pde_confirm_save(document, 3) != nullptr &&
              std::string(pde_document_info(document))
                      .find("\"revision\":3,\"savedRevision\":3") !=
                  std::string::npos,
          "edited save confirmation advances savedRevision");
  const uint32_t reopened =
      pde_open_memory(saved_pdf.data(), static_cast<uint32_t>(saved_pdf.size()),
                      "doc-edit-reopen", "source-edit-reopen", nullptr);
  Require(reopened != 0 &&
              std::string(pde_extract_page(reopened, 0)).find("CHANGED") !=
                  std::string::npos,
          "serialized edit survives reopen");
  Require(pde_close(reopened) == 1, "close reopened edit");

  Require(pde_undo(document) != nullptr, "undo before branch");
  PdeTextEdit branch{0, ids[0].c_str(), 0, 5, "BRANCH", nullptr};
  const char* branched = pde_apply_text(document, 4, "tx-branch", &branch, 1);
  Require(
      branched != nullptr &&
          std::string(branched).find("\"revision\":5") != std::string::npos &&
          std::string(branched).find("\"canRedo\":false") != std::string::npos,
      "new branch clears redo");
  Require(pde_redo(document) == nullptr, "cleared redo is unavailable");
  Require(std::string(pde_extract_page(document, 0)).find("BRANCH") !=
              std::string::npos,
          "failed redo leaves branch committed");
  Require(pde_close(document) == 1, "close editable PDF");
}

std::vector<uint8_t> ReadTestFile(const std::string& path) {
  FILE* file = std::fopen(path.c_str(), "rb");
  Require(file != nullptr, "open font test file");
  Require(std::fseek(file, 0, SEEK_END) == 0, "seek font test file");
  const long size = std::ftell(file);
  Require(size > 0 && static_cast<unsigned long>(size) <=
                          std::numeric_limits<uint32_t>::max(),
          "font test file size");
  Require(std::fseek(file, 0, SEEK_SET) == 0, "rewind font test file");
  std::vector<uint8_t> bytes(static_cast<size_t>(size));
  Require(std::fread(bytes.data(), 1, bytes.size(), file) == bytes.size(),
          "read font test file");
  Require(std::fclose(file) == 0, "close font test file");
  return bytes;
}

struct FontTestOptions {
  std::string ttf_path;
  std::string otf_path;
  std::string ttc_path;
  std::string restricted_pdf_path;
  uint32_t ttc_face = 1;

  bool enabled() const {
    return !ttf_path.empty() || !otf_path.empty() || !ttc_path.empty();
  }
};

FontTestOptions ParseFontTestOptions(int argc, char** argv) {
  FontTestOptions options;
  for (int index = 1; index < argc; ++index) {
    const std::string_view flag(argv[index]);
    Require(index + 1 < argc, "font test option value");
    const std::string value(argv[++index]);
    if (flag == "--font-ttf") {
      options.ttf_path = value;
    } else if (flag == "--font-otf") {
      options.otf_path = value;
    } else if (flag == "--font-ttc") {
      options.ttc_path = value;
    } else if (flag == "--restricted-pdf") {
      options.restricted_pdf_path = value;
    } else if (flag == "--ttc-face") {
      char* end = nullptr;
      const unsigned long parsed = std::strtoul(value.c_str(), &end, 10);
      Require(end && *end == '\0' && parsed > 0 &&
                  parsed <= std::numeric_limits<uint32_t>::max(),
              "non-first TTC face index");
      options.ttc_face = static_cast<uint32_t>(parsed);
    } else {
      Require(false, "known font test option");
    }
  }
  if (options.enabled()) {
    Require(!options.ttf_path.empty() && !options.otf_path.empty() &&
                !options.ttc_path.empty(),
            "TTF, OTF, and TTC font test paths");
  }
  return options;
}

void TestRestrictedPrintPermission(const std::string& path) {
  const auto bytes = ReadTestFile(path);
  const uint32_t document = pde_open_memory(
      bytes.data(), static_cast<uint32_t>(bytes.size()),
      "restricted-print", "restricted-print-source", "fixture-user");
  Require(document != 0, "open restricted encrypted PDF with its test user password");
  const std::string info = RequireResult(pde_document_info(document),
                                         "describe restricted encrypted PDF");
  Require(info.find("\"print\":false") != std::string::npos &&
          info.find("\"encrypted\":true") != std::string::npos,
          "encrypted PDF with printing disabled exposes print:false");
  Require(pde_close(document) == 1, "close restricted printing fixture");
}

void TestNestedTextFont(const std::string& font_path) {
  const auto font = ReadTestFile(font_path);
  Require(pde_register_font("nested-style-font", font.data(),
                            static_cast<uint32_t>(font.size()), 0) != nullptr,
          "register nested style font");
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Outer 6 0 R /Inner 7 0 R >> "
      "/Font << /F1 8 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Outer 6 0 R /Inner 7 0 R >> "
      "/Font << /F1 8 0 R >> >> /Contents 5 0 R >>",
      Stream("/Outer Do"),
      Stream("/Inner Do", "/Type /XObject /Subtype /Form /BBox [0 0 300 300]"),
      Stream("BT /F1 20 Tf 30 200 Td (ORIGINAL) Tj ET",
             "/Type /XObject /Subtype /Form /BBox [0 0 300 300]"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "nested-font", "inherited-resource-font", nullptr);
  Require(doc != 0, "open nested inherited font Form");
  const std::string initial = RequireResult(pde_describe_page(doc, 0),
                                              "describe original nested font");
  const auto ids = TextBlockIds(initial);
  Require(ids.size() == 1, "resolve nested inherited font text");
  const auto other_page = RenderPixels(doc, 1, 300, 300);
  const std::string page_id = PageIdFromDescription(initial);
  const char* selected[]{ids[0].c_str()};
  PdeEditCommand style{};
  style.type = 2;
  style.page_id = page_id.c_str();
  style.font_id = "nested-style-font";
  style.ids = selected;
  style.id_count = 1;
  style.flags = 1 | 2;
  style.values[0] = 18;
  Require(pde_apply_commands(doc, 0, "nested-font-change", &style, 1) != nullptr,
          "replace font inside one isolated inherited resource Form");
  const auto styled_pixels = RenderPixels(doc, 0, 300, 300);
  Require(pde_save_memory(doc) != nullptr, "save nested embedded font");
  const std::vector<uint8_t> saved(pde_binary_data(),
                                    pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()), "nested-font-reopened",
      "saved-inherited-font", nullptr);
  Require(reopened != 0 &&
              RequireResult(pde_extract_page(reopened, 0), "extract saved nested font")
                      .find("ORIGINAL") != std::string::npos &&
              RequireResult(pde_describe_page(reopened, 0), "describe saved nested font")
                      .find("\"fontSize\":18") != std::string::npos &&
              RenderPixels(reopened, 0, 300, 300) == styled_pixels &&
              RenderPixels(reopened, 1, 300, 300) == other_page,
          "new font resource retains pixels after save without mutating sibling page");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close nested font fixtures");
}

std::vector<uint8_t> ExerciseRegisteredFont(const std::string& suffix,
                                            const std::string& font_id,
                                            const std::string& text,
                                            bool open_type_cff) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 200] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("0 0 1 1 re f"),
  });
  const std::string document_id = "font-doc-" + suffix;
  const std::string source_id = "font-source-" + suffix;
  const uint32_t document =
      pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
                      static_cast<uint32_t>(pdf.size()), document_id.c_str(),
                      source_id.c_str(), nullptr);
  Require(document != 0, "open font insertion PDF");
  const std::string page =
      RequireResult(pde_describe_page(document, 0), "describe font test page");
  const std::string page_id = PageIdFromDescription(page);

  const std::string object_id = "font-object-" + suffix;
  PdeEditCommand insert{};
  insert.type = 3;
  insert.page_id = page_id.c_str();
  insert.target_id = object_id.c_str();
  insert.text_utf8 = text.c_str();
  insert.font_id = font_id.c_str();
  insert.flags = 3;
  insert.values[0] = 20;
  insert.values[1] = 40;
  insert.values[2] = 560;
  insert.values[3] = 100;
  insert.values[4] = 24;
  const std::string transaction_id = "font-insert-" + suffix;
  Require(pde_apply_commands(document, 0, transaction_id.c_str(), &insert, 1) !=
              nullptr,
          "insert text with registered font");
  Require(std::string(pde_extract_page(document, 0)).find(text) !=
              std::string::npos,
          "extract newly inserted font text");

  Require(pde_undo(document) != nullptr, "undo registered font insertion");
  Require(std::string(pde_extract_page(document, 0)).find(text) ==
              std::string::npos,
          "font insertion undo removes text");
  Require(pde_redo(document) != nullptr, "redo registered font insertion");
  Require(std::string(pde_extract_page(document, 0)).find(text) !=
              std::string::npos,
          "font insertion redo restores text");

  Require(pde_save_memory(document) != nullptr,
          "save document with registered font");
  const std::vector<uint8_t> saved(pde_binary_data(),
                                   pde_binary_data() + pde_binary_size());
  const std::string_view saved_text(reinterpret_cast<const char*>(saved.data()),
                                    saved.size());
  Require(saved_text.find("ToUnicode") != std::string_view::npos,
          "saved registered font has ToUnicode");
  if (open_type_cff) {
    Require(
        saved_text.find("FontFile3") != std::string_view::npos &&
            saved_text.find("CIDFontType0") != std::string_view::npos &&
            saved_text.find("OpenType") != std::string_view::npos &&
            saved_text.find("FontFile2") == std::string_view::npos,
        "saved CFF font uses FontFile3 OpenType CIDFontType0");
  } else {
    Require(saved_text.find("FontFile2") != std::string_view::npos &&
                saved_text.find("CIDFontType2") != std::string_view::npos,
            "saved TrueType font uses FontFile2 CIDFontType2");
  }

  const std::string reopen_id = document_id + "-reopen";
  const std::string reopen_source = source_id + "-reopen";
  const uint32_t reopened =
      pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
                      reopen_id.c_str(), reopen_source.c_str(), nullptr);
  Require(
      reopened != 0 && std::string(pde_extract_page(reopened, 0)).find(text) !=
                           std::string::npos,
      "registered font text survives save and reopen");
  Require(pde_close(reopened) == 1, "close reopened font PDF");
  const std::string original_description = pde_describe_page(document, 0);
  Require(pde_export_recovery(document) != nullptr, "snapshot registered font resources");
  const std::vector<uint8_t> recovery(pde_binary_data(), pde_binary_data() + pde_binary_size());
  Require(pde_close(document) == 1, "close font insertion PDF");
  const uint32_t restored = pde_restore_recovery(recovery.data(), static_cast<uint32_t>(recovery.size()), nullptr);
  Require(restored != 0 && original_description == pde_describe_page(restored, 0),
          "restored font bytes, face and inserted text remain exact");
  Require(pde_save_memory(restored) != nullptr, "save recovered embedded font");
  Require(pde_close(restored) == 1, "close recovered font PDF");
  return saved;
}

void TestDocumentTools(const std::string& font_id,
                       const std::string& page_attributes = "/MediaBox [0 0 400 300]") {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R " + page_attributes + " /Resources << >> /Contents 4 0 R >>",
      Stream(""),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "document-tools", "tools-source", nullptr);
  Require(doc != 0, "open document tools fixture");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const std::string name_value = "\xE4\xB8\xAD\xE6\x96\x87 ABC";
  PdeEditCommand commands[8]{};
  auto& create = commands[0];
  create.type = 19; create.page_id = page_id.c_str(); create.target_id = "field-name";
  create.resource_id = "text"; create.text_utf8 = "Full name";
  create.font_id = font_id.c_str(); create.flags = 1;
  create.values[0] = 20; create.values[1] = 20; create.values[2] = 220;
  create.values[3] = 40; create.values[4] = 16;
  commands[1].type = 18; commands[1].target_id = "field-name";
  commands[1].text_utf8 = name_value.c_str();
  commands[2] = create; commands[2].target_id = "field-check";
  commands[2].resource_id = "checkbox"; commands[2].text_utf8 = "Accept";
  commands[2].font_id = nullptr; commands[2].flags = 0;
  commands[2].values[1] = 80; commands[2].values[2] = 20; commands[2].values[3] = 20;
  commands[3].type = 18; commands[3].target_id = "field-check";
  commands[3].flags = 1; commands[3].values[0] = 1;
  for (size_t index = 4; index < 8; ++index) {
    commands[index].type = 17; commands[index].page_id = page_id.c_str();
    commands[index].values[0] = 20; commands[index].values[1] = 120 + (index - 4) * 35;
    commands[index].values[2] = 150; commands[index].values[3] = 25;
    commands[index].text_utf8 = "Local annotation";
  }
  commands[4].target_id = "note-one"; commands[4].resource_id = "text";
  commands[5].target_id = "highlight-one"; commands[5].resource_id = "highlight";
  commands[6].target_id = "rectangle-one"; commands[6].resource_id = "rectangle";
  commands[7].target_id = "ink-one"; commands[7].resource_id = "ink";
  const char* points[] = {"20", "225", "100", "240", "160", "225"};
  commands[7].ids = points; commands[7].id_count = 6;
  commands[7].flags = 4; commands[7].values[8] = 2;
  Require(pde_preview_commands(doc, 0, commands, 8) != nullptr, "preview actual annotations and AcroForm");
  Require(std::string(pde_describe_forms(doc)) == "[]", "form preview remains uncommitted");
  Require(pde_apply_commands(doc, 0, "tools-create-fill", commands, 8) != nullptr,
          "create and fill fields with annotations atomically");
  const std::string fields = RequireResult(pde_describe_forms(doc), "describe actual form fields");
  Require(Count(fields, "\"widgets\"") == 2 && fields.find(name_value) != std::string::npos &&
          fields.find("\"value\":true") != std::string::npos, "read field values and widget positions");
  const std::string annotations = RequireResult(pde_describe_annotations(doc, 0), "describe actual annotations");
  Require(Count(annotations, "\"subtype\"") == 4, "all four annotation subtypes are present");
  const auto rendered = RenderPixels(doc, 0, 400, 300);
  size_t text_ink = 0;
  for (uint32_t y = 23; y < 57; ++y) for (uint32_t x = 23; x < 237; ++x) {
    const auto pixel = PixelAt(rendered, 400, x, y);
    if (pixel[0] < 180 && pixel[1] < 180 && pixel[2] < 180) ++text_ink;
  }
  Require(text_ink > 20, "filled CJK widget appearance is actually rendered");
  Require(pde_save_memory(doc) != nullptr, "save annotations and fields");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "tools-reopened", "tools-saved", nullptr);
  Require(reopened != 0, "reopen saved document tools");
  Require(std::string(pde_describe_forms(reopened)).find(name_value) != std::string::npos,
          "saved form values remain Unicode");
  Require(RenderPixels(reopened, 0, 400, 300) == rendered, "field and annotation appearances survive reopen");
  Require(pde_close(reopened) == 1, "close document tools reopen");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_forms(doc)) == "[]" &&
          std::string(pde_describe_annotations(doc, 0)) == "[]", "one undo removes the entire document tools transaction");
  Require(pde_redo(doc) != nullptr && std::string(pde_describe_forms(doc)) == fields,
          "redo restores field identity and values");
  PdeEditCommand bad[2]{commands[4], commands[1]};
  bad[0].target_id = "rolled-back-note"; bad[1].target_id = "missing-field";
  Require(pde_apply_commands(doc, 3, "bad-tools", bad, 2) == nullptr,
          "missing field rejects the whole mixed annotation transaction");
  Require(std::string(pde_describe_annotations(doc, 0)) == annotations,
          "failed field write leaves no extra annotation");

  PdeEditCommand update = commands[4];
  update.type = 22; update.text_utf8 = "Updated note";
  update.flags = 1 | 2;
  update.values[4] = 0; update.values[5] = 0; update.values[6] = 1;
  update.values[7] = 0.8;
  Require(pde_preview_commands(doc, 3, &update, 1) != nullptr &&
          std::string(pde_describe_annotations(doc, 0)) == annotations,
          "annotation update preview does not modify existing appearance");
  Require(pde_apply_commands(doc, 3, "note-update", &update, 1) != nullptr,
          "update an existing annotation with stable ID and rebuilt appearance");
  const std::string updated = RequireResult(pde_describe_annotations(doc, 0), "describe updated note");
  Require(updated.find("Updated note") != std::string::npos &&
          updated.find("\"id\":\"note-one\"") != std::string::npos &&
          RenderPixels(doc, 0, 400, 300) != rendered,
          "updated annotation appearance and text are rendered");
  Require(pde_save_memory(doc) != nullptr, "save updated annotation");
  const std::vector<uint8_t> updated_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened_update = pde_open_memory(updated_bytes.data(),
      static_cast<uint32_t>(updated_bytes.size()), "tools-update-reopened", "tools-update-saved", nullptr);
  Require(reopened_update != 0 &&
          std::string(pde_describe_annotations(reopened_update, 0)).find("Updated note") != std::string::npos &&
          RenderPixels(reopened_update, 0, 400, 300) == RenderPixels(doc, 0, 400, 300),
          "annotation update survives save and reopen with the same appearance");
  Require(pde_close(reopened_update) == 1, "close updated note fixture");
  PdeEditCommand remove{};
  remove.type = 23; remove.page_id = page_id.c_str(); remove.target_id = "note-one";
  Require(pde_apply_commands(doc, 4, "note-delete", &remove, 1) != nullptr &&
          Count(RequireResult(pde_describe_annotations(doc, 0), "describe removed note"), "\"subtype\"") == 3,
          "delete removes a real PDF annotation");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_annotations(doc, 0)) == updated,
          "undo restores updated annotation and stable identity");
  Require(pde_redo(doc) != nullptr &&
          std::string(pde_describe_annotations(doc, 0)).find("note-one") == std::string::npos,
          "redo removes only the selected annotation");
  Require(pde_close(doc) == 1, "close document tools fixture");
}

void TestRadioFields() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream(""),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "radio-doc", "radio-source", nullptr);
  Require(doc != 0, "open radio group fixture");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const char* options[] = {"\xE5\x8C\x97\xE4\xBA\xAC", "\xE4\xB8\x8A\xE6\xB5\xB7"};
  PdeEditCommand create{};
  create.type = 19; create.page_id = page_id.c_str(); create.target_id = "radio-city";
  create.resource_id = "radio"; create.text_utf8 = "Select city";
  create.ids = options; create.id_count = 2;
  create.values[0] = 20; create.values[1] = 30; create.values[2] = 160;
  create.values[3] = 32; create.values[4] = 12;
  const auto blank = RenderPixels(doc, 0, 300, 200);
  Require(pde_preview_commands(doc, 0, &create, 1) != nullptr &&
          std::string(pde_describe_forms(doc)) == "[]",
          "radio group preview leaves the PDF unchanged");
  Require(pde_apply_commands(doc, 0, "radio-create", &create, 1) != nullptr,
          "create real multi-widget radio group");
  const std::string initial = RequireResult(pde_describe_forms(doc), "describe radio group");
  Require(initial.find("\"id\":\"radio-city\"") != std::string::npos &&
          initial.find("\"type\":\"radio\"") != std::string::npos &&
          initial.find(options[0]) != std::string::npos &&
          initial.find(options[1]) != std::string::npos &&
          Count(initial, "\"pageId\"") == 2 &&
          RenderPixels(doc, 0, 300, 200) != blank,
          "radio options have independent real Widget appearances");
  PdeEditCommand fill{};
  fill.type = 18; fill.target_id = "radio-city"; fill.text_utf8 = options[1];
  Require(pde_apply_commands(doc, 1, "radio-select", &fill, 1) != nullptr,
          "form.fill selects one persistent radio option");
  const std::string selected = RequireResult(pde_describe_forms(doc), "describe selected radio");
  Require(selected.find(std::string("\"value\":\"") + options[1] + "\"") != std::string::npos &&
          pde_save_memory(doc) != nullptr,
          "radio selection updates PDF value and saves");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "radio-reopened", "radio-saved", nullptr);
  Require(reopened != 0 &&
          std::string(pde_describe_forms(reopened)).find(
              std::string("\"value\":\"") + options[1] + "\"") != std::string::npos &&
          RenderPixels(reopened, 0, 300, 200) == RenderPixels(doc, 0, 300, 200),
          "selected radio Widget persists after save and reopen");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_forms(doc)) == initial,
          "undo restores the unselected radio group");
  const std::string copy_page = PageIdFromDescription(pde_describe_page(reopened, 0));
  const auto original_pixels = RenderPixels(reopened, 0, 300, 200);
  const char* copy_pair[] = {copy_page.c_str(), "radio-page-copy"};
  PdeEditCommand duplicate{};
  duplicate.type = 12; duplicate.ids = copy_pair; duplicate.id_count = 2; duplicate.target_id = copy_page.c_str();
  Require(pde_apply_commands(reopened, 0, "duplicate-editable-radio", &duplicate, 1) != nullptr,
          "duplicate a real radio group with its widget appearances");
  const std::string copied_fields = RequireResult(pde_describe_forms(reopened), "copied radio groups");
  Require(Count(copied_fields, "\"type\":\"radio\"") == 2,
          "radio widgets stay under two independent parent fields");
  const size_t second_id = copied_fields.find("\"id\":\"", copied_fields.find("\"id\":\"") + 1);
  const std::string cloned_field = JsonStringAfter(copied_fields, "\"id\":\"", second_id);
  Require(cloned_field != "radio-city", "copied radio field has a distinct persistent identity");
  fill.target_id = cloned_field.c_str(); fill.text_utf8 = options[0];
  Require(pde_apply_commands(reopened, 1, "fill-radio-copy", &fill, 1) != nullptr &&
          RenderPixels(reopened, 0, 300, 200) == original_pixels,
          "filling the copied radio group does not change original widgets or values");
  const auto copied_pixels = RenderPixels(reopened, 1, 300, 200);
  Require(pde_save_memory(reopened) != nullptr, "save independently edited radio copy");
  const std::vector<uint8_t> radio_copy_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t copy_reopened = pde_open_memory(radio_copy_bytes.data(), static_cast<uint32_t>(radio_copy_bytes.size()),
      "radio-copy-reopened", "radio-copy-saved", nullptr);
  Require(copy_reopened != 0 && RenderPixels(copy_reopened, 0, 300, 200) == original_pixels &&
          RenderPixels(copy_reopened, 1, 300, 200) == copied_pixels && pde_close(copy_reopened) == 1,
          "independent radio parent/widget structures and appearances survive a second save");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close radio group fixture");
}

void TestChoiceFields(const std::string& font_id) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream(""),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "choice-doc", "choice-source", nullptr);
  Require(doc != 0, "open Choice field fixture");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const char* options[] = {"\xE4\xB8\xAD\xE6\x96\x87 A", "\xE4\xB8\xAD\xE6\x96\x87 B"};
  PdeEditCommand choices[2]{};
  for (size_t index = 0; index < 2; ++index) {
    auto& command = choices[index];
    command.type = 19; command.page_id = page_id.c_str();
    command.target_id = index == 0 ? "choice-combo" : "choice-list";
    command.resource_id = index == 0 ? "combo" : "list";
    command.text_utf8 = index == 0 ? "Dropdown" : "List";
    command.font_id = font_id.c_str(); command.flags = 1;
    command.ids = options; command.id_count = 2;
    command.values[0] = 20; command.values[1] = 20 + 80 * index;
    command.values[2] = 180; command.values[3] = 50; command.values[4] = 14;
  }
  const auto blank = RenderPixels(doc, 0, 400, 300);
  Require(pde_preview_commands(doc, 0, choices, 2) != nullptr &&
          std::string(pde_describe_forms(doc)) == "[]",
          "Choice preview does not mutate the active PDF");
  Require(pde_apply_commands(doc, 0, "create-choice-fields", choices, 2) != nullptr,
          "create real single-choice ComboBox and ListBox widgets");
  const std::string initial = RequireResult(pde_describe_forms(doc), "describe Choice fields");
  Require(Count(initial, "\"type\":\"choice\"") == 2 &&
          Count(initial, "\"widgets\"") == 2 &&
          Count(initial, options[0]) >= 2 && Count(initial, options[1]) >= 2 &&
          RenderPixels(doc, 0, 400, 300) != blank,
          "Unicode options and the initial selection have real widget appearances");
  Require(pde_save_memory(doc) != nullptr, "save Choice field PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "choice-reopen", "choice-saved", nullptr);
  const std::string reopened_fields = RequireResult(pde_describe_forms(reopened), "describe saved Choice fields");
  Require(reopened != 0 &&
          reopened_fields.find("\"id\":\"choice-combo\"") != std::string::npos &&
          reopened_fields.find("\"id\":\"choice-list\"") != std::string::npos &&
          Count(reopened_fields, "\"type\":\"choice\"") == 2 &&
          Count(reopened_fields, options[0]) >= 2,
          "Choice fields and persistent IDs survive save and reopen");
  PdeEditCommand fill{};
  fill.type = 18; fill.target_id = "choice-combo"; fill.text_utf8 = options[1];
  Require(pde_apply_commands(reopened, 0, "fill-combo-choice", &fill, 1) != nullptr,
          "existing form.fill selects a different ComboBox option");
  fill.target_id = "choice-list";
  Require(pde_apply_commands(reopened, 1, "fill-list-choice", &fill, 1) != nullptr,
          "existing form.fill selects a different ListBox option");
  const std::string filled = RequireResult(pde_describe_forms(reopened), "describe filled Choice fields");
  Require(Count(filled, std::string("\"value\":\"") + options[1] + "\"") == 2 &&
          pde_save_memory(reopened) != nullptr,
          "both Choice values update and save");
  const std::vector<uint8_t> filled_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t filled_reopen = pde_open_memory(filled_bytes.data(),
      static_cast<uint32_t>(filled_bytes.size()), "choice-filled", "choice-filled-source", nullptr);
  const std::string filled_again = RequireResult(pde_describe_forms(filled_reopen), "describe reopened selections");
  Require(filled_reopen != 0 &&
          Count(filled_again, std::string("\"value\":\"") + options[1] + "\"") == 2 &&
          Count(filled_again, "\"type\":\"choice\"") == 2,
          "filled Unicode Choice options persist in the PDF");
  Require(pde_close(filled_reopen) == 1 && pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close Choice field fixtures");
}

void TestFormFieldAttributes(const std::string& font_id) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R >>",
      Stream(""),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "form-attributes", "form-attributes-source", nullptr);
  Require(doc != 0, "open form attribute fixture");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const char* options[]{"First", "Second", "Third"};
  PdeEditCommand create[4]{};
  for (size_t index = 0; index < 4; ++index) {
    create[index].type = 19;
    create[index].page_id = page_id.c_str();
    create[index].target_id = index == 0 ? "attrs-text" : index == 1 ? "attrs-list" :
                              index == 2 ? "attrs-check" : "attrs-radio";
    create[index].text_utf8 = index == 0 ? "Text" : index == 1 ? "List" :
                              index == 2 ? "Check" : "Radio";
    create[index].resource_id = index == 0 ? "text" : index == 1 ? "list" :
                                index == 2 ? "checkbox" : "radio";
    create[index].values[0] = 20;
    create[index].values[1] = 20 + 65 * index;
    create[index].values[2] = 180;
    create[index].values[3] = 40;
    create[index].values[4] = 12;
  }
  create[0].font_id = font_id.c_str(); create[0].flags = 1 | 2 | 4;
  create[1].font_id = font_id.c_str(); create[1].flags = 1 | 4 | 8;
  create[1].ids = options; create[1].id_count = 3;
  create[2].flags = 2;
  create[3].flags = 4; create[3].ids = options; create[3].id_count = 3;
  Require(pde_preview_commands(doc, 0, create, 4) != nullptr &&
              std::string(pde_describe_forms(doc)) == "[]",
          "field attribute preview does not mutate active PDF");
  Require(pde_apply_commands(doc, 0, "create-field-attributes", create, 4) != nullptr,
          "create text, list, checkbox and radio with persistent field flags");
  const std::string initial = RequireResult(pde_describe_forms(doc), "describe field attributes");
  Require(Count(initial, "\"multiple\":true") == 1 &&
              Count(initial, "\"readOnly\":true") == 2 &&
              Count(initial, "\"required\":true") == 3 &&
              initial.find("\"value\":[\"First\"]") != std::string::npos,
          "created field flags and multi-select array are exposed from AcroForm");
  PdeEditCommand fill{};
  fill.type = 18; fill.target_id = "attrs-text"; fill.text_utf8 = "Editable";
  Require(pde_apply_commands(doc, 1, "readonly-reject", &fill, 1) == nullptr &&
              std::string(pde_describe_forms(doc)) == initial && pde_document_revision(doc) == 1,
          "read-only field rejects fill without changing committed PDF");
  PdeEditCommand update{};
  update.type = 28; update.target_id = "attrs-text";
  update.flags = 1 | 2; update.values[0] = 0; update.values[1] = 0;
  PdeEditCommand edit_text[]{update, fill};
  Require(pde_apply_commands(doc, 1, "enable-and-fill", edit_text, 2) != nullptr,
          "attribute update and fill share one atomic transaction");
  const std::string edited = RequireResult(pde_describe_forms(doc), "describe editable text");
  Require(edited.find("\"value\":\"Editable\"") != std::string::npos &&
              Count(edited, "\"readOnly\":true") == 1 &&
              Count(edited, "\"required\":true") == 2,
          "editing a field changes only requested flags and preserves values");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_forms(doc)) == initial &&
              pde_redo(doc) != nullptr && std::string(pde_describe_forms(doc)) == edited,
          "undo and redo restore field flags and text value together");
  uint32_t revision = pde_document_revision(doc);

  fill = {}; fill.type = 18; fill.target_id = "attrs-list";
  fill.flags = 2; fill.ids = options; fill.id_count = 2;
  Require(pde_apply_commands(doc, revision++, "select-two-options", &fill, 1) != nullptr,
          "fill created multi-select list with two export values");
  const std::string selected = RequireResult(pde_describe_forms(doc), "describe two selections");
  Require(selected.find("\"value\":[\"First\",\"Second\"]") != std::string::npos,
          "two selections are persisted as an ordered PDF array");
  update = {}; update.type = 28; update.target_id = "attrs-list";
  update.flags = 4; update.values[2] = 0;
  Require(pde_apply_commands(doc, revision, "reject-two-to-one", &update, 1) == nullptr &&
              std::string(pde_describe_forms(doc)) == selected && pde_document_revision(doc) == revision,
          "disabling multiple with two selections refuses the candidate");
  update.flags = 1 | 2; update.values[0] = 1; update.values[1] = 0;
  Require(pde_apply_commands(doc, revision++, "lock-multiselect", &update, 1) != nullptr,
          "update flags without discarding multi-select state");
  const std::string locked = RequireResult(pde_describe_forms(doc), "describe locked list");
  Require(locked.find("\"multiple\":true,\"value\":[\"First\",\"Second\"]") != std::string::npos &&
              Count(locked, "\"readOnly\":true") == 2,
          "list remains selected and its read-only flag is visible");
  Require(pde_apply_commands(doc, revision, "readonly-list-reject", &fill, 1) == nullptr &&
              std::string(pde_describe_forms(doc)) == locked,
          "updated read-only list rejects subsequent fill");
  update = {}; update.type = 28; update.target_id = "attrs-list";
  update.flags = 1; update.values[0] = 0;
  Require(pde_apply_commands(doc, revision++, "unlock-multiselect", &update, 1) != nullptr,
          "clear read-only without changing other field flags");
  fill.id_count = 1;
  Require(pde_apply_commands(doc, revision++, "select-one-option", &fill, 1) != nullptr,
          "reduce multi-select selection to one option");
  update.flags = 4; update.values[2] = 0;
  Require(pde_apply_commands(doc, revision++, "make-single-select", &update, 1) != nullptr,
          "switch list to single-select and normalize its value");
  const std::string single = RequireResult(pde_describe_forms(doc), "describe single-select list");
  Require(single.find("\"multiple\":false,\"value\":\"First\"") != std::string::npos,
          "single-select uses a scalar PDF value");
  update.values[2] = 1;
  Require(pde_apply_commands(doc, revision++, "restore-multiselect", &update, 1) != nullptr,
          "switch list back to multi-select and normalize its value");
  const std::string restored = RequireResult(pde_describe_forms(doc), "describe restored list");
  Require(restored.find("\"multiple\":true,\"value\":[\"First\"]") != std::string::npos,
          "re-enabled multi-select uses an array PDF value");
  const auto rendered = RenderPixels(doc, 0, 400, 300);
  Require(pde_save_memory(doc) != nullptr, "save field attributes and appearances");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "attributes-reopen", "attributes-saved", nullptr);
  Require(reopened != 0, "reopen field attributes after save");
  const std::string saved_forms = RequireResult(pde_describe_forms(reopened),
                                               "describe saved field attributes");
  Require(Count(saved_forms, "\"multiple\":true") == 1 &&
              Count(saved_forms, "\"required\":true") == 1 &&
              Count(saved_forms, "\"readOnly\":true") == 1 &&
              saved_forms.find("\"id\":\"attrs-list\"") != std::string::npos &&
              saved_forms.find("\"multiple\":true,\"value\":[\"First\"]") != std::string::npos &&
              saved_forms.find("\"value\":\"Editable\"") != std::string::npos,
          "field flags and selections survive save/reopen");
  Require(RenderPixels(reopened, 0, 400, 300) == rendered,
          "widget appearances survive save/reopen");
  Require(pde_close(reopened) == 1, "close reopened attributes fixture");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_forms(doc)) == single &&
              pde_redo(doc) != nullptr && std::string(pde_describe_forms(doc)) == restored,
          "multi-select conversion remains undoable and redoable");
  revision = pde_document_revision(doc);

  update = {}; update.type = 28; update.target_id = "attrs-check";
  update.flags = 2; update.values[1] = 1;
  PdeEditCommand invalid_fill{};
  invalid_fill.type = 18; invalid_fill.target_id = "missing-field";
  PdeEditCommand rejected[]{update, invalid_fill};
  Require(pde_apply_commands(doc, revision, "rollback-attributes", rejected, 2) == nullptr &&
              std::string(pde_describe_forms(doc)) == restored && pde_document_revision(doc) == revision,
          "failed second command rolls back the earlier attribute update");
  update.target_id = "attrs-text"; update.flags = 4; update.values[2] = 1;
  Require(pde_apply_commands(doc, revision, "reject-text-multiple", &update, 1) == nullptr &&
              std::string(pde_describe_forms(doc)) == restored,
          "multi-select is rejected for a non-list field");
  PdeEditCommand invalid_create = create[1];
  invalid_create.target_id = "invalid-combo"; invalid_create.resource_id = "combo";
  Require(pde_apply_commands(doc, revision, "reject-combo-multiple", &invalid_create, 1) == nullptr &&
              std::string(pde_describe_forms(doc)) == restored,
          "multi-select is rejected at creation for combo fields");
  fill = {}; fill.type = 18; fill.target_id = "attrs-list"; fill.flags = 2;
  Require(pde_apply_commands(doc, revision, "clear-multiselect", &fill, 1) != nullptr,
          "clear multi-select list to an empty value");
  const std::string empty = RequireResult(pde_describe_forms(doc), "describe empty multi-select");
  Require(empty.find("\"choiceKind\":\"list\"") != std::string::npos &&
              empty.find("\"multiple\":true,\"value\":[]") != std::string::npos,
          "empty list still advertises its list type and multiple flag");
  Require(pde_save_memory(doc) != nullptr, "save empty multi-select list");
  const std::vector<uint8_t> empty_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t empty_reopen = pde_open_memory(empty_bytes.data(),
      static_cast<uint32_t>(empty_bytes.size()), "empty-list-reopen", "empty-list-saved", nullptr);
  Require(empty_reopen != 0 &&
              std::string(pde_describe_forms(empty_reopen)).find(
                  "\"multiple\":true,\"value\":[]") != std::string::npos,
          "empty multi-select flag and value survive save/reopen");
  Require(pde_close(empty_reopen) == 1, "close empty list reopen fixture");
  revision = pde_document_revision(doc);

  // Test tooltip (/TU) and maxLen (/MaxLen) on text field "attrs-text":
  // 1. Initial state: "attrs-text" currently has value "Editable" (length 8).
  // 2. Setting maxLen = 5 conflicts with current value (length 8 > 5) -> MUST REJECT!
  update = {}; update.type = 28; update.target_id = "attrs-text";
  update.flags = 8; update.values[3] = 5;
  Require(pde_apply_commands(doc, revision, "reject-maxlen-conflict", &update, 1) == nullptr &&
              pde_document_revision(doc) == revision,
          "new maxLen smaller than current value length is rejected without truncating");

  // 3. Setting maxLen = 10 (>= 8) and setting tooltip = "User instructions" succeeds
  update.flags = 8 | 16; update.values[3] = 10; update.text_utf8 = "User instructions";
  Require(pde_apply_commands(doc, revision++, "set-maxlen-and-tooltip", &update, 1) != nullptr,
          "update sets tooltip and maxLen on text field");
  std::string with_props = RequireResult(pde_describe_forms(doc), "describe field with tooltip and maxLen");
  Require(with_props.find("\"tooltip\":\"User instructions\"") != std::string::npos &&
              with_props.find("\"maxLen\":10") != std::string::npos,
          "tooltip and maxLen are serialized in describe_forms");

  // 4. form.fill length gating: filling 14 chars (> 10) is rejected
  fill = {}; fill.type = 18; fill.target_id = "attrs-text"; fill.text_utf8 = "Too long text!";
  Require(pde_apply_commands(doc, revision, "reject-fill-exceeding-maxlen", &fill, 1) == nullptr &&
              pde_document_revision(doc) == revision,
          "form.fill rejects value exceeding maxLen");

  // 5. form.fill within limit: filling 9 chars (<= 10) succeeds
  fill.text_utf8 = "NineChars";
  Require(pde_apply_commands(doc, revision++, "fill-within-maxlen", &fill, 1) != nullptr,
          "form.fill succeeds when text length <= maxLen");
  std::string filled_props = RequireResult(pde_describe_forms(doc), "describe field filled within maxLen");
  Require(filled_props.find("\"value\":\"NineChars\"") != std::string::npos &&
              filled_props.find("\"tooltip\":\"User instructions\"") != std::string::npos &&
              filled_props.find("\"maxLen\":10") != std::string::npos,
          "fill preserves tooltip and maxLen");

  // 6. Preservation semantics: updating readOnly without tooltip/maxLen flags preserves them
  update = {}; update.type = 28; update.target_id = "attrs-text";
  update.flags = 1; update.values[0] = 1; // set readOnly
  Require(pde_apply_commands(doc, revision++, "preserve-props-update-readonly", &update, 1) != nullptr,
          "updating readOnly preserves tooltip and maxLen");
  std::string preserved_props = RequireResult(pde_describe_forms(doc), "describe preserved props");
  Require(preserved_props.find("\"readOnly\":true") != std::string::npos &&
              preserved_props.find("\"tooltip\":\"User instructions\"") != std::string::npos &&
              preserved_props.find("\"maxLen\":10") != std::string::npos,
          "omitted tooltip and maxLen remain preserved");

  // 7. Clear semantics: clear tooltip (flags |= 16, text_utf8 = "") and clear maxLen (flags |= 8, values[3] = 0)
  update = {}; update.type = 28; update.target_id = "attrs-text";
  update.flags = 8 | 16; update.values[3] = 0; update.text_utf8 = "";
  Require(pde_apply_commands(doc, revision++, "clear-tooltip-and-maxlen", &update, 1) != nullptr,
          "clearing tooltip and maxLen succeeds");
  std::string cleared_props = RequireResult(pde_describe_forms(doc), "describe cleared props");
  Require(cleared_props.find("\"tooltip\"") == std::string::npos &&
              cleared_props.find("\"maxLen\"") == std::string::npos,
          "cleared tooltip and maxLen are absent from describe_forms");

  // 8. Undo/redo restores tooltip and maxLen
  Require(pde_undo(doc) != nullptr, "undo clear tooltip and maxLen");
  std::string undone_props = RequireResult(pde_describe_forms(doc), "describe undone props");
  Require(undone_props.find("\"tooltip\":\"User instructions\"") != std::string::npos &&
              undone_props.find("\"maxLen\":10") != std::string::npos,
          "undo restores previous tooltip and maxLen");

  Require(pde_redo(doc) != nullptr, "redo clear tooltip and maxLen");
  std::string redone_props = RequireResult(pde_describe_forms(doc), "describe redone props");
  Require(redone_props.find("\"tooltip\"") == std::string::npos &&
              redone_props.find("\"maxLen\"") == std::string::npos,
          "redo re-clears tooltip and maxLen");

  // Undo back to state where tooltip and maxLen are set, save and reopen to test roundtrip
  Require(pde_undo(doc) != nullptr, "undo again to state with props");
  const auto rendered_with_props = RenderPixels(doc, 0, 400, 300);
  Require(pde_save_memory(doc) != nullptr, "save document with tooltip and maxLen");
  const std::vector<uint8_t> props_saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t props_reopen = pde_open_memory(props_saved.data(), static_cast<uint32_t>(props_saved.size()),
      "props-reopen", "props-saved", nullptr);
  Require(props_reopen != 0, "reopen document with tooltip and maxLen");
  const std::string reopened_forms = RequireResult(pde_describe_forms(props_reopen), "describe reopened forms");
  Require(reopened_forms.find("\"tooltip\":\"User instructions\"") != std::string::npos &&
              reopened_forms.find("\"maxLen\":10") != std::string::npos,
          "tooltip and maxLen survive save and reopen");
  Require(RenderPixels(props_reopen, 0, 400, 300) == rendered_with_props,
          "pixel appearance survives save and reopen with tooltip and maxLen");
  Require(pde_close(props_reopen) == 1, "close reopened props fixture");

  Require(pde_close(doc) == 1, "close form attribute fixtures");
}

void TestExtractPagesMemory() {
  std::filesystem::create_directories("tmp");
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /Font << /F1 9 0 R >> >> /Contents 6 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /Font << /F1 9 0 R >> >> /Contents 7 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /Font << /F1 9 0 R >> >> /Contents 8 0 R >>",
      Stream("BT /F1 20 Tf 30 200 Td (FIRST) Tj ET"),
      Stream("BT /F1 20 Tf 30 200 Td (SECOND) Tj ET"),
      Stream("BT /F1 20 Tf 30 200 Td (THIRD) Tj ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "extract-source", "extract-input", nullptr);
  Require(doc != 0, "open extractable three-page PDF");
  const std::string first_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const std::string second_id = PageIdFromDescription(pde_describe_page(doc, 1));
  const std::string third_desc = RequireResult(pde_describe_page(doc, 2), "describe third page");
  const std::string third_id = PageIdFromDescription(third_desc);
  const auto blocks = TextBlockIds(third_desc);
  Require(blocks.size() == 1, "resolve text on extracted source page");
  PdeEditCommand annotation{};
  annotation.type = 17;
  annotation.page_id = second_id.c_str();
  annotation.target_id = "extract-note";
  annotation.resource_id = "text";
  annotation.text_utf8 = "Keep annotation on extracted page";
  annotation.values[0] = 30;
  annotation.values[1] = 30;
  annotation.values[2] = 30;
  annotation.values[3] = 30;
  Require(pde_apply_commands(doc, 0, "add-extract-note", &annotation, 1) != nullptr,
          "add ordinary annotation to source page");
  PdeTextEdit edit{2, blocks[0].c_str(), 0, 5, "REVISED", nullptr};
  Require(pde_apply_text(doc, 1, "edit-extracted-text", &edit, 1) != nullptr,
          "commit text edit before extracting selected pages");
  const std::string source_info = RequireResult(pde_document_info(doc),
                                                "document state before extraction");
  const std::string source_annotations = RequireResult(pde_describe_annotations(doc, 1),
                                                       "source annotation before extraction");
  const auto expected_third = RenderPixels(doc, 2, 300, 300);
  const auto expected_second = RenderPixels(doc, 1, 300, 300);
  const char* ids[] = {third_id.c_str(), second_id.c_str()};
  const std::string response = RequireResult(pde_extract_pages_memory(doc, ids, 2),
                                              "extract selected pages into new PDF");
  Require(response == "{\"kind\":\"bytes\",\"sourceRevision\":2,\"pageIds\":[\"" +
                      third_id + "\",\"" + second_id + "\"]}" &&
              pde_binary_size() > 0,
          "extraction returns exact source page ID order and committed revision");
  const std::vector<uint8_t> extracted_bytes(pde_binary_data(),
                                               pde_binary_data() + pde_binary_size());
  Require(std::string(pde_document_info(doc)) == source_info &&
              PageIdFromDescription(pde_describe_page(doc, 0)) == first_id &&
              std::string(pde_describe_annotations(doc, 1)) == source_annotations,
          "extraction does not mutate original page identities or annotation state");
  const uint32_t result = pde_open_memory(
      extracted_bytes.data(), static_cast<uint32_t>(extracted_bytes.size()),
      "extracted-doc", "new-pdf", nullptr);
  Require(result != 0 &&
              std::string(pde_extract_page(result, 0)).find("REVISED") != std::string::npos &&
              std::string(pde_extract_page(result, 1)).find("SECOND") != std::string::npos &&
              pde_describe_page(result, 2) == nullptr,
          "new PDF contains only selected pages in requested order");
  Require(RenderPixels(result, 0, 300, 300) == expected_third &&
              RenderPixels(result, 1, 300, 300) == expected_second &&
              std::string(pde_describe_annotations(result, 1)).find(
                  "Keep annotation on extracted page") != std::string::npos &&
              std::string(pde_describe_annotations(result, 1)).find(
                  "\"id\":\"extract-note\"") != std::string::npos &&
              PageIdFromDescription(pde_describe_page(result, 0)) != third_id,
          "saved PDF retains pixels and ordinary annotation but has fresh session IDs");
  Require(pde_close(result) == 1, "close extracted PDF");

  const std::string staging_path = "tmp/pde-extract-" + std::to_string(
      std::chrono::steady_clock::now().time_since_epoch().count()) + ".pdf";
  const std::string file_response = RequireResult(
      pde_extract_pages_file_utf8(doc, ids, 2, staging_path.c_str()),
      "extract selected pages directly to staging file");
  Require(file_response == "{\"kind\":\"native-file\",\"sourceRevision\":2,\"pageIds\":[\"" +
                      third_id + "\",\"" + second_id + "\"]}" &&
              pde_binary_size() == 0 &&
              std::string(pde_document_info(doc)) == source_info,
          "native file extraction reports ordered IDs without returning PDF bytes or changing source");
  const uint32_t file_doc = pde_open_file_utf8(
      staging_path.c_str(), "extracted-file-doc", "new-native-file", nullptr);
  Require(file_doc != 0 &&
              RenderPixels(file_doc, 0, 300, 300) == expected_third &&
              RenderPixels(file_doc, 1, 300, 300) == expected_second &&
              std::string(pde_describe_annotations(file_doc, 1)).find(
                  "Keep annotation on extracted page") != std::string::npos,
          "native staging PDF keeps current text, order, pixels and annotations");
  Require(pde_close(file_doc) == 1, "close extracted staging PDF");
  Require(pde_extract_pages_file_utf8(doc, ids, 2, staging_path.c_str()) == nullptr &&
              std::string(pde_error_code()) == "SAVE_FAILED" &&
              pde_binary_size() == 0,
          "existing staging file is never overwritten");
  const uint32_t intact = pde_open_file_utf8(
      staging_path.c_str(), "existing-file-doc", "existing-native-file", nullptr);
  Require(intact != 0 &&
              std::string(pde_extract_page(intact, 0)).find("REVISED") != std::string::npos,
          "failed overwrite preserves the existing staging PDF");
  Require(pde_close(intact) == 1, "close preserved staging PDF");
#if defined(_WIN32)
  Require(DeleteFileW(pdf_editor::NativeWidePath(staging_path).c_str()) != 0,
          "remove owned extraction staging file");
#else
  Require(std::remove(staging_path.c_str()) == 0,
          "remove owned extraction staging file");
#endif

  const char* repeated[] = {second_id.c_str(), second_id.c_str()};
  Require(pde_extract_pages_memory(doc, repeated, 2) == nullptr &&
              std::string(pde_error_code()) == "INVALID_REQUEST" &&
              pde_binary_size() == 0,
          "duplicate page IDs fail without leaving prior export bytes");
  const char* missing[] = {"missing-page"};
  Require(pde_extract_pages_memory(doc, missing, 1) == nullptr &&
              std::string(pde_error_code()) == "INVALID_REQUEST" &&
              pde_binary_size() == 0 &&
              std::string(pde_document_info(doc)) == source_info,
          "unknown page ID fails without modifying committed state");
  Require(pde_extract_pages_memory(doc, nullptr, 0) == nullptr &&
              std::string(pde_error_code()) == "INVALID_REQUEST" &&
              pde_binary_size() == 0,
          "empty page selection fails explicitly");
  Require(pde_undo(doc) != nullptr &&
              std::string(pde_extract_page(doc, 2)).find("THIRD") != std::string::npos &&
              pde_redo(doc) != nullptr &&
              std::string(pde_extract_page(doc, 2)).find("REVISED") != std::string::npos,
          "extraction leaves source undo/redo history intact");
  Require(pde_close(doc) == 1, "close original extracted source");
}

void TestExtractPageAnnotationBacklink() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
      "/Annots [5 0 R] /Contents 4 0 R >>",
      Stream("0 0 20 20 re f"),
      "<< /Type /Annot /Subtype /Text /P 3 0 R /NM (backlink-note) "
      "/Contents (Backlinked note) /Rect [10 10 40 40] >>",
  });
  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "extract-backlink", "extract-backlink-source", nullptr);
  Require(doc != 0, "open annotation with page backlink");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const char* ids[]{page_id.c_str()};
  Require(pde_extract_pages_memory(doc, ids, 1) != nullptr,
          "extract ordinary annotation pointing to selected page");
  const std::vector<uint8_t> bytes(pde_binary_data(),
                                    pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      bytes.data(), static_cast<uint32_t>(bytes.size()),
      "extracted-backlink", "new-backlink-source", nullptr);
  Require(reopened != 0 &&
              std::string(pde_describe_annotations(reopened, 0)).find(
                  "Backlinked note") != std::string::npos,
          "annotation backlink does not prevent ordinary note from surviving save");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close backlink annotation fixtures");
}

void TestExtractPagesUnsupported() {
  const auto check = [](const std::string& pdf, const char* label) {
    const uint32_t doc = pde_open_memory(
        reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
        label, label, nullptr);
    Require(doc != 0, "open structural extraction fixture");
    const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
    const char* ids[] = {page_id.c_str()};
    if (std::string_view(label) != "RichMedia") {
      const auto pixels = RenderPixels(doc, 0, 100, 100);
      Require(pde_extract_pages_memory(doc, ids, 1) != nullptr,
              "supported page structures can be extracted");
      const std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
      Require(pde_document_revision(doc) == 0, "page extraction does not change the source revision");
      const uint32_t extracted = pde_open_memory(bytes.data(), static_cast<uint32_t>(bytes.size()),
          "extracted-structure", "extracted-structure-source", nullptr);
      Require(extracted != 0 && RenderPixels(extracted, 0, 100, 100) == pixels &&
              pde_close(extracted) == 1 && pde_close(doc) == 1,
              "extracted structure fixture preserves the visible page");
      return;
    }
    Require(pde_extract_pages_memory(doc, ids, 1) == nullptr &&
                std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
                pde_binary_size() == 0 && pde_document_revision(doc) == 0,
            "unsupported structural extraction fails without PDF bytes");
    const std::string staging_path = "tmp/pde-extract-refused-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) +
        ".pdf";
    Require(pde_extract_pages_file_utf8(doc, ids, 1, staging_path.c_str()) == nullptr &&
                std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
                pde_binary_size() == 0 && std::fopen(staging_path.c_str(), "rb") == nullptr,
            "unsupported structural extraction never creates a staging file");
    Require(pde_close(doc) == 1, "close unsupported extraction fixture");
  };
  check(Pdf({"<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
             "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
             "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
             Stream("0 0 20 20 re f"),
             "<< /Type /Outlines /Count 0 >>"}), "extract-bookmark");
  for (const char* subtype : {"Link", "Widget", "RichMedia"}) {
    check(Pdf({"<< /Type /Catalog /Pages 2 0 R >>",
               "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
               "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
               "/Contents 4 0 R /Annots [5 0 R] >>",
               Stream("0 0 20 20 re f"),
               std::string("<< /Type /Annot /Subtype /") + subtype +
                   " /Rect [10 10 40 40] >>"}), subtype);
  }
  check(Pdf({"<< /Type /Catalog /Pages 2 0 R /StructTreeRoot << /Type /StructTreeRoot >> >>",
             "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
             "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
             "/StructParents 0 /Contents 4 0 R >>",
             Stream("0 0 20 20 re f")}), "extract-tagged");
  check(Pdf({"<< /Type /Catalog /Pages 2 0 R >>",
             "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
             "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] "
             "/Contents 4 0 R >>",
             Stream("/Span << /MCID 0 >> BDC 0 0 20 20 re f EMC")}),
        "extract-marked-content-id");
}

void TestAnnotationPageDuplicate() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "annot-page-doc", "annot-page-source", nullptr);
  Require(doc != 0, "open annotation page fixture");
  const std::string original_page = PageIdFromDescription(pde_describe_page(doc, 0));
  PdeEditCommand add{};
  add.type = 17; add.page_id = original_page.c_str(); add.target_id = "note-before-copy";
  add.resource_id = "text"; add.text_utf8 = "Persist across page copy";
  add.values[0] = 20; add.values[1] = 20; add.values[2] = 20; add.values[3] = 20;
  Require(pde_apply_commands(doc, 0, "add-before-copy", &add, 1) != nullptr,
          "add real source annotation");
  const char* pairs[] = {original_page.c_str(), "copied-page"};
  PdeEditCommand duplicate{};
  duplicate.type = 12; duplicate.ids = pairs; duplicate.id_count = 2;
  duplicate.target_id = original_page.c_str();
  Require(pde_apply_commands(doc, 1, "duplicate-annotated-page", &duplicate, 1) != nullptr,
          "duplicate page containing native annotation");
  const std::string original = RequireResult(pde_describe_annotations(doc, 0), "original annotation after copy");
  const std::string copied = RequireResult(pde_describe_annotations(doc, 1), "duplicated page annotation");
  Require(original.find("Persist across page copy") != std::string::npos &&
          original.find("\"id\":\"note-before-copy\"") != std::string::npos &&
          copied.find("Persist across page copy") != std::string::npos &&
          copied.find("\"id\":\"note-before-copy\"") == std::string::npos,
          "page duplication preserves annotation contents with a distinct persistent ID");
  Require(pde_save_memory(doc) != nullptr, "save duplicated page annotations");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "annot-page-reopen", "annot-page-saved", nullptr);
  Require(reopened != 0 &&
          std::string(pde_describe_annotations(reopened, 1)).find("Persist across page copy") != std::string::npos,
          "copied annotation survives save and reopen");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close annotation page fixture");
}

void InspectStyledPdfGlyphs(const std::vector<uint8_t>& saved) {
  FPDF_DOCUMENT pdf = FPDF_LoadMemDocument(saved.data(), static_cast<int>(saved.size()), nullptr);
  Require(pdf != nullptr, "open saved styled PDF through public PDFium API");
  FPDF_PAGE page = FPDF_LoadPage(pdf, 0);
  Require(page != nullptr, "load saved styled PDF page");
  FPDF_TEXTPAGE text_page = FPDFText_LoadPage(page);
  Require(text_page != nullptr, "load actual PDF glyph text page");
  const int chars = FPDFText_CountChars(text_page);
  std::vector<unsigned short> extracted(static_cast<size_t>(chars) + 1);
  const int copied = FPDFText_GetText(text_page, 0, chars, extracted.data());
  Require(copied > 1, "copy actual text with PDFium text extraction");
  const std::u16string unicode(extracted.begin(), extracted.begin() + copied - 1);
  Require(unicode.find(u"world") != std::u16string::npos &&
          unicode.find(u"中文") != std::u16string::npos &&
          unicode.find(u"DEFGHIJ") != std::u16string::npos,
          "PDF font ToUnicode and ActualText preserve multilingual copy/search");
  bool black_text = false, red_text = false, red_underline = false;
  std::set<FPDF_FONT> fonts;
  for (int outer = 0; outer < FPDFPage_CountObjects(page); ++outer) {
    FPDF_PAGEOBJECT form = FPDFPage_GetObject(page, outer);
    if (FPDFPageObj_GetType(form) != FPDF_PAGEOBJ_FORM) continue;
    for (int inner = 0; inner < FPDFFormObj_CountObjects(form); ++inner) {
      FPDF_PAGEOBJECT child = FPDFFormObj_GetObject(form, static_cast<unsigned long>(inner));
      unsigned int red = 0, green = 0, blue = 0, alpha = 0;
      if (FPDFPageObj_GetType(child) == FPDF_PAGEOBJ_TEXT) {
        float size = 0;
        Require(FPDFTextObj_GetFontSize(child, &size) &&
                FPDFPageObj_GetFillColor(child, &red, &green, &blue, &alpha),
                "inspect true PDF glyph size and RGB fill");
        fonts.insert(FPDFTextObj_GetFont(child));
        black_text |= red == 0 && green == 0 && blue == 0 && size == 18;
        red_text |= red == 255 && green == 0 && blue == 0 && size == 25;
      } else if (FPDFPageObj_GetType(child) == FPDF_PAGEOBJ_PATH) {
        FPDFPageObj_GetStrokeColor(child, &red, &green, &blue, &alpha);
        red_underline |= red == 255 && green == 0 && blue == 0;
      }
    }
  }
  Require(black_text && red_text && red_underline && fonts.size() >= 2,
          "unselected glyphs retain base font and size; selected glyphs use second embedded font, red fill and red underline");
  FPDFText_ClosePage(text_page);
  FPDF_ClosePage(page);
  FPDF_CloseDocument(pdf);
}

struct ParagraphGlyphSnapshot {
  std::vector<float> last_origin_x;
  std::u16string copied;
};

ParagraphGlyphSnapshot InspectParagraphGlyphs(const std::vector<uint8_t>& saved) {
  FPDF_DOCUMENT pdf = FPDF_LoadMemDocument(saved.data(), static_cast<int>(saved.size()), nullptr);
  Require(pdf != nullptr, "reopen justified PDF with PDFium");
  FPDF_PAGE page = FPDF_LoadPage(pdf, 0);
  Require(page != nullptr, "load justified PDF page");
  FPDF_TEXTPAGE text_page = FPDFText_LoadPage(page);
  Require(text_page != nullptr, "load justified PDF glyphs");
  const int count = FPDFText_CountChars(text_page);
  std::vector<unsigned short> unicode(static_cast<size_t>(count) + 1);
  const int copied = FPDFText_GetText(text_page, 0, count, unicode.data());
  Require(copied > 1, "copy saved PDF glyphs through ToUnicode/ActualText");
  ParagraphGlyphSnapshot snapshot;
  snapshot.copied.assign(unicode.begin(), unicode.begin() + copied - 1);
  std::map<int, float> row_maxima;
  for (int outer = 0; outer < FPDFPage_CountObjects(page); ++outer) {
    FPDF_PAGEOBJECT form = FPDFPage_GetObject(page, outer);
    if (FPDFPageObj_GetType(form) != FPDF_PAGEOBJ_FORM) continue;
    for (int inner = 0; inner < FPDFFormObj_CountObjects(form); ++inner) {
      FPDF_PAGEOBJECT glyph = FPDFFormObj_GetObject(form, static_cast<unsigned long>(inner));
      if (FPDFPageObj_GetType(glyph) != FPDF_PAGEOBJ_TEXT) continue;
      const FPDF_FONT handle = FPDFTextObj_GetFont(glyph);
      CPDF_Font* font = handle ? CPDFFontFromFPDFFont(handle) : nullptr;
      Require(font && font->IsEmbedded() &&
              font->GetFontDict()->GetStreamFor("ToUnicode") &&
              FPDFPageObj_CountMarks(glyph) == 1,
              "saved justified glyph uses embedded font, ToUnicode and direct ActualText mark");
      FS_MATRIX matrix{};
      Require(FPDFPageObj_GetMatrix(glyph, &matrix), "inspect actual saved glyph origin");
      const int baseline = static_cast<int>(std::lround(matrix.f * 100));
      const auto found = row_maxima.find(baseline);
      if (found == row_maxima.end() || matrix.e > found->second) {
        row_maxima[baseline] = matrix.e;
      }
    }
  }
  for (auto row = row_maxima.rbegin(); row != row_maxima.rend(); ++row) {
    snapshot.last_origin_x.push_back(row->second);
  }
  FPDFText_ClosePage(text_page);
  FPDF_ClosePage(page);
  FPDF_CloseDocument(pdf);
  return snapshot;
}

void TestTrackingAndParagraphFormatting(const std::string& font_id) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 20 Tf 2 Tc 1 0 0 1 30 260 Tm [(A) -100 (B) 40 (C) -100 (D)] TJ ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"});
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "tracking-test", "tracking-source", nullptr);
  Require(doc != 0, "open TJ tracking fixture");
  const std::string page = PageIdFromDescription(pde_describe_page(doc, 0));
  const std::string id = TextBlockIds(pde_describe_page(doc, 0)).front();
  Require(std::abs(JsonNumberAfter(pde_describe_page(doc, 0), "\"characterSpacing\":") - 4) < 0.001,
          "tracking includes Tc and usual TJ adjustment");
  PdeEditCommand edit{};
  edit.type = 1; edit.page_id = page.c_str(); edit.target_id = id.c_str();
  edit.start_utf16 = 1; edit.end_utf16 = 2; edit.text_utf8 = "X";
  Require(pde_apply_commands(doc, 0, "tracking-replace", &edit, 1) != nullptr, "replace tracked text");
  const char* ids[] = {id.c_str()};
  PdeEditCommand style{};
  style.type = 2; style.page_id = page.c_str(); style.ids = ids; style.id_count = 1;
  style.flags = 1; style.font_id = font_id.c_str();
  Require(pde_apply_commands(doc, 1, "tracking-font", &style, 1) != nullptr, "change tracked text font");
  Require(pde_save_memory(doc) != nullptr, "save tracked text");
  std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT external = FPDF_LoadMemDocument64(saved.data(), saved.size(), nullptr);
  FPDF_PAGE external_page = FPDF_LoadPage(external, 0);
  auto* text = CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(external_page, 0))->AsText();
  Require(text && text->GetCharKernings() == std::vector<float>({-100, 40, -100, 0}),
          "font changes and replacement retain actual TJ positions after save");
  FPDF_ClosePage(external_page); FPDF_CloseDocument(external);
  style.flags = 8; style.font_id = nullptr; style.values[4] = 1;
  Require(pde_apply_commands(doc, 2, "tracking-control", &style, 1) != nullptr &&
          std::abs(JsonNumberAfter(pde_describe_page(doc, 0), "\"characterSpacing\":") - 1) < 0.001,
          "explicit tracking updates effective spacing without doubling TJ");
  PdeEditCommand insert{};
  insert.type = 3; insert.page_id = page.c_str(); insert.target_id = "paragraph-controls";
  insert.font_id = font_id.c_str(); insert.text_utf8 = "Alpha\nBravo";
  insert.flags = 3 | 16 | 1024; insert.values[0] = 30; insert.values[1] = 75;
  insert.values[2] = 260; insert.values[3] = 170; insert.values[4] = 20; insert.values[9] = 1;
  Require(pde_apply_commands(doc, 3, "paragraph-control-insert", &insert, 1) != nullptr, "insert paragraph controls fixture");
  const std::string paragraph = TextBlockIds(pde_describe_page(doc, 0)).back();
  const char* paragraph_ids[] = {paragraph.c_str()};
  const auto before = RenderPixels(doc, 0, 400, 300);
  style.ids = paragraph_ids; style.flags = 64 | 128; style.values[6] = 1.5; style.values[7] = 1;
  Require(pde_apply_commands(doc, 4, "paragraph-control-style", &style, 1) != nullptr,
          "update paragraph line spacing and alignment with text.style");
  const auto after = RenderPixels(doc, 0, 400, 300);
  Require(before != after && pde_undo(doc) != nullptr && RenderPixels(doc, 0, 400, 300) == before &&
          pde_redo(doc) != nullptr && RenderPixels(doc, 0, 400, 300) == after,
          "paragraph controls change real layout and undo together");
  Require(pde_save_memory(doc) != nullptr, "save paragraph controls");
  saved.assign(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()), "tracking-reopen", "tracking-saved", nullptr);
  Require(reopened != 0 && std::string(pde_describe_page(reopened, 0)).find("\"lineHeight\":1.5,\"alignment\":\"center\"") != std::string::npos &&
          RenderPixels(reopened, 0, 400, 300) == after, "paragraph formatting survives saved PDF reopen");
  pde_close(reopened); pde_close(doc);
}

void TestParagraphRangeStyles(const std::string& base_font,
                              const std::string& latin_font,
                              const std::vector<uint8_t>& latin_bytes) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 4 0 R >>",
      Stream("0.8 g 15 15 15 15 re f"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "style-paragraph", "style-source", nullptr);
  Require(doc != 0, "open paragraph style source");
  const std::string page = PageIdFromDescription(pde_describe_page(doc, 0));
  const std::string text = "Hello \xE4\xB8\xAD\xE6\x96\x87 world A\xCC\x81" "BC DEFGHIJ another line with words";
  PdeEditCommand insert{};
  insert.type = 3; insert.page_id = page.c_str(); insert.target_id = "style-target";
  insert.text_utf8 = text.c_str(); insert.font_id = base_font.c_str();
  insert.flags = 3 | 16 | 1024; insert.values[0] = 20; insert.values[1] = 25;
  insert.values[2] = 245; insert.values[3] = 190; insert.values[4] = 18;
  insert.values[9] = 1.4;
  Require(pde_apply_commands(doc, 0, "insert-styled-target", &insert, 1) != nullptr,
          "insert paragraph for range formatting");
  const std::string original = RequireResult(pde_describe_page(doc, 0), "original paragraph");
  const std::string id = TextBlockIds(original).front();
  const char* targets[] = {id.c_str()};
  const auto original_pixels = RenderPixels(doc, 0, 400, 300);
  PdeEditCommand style{};
  style.type = 2; style.page_id = page.c_str(); style.ids = targets; style.id_count = 1;
  style.font_id = latin_font.c_str(); style.flags = 16 | 1 | 2 | 4 | 8 | 32;
  style.start_utf16 = 9; style.end_utf16 = 14;  // "world", after two CJK code units.
  style.values[0] = 25; style.values[1] = 1; style.values[2] = 0;
  style.values[3] = 0; style.values[4] = 0.5; style.values[5] = 1;
  PdeEditCommand split = style;
  split.start_utf16 = 16; split.end_utf16 = 17;  // Between A and its combining accent.
  Require(pde_preview_commands(doc, 1, &split, 1) == nullptr &&
          std::string(pde_error_code()) == "INVALID_REQUEST" &&
          std::string(pde_describe_page(doc, 0)) == original,
          "styled UTF-16 range refuses a split grapheme without touching the source");
  Require(pde_preview_commands(doc, 1, &style, 1) != nullptr &&
          std::string(pde_describe_page(doc, 0)) == original,
          "preview styled paragraph without mutating source");
  Require(pde_apply_commands(doc, 1, "range-style-1", &style, 1) != nullptr,
          "paint partial paragraph with distinct embedded font and vector underline");
  const auto painted_pixels = RenderPixels(doc, 0, 400, 300);
  const std::string styled_description = RequireResult(pde_describe_page(doc, 0),
      "describe mixed paragraph runs");
  Require(painted_pixels != original_pixels &&
          TextBlockIds(styled_description).front() == id &&
          styled_description.find("\"text\":\"world\",\"style\":{\"fontId\":\"" +
                                  latin_font + "\",\"fontSize\":25") != std::string::npos &&
          styled_description.find("\"underline\":true") != std::string::npos,
          "paragraph identity and selected run style are exposed through existing runs");
  const std::string extracted = RequireResult(pde_extract_page(doc, 0), "styled extraction");
  Require(extracted.find("world") != std::string::npos &&
          extracted.find("\xE4\xB8\xAD\xE6\x96\x87") != std::string::npos &&
          extracted.find("DEFGHIJ") != std::string::npos,
          "mixed-font Unicode and untouched text remain searchable");
  Require(pde_undo(doc) != nullptr && RenderPixels(doc, 0, 400, 300) == original_pixels &&
          std::string(pde_describe_page(doc, 0)) == original &&
          pde_redo(doc) != nullptr && RenderPixels(doc, 0, 400, 300) == painted_pixels &&
          std::string(pde_describe_page(doc, 0)) == styled_description,
          "undo and redo restore actual glyph paint and exact styled runs");
  Require(pde_save_memory(doc) != nullptr, "save range-styled paragraph");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const std::string raw(saved.begin(), saved.end());
  Require(raw.find("/StyleRuns") != std::string::npos &&
          raw.find("/ToUnicode") != std::string::npos,
          "real saved PDF contains style runs and Unicode font mappings");
  InspectStyledPdfGlyphs(saved);
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "style-reopened", "style-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 400, 300) == painted_pixels &&
          std::string(pde_extract_page(reopened, 0)).find("\"text\":\"world\",\"style\":{\"fontId\":\"" +
              latin_font + "\",\"fontSize\":25") != std::string::npos,
          "saved mixed-font Form survives reopen and restores its styled runs");
  const std::string reopened_page = PageIdFromDescription(pde_describe_page(reopened, 0));
  const std::string reopened_id = TextBlockIds(pde_describe_page(reopened, 0)).front();
  const char* reopened_targets[] = {reopened_id.c_str()};
  PdeEditCommand second{};
  second.type = 2; second.page_id = reopened_page.c_str();
  second.ids = reopened_targets; second.id_count = 1;
  second.flags = 16 | 4 | 32; second.start_utf16 = 0; second.end_utf16 = 5;
  second.values[1] = 0; second.values[2] = 0; second.values[3] = 1;
  second.values[5] = 0;
  Require(pde_apply_commands(reopened, 0, "style-reopened-prefix", &second, 1) != nullptr,
          "style saved paragraph again using embedded base and styled fonts");
  const std::string second_runs = RequireResult(pde_extract_page(reopened, 0),
      "describe reopened paragraph after another partial style");
  Require(second_runs.find("\"text\":\"Hello\",\"style\":{") != std::string::npos &&
          second_runs.find("\"text\":\"world\",\"style\":{\"fontId\":\"" +
              latin_font + "\",\"fontSize\":25") != std::string::npos &&
          RenderPixels(reopened, 0, 400, 300) != painted_pixels,
          "reopened edit preserves world run and changes only selected prefix");
  const auto updated_pixels = RenderPixels(reopened, 0, 400, 300);
  PdeTextEdit replacement{0, reopened_id.c_str(), 0, 5, "Helloo", nullptr};
  Require(pde_apply_text(reopened, 1, "replace-styled-prefix", &replacement, 1) != nullptr &&
          std::string(pde_describe_page(reopened, 0)).find("Helloo") != std::string::npos &&
          std::string(pde_extract_page(reopened, 0)).find("world") != std::string::npos,
          "UTF-16 replacement shifts styles while retaining unselected styled text");
  Require(pde_undo(reopened) != nullptr && RenderPixels(reopened, 0, 400, 300) == updated_pixels,
          "undo text reflow restores styled paragraph visuals");
  const uint32_t removed = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "style-delete", "style-delete-source", nullptr);
  Require(removed != 0, "reopen mixed-style paragraph to delete styled span");
  const std::string removed_id = TextBlockIds(pde_describe_page(removed, 0)).front();
  PdeTextEdit erase{0, removed_id.c_str(), 9, 14, "", nullptr};
  Require(pde_apply_text(removed, 0, "erase-styled-word", &erase, 1) != nullptr &&
          std::string(pde_extract_page(removed, 0)).find("world") == std::string::npos &&
          std::string(pde_extract_page(removed, 0)).find("中文") != std::string::npos,
          "deleting an entire styled run releases its font without losing other glyphs");
  const uint32_t whole = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "style-whole", "style-whole-source", nullptr);
  Require(whole != 0, "open whole-font paragraph fixture");
  const std::string whole_page = PageIdFromDescription(pde_describe_page(whole, 0));
  PdeEditCommand short_insert = insert;
  short_insert.page_id = whole_page.c_str();
  short_insert.font_id = latin_font.c_str();
  short_insert.text_utf8 = "Hello Hello";
  Require(pde_apply_commands(whole, 0, "short-insert", &short_insert, 1) != nullptr,
          "insert paragraph for full-range font change");
  const std::string whole_id = TextBlockIds(pde_describe_page(whole, 0)).front();
  const char* whole_targets[] = {whole_id.c_str()};
  PdeEditCommand whole_style{};
  whole_style.type = 2; whole_style.page_id = whole_page.c_str();
  whole_style.ids = whole_targets; whole_style.id_count = 1;
  whole_style.flags = 16 | 1; whole_style.start_utf16 = 0; whole_style.end_utf16 = 11;
  whole_style.font_id = base_font.c_str();
  Require(pde_apply_commands(whole, 1, "whole-font-change", &whole_style, 1) != nullptr &&
          std::string(pde_extract_page(whole, 0)).find("\"fontId\":\"" + base_font + "\"") != std::string::npos,
          "changing every glyph to a second font drops its unused base resource");
  pdf_editor::ShapedText ligatures;
  std::string shaping_error;
  Require(pdf_editor::ShapeText(latin_bytes, "office",
      pdf_editor::TextShapingOptions{}, &ligatures, &shaping_error),
      "shape fixture for glyph cluster boundaries");
  uint32_t cut = 0;
  for (const auto& glyph : ligatures.glyphs) {
    if (glyph.cluster.end > glyph.cluster.start + 1) {
      cut = glyph.cluster.start + 1;
      break;
    }
  }
  // Only exercise a glyph-cluster split when the fixture font actually enables
  // a multi-grapheme ligature; its shape is font-dependent.
  if (cut != 0) {
    const uint32_t ligature_doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
        static_cast<uint32_t>(pdf.size()), "style-ligature", "style-ligature-source", nullptr);
    Require(ligature_doc != 0, "open ligature range fixture");
    const std::string ligature_page = PageIdFromDescription(pde_describe_page(ligature_doc, 0));
    short_insert.page_id = ligature_page.c_str(); short_insert.text_utf8 = "office";
    Require(pde_apply_commands(ligature_doc, 0, "ligature-insert", &short_insert, 1) != nullptr,
            "insert shaped glyph cluster for range guard");
    const std::string ligature_before = pde_describe_page(ligature_doc, 0);
    const std::string ligature_id = TextBlockIds(ligature_before).front();
    const char* ligature_targets[] = {ligature_id.c_str()};
    whole_style.page_id = ligature_page.c_str(); whole_style.ids = ligature_targets;
    whole_style.start_utf16 = cut; whole_style.end_utf16 = cut + 1;
    Require(pde_preview_commands(ligature_doc, 1, &whole_style, 1) == nullptr &&
            std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
            std::string(pde_describe_page(ligature_doc, 0)) == ligature_before,
            "reject a range that is grapheme-safe but cuts an already painted ligature");
    Require(pde_close(ligature_doc) == 1, "close ligature fixture");
  }
  const uint32_t bidi_doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "style-bidi", "style-bidi-source", nullptr);
  Require(bidi_doc != 0, "open mixed-direction paragraph fixture");
  const std::string bidi_page = PageIdFromDescription(pde_describe_page(bidi_doc, 0));
  short_insert.page_id = bidi_page.c_str();
  short_insert.text_utf8 = "abc \xD7\x90\xD7\x91\xD7\x92 xyz";
  Require(pde_apply_commands(bidi_doc, 0, "insert-mixed-direction", &short_insert, 1) != nullptr,
          "shape mixed Hebrew and Latin in one paragraph");
  const std::string bidi_id = TextBlockIds(pde_describe_page(bidi_doc, 0)).front();
  const char* bidi_targets[] = {bidi_id.c_str()};
  PdeEditCommand bidi_style{};
  bidi_style.type = 2; bidi_style.page_id = bidi_page.c_str();
  bidi_style.ids = bidi_targets; bidi_style.id_count = 1;
  bidi_style.flags = 16 | 4; bidi_style.start_utf16 = 4; bidi_style.end_utf16 = 7;
  bidi_style.values[1] = 1;
  Require(pde_apply_commands(bidi_doc, 1, "style-rtl-run", &bidi_style, 1) != nullptr,
          "style one logical RTL span while resolving the entire bidi line");
  Require(pde_save_memory(bidi_doc) != nullptr, "save mixed-direction styled PDF");
  const std::vector<uint8_t> bidi_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT bidi_pdf = FPDF_LoadMemDocument(bidi_bytes.data(), static_cast<int>(bidi_bytes.size()), nullptr);
  Require(bidi_pdf != nullptr, "reopen mixed-direction PDF through PDFium");
  FPDF_PAGE bidi_native_page = FPDF_LoadPage(bidi_pdf, 0);
  FPDF_TEXTPAGE bidi_text = FPDFText_LoadPage(bidi_native_page);
  std::vector<unsigned short> bidi_chars(static_cast<size_t>(FPDFText_CountChars(bidi_text)) + 1);
  const int bidi_count = FPDFText_GetText(bidi_text, 0, FPDFText_CountChars(bidi_text), bidi_chars.data());
  const std::u16string bidi_copied(bidi_chars.begin(), bidi_chars.begin() + bidi_count - 1);
  Require(bidi_copied.find(u"אבג") != std::u16string::npos &&
          bidi_copied.find(u"abc") != std::u16string::npos &&
          bidi_copied.find(u"xyz") != std::u16string::npos,
          "saved mixed-direction PDF text copies in logical order after partial formatting");
  FPDFText_ClosePage(bidi_text); FPDF_ClosePage(bidi_native_page); FPDF_CloseDocument(bidi_pdf);
  Require(pde_close(bidi_doc) == 1 && pde_close(whole) == 1 &&
          pde_close(removed) == 1 && pde_close(reopened) == 1 &&
          pde_close(doc) == 1, "close paragraph range fixtures");
}

void TestParagraphJustify(const std::string& latin_font,
                          const std::string& cjk_font) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << >> /Contents 4 0 R >>",
      Stream("q Q"),
  });
  const auto open = [&](const char* id) {
    return pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
                           static_cast<uint32_t>(pdf.size()), id, id, nullptr);
  };
  const uint32_t doc = open("justify-doc"), control = open("left-doc");
  Require(doc != 0 && control != 0, "open justified and left-aligned PDF controls");
  const std::string page = PageIdFromDescription(pde_describe_page(doc, 0));
  const std::string control_page = PageIdFromDescription(pde_describe_page(control, 0));
  const char* text = "One two three four five six seven eight nine ten";
  PdeEditCommand insert{};
  insert.type = 3; insert.page_id = page.c_str(); insert.target_id = "justify-paragraph";
  insert.text_utf8 = text; insert.font_id = latin_font.c_str();
  insert.flags = 3 | 16 | 32 | 64 | 1024;
  insert.values[0] = 20; insert.values[1] = 20; insert.values[2] = 150;
  insert.values[3] = 180; insert.values[4] = 16; insert.values[9] = 1.35;
  const std::string before = pde_describe_page(doc, 0);
  PdeEditCommand nonparagraph = insert;
  nonparagraph.flags &= ~1024U;
  Require(pde_preview_commands(doc, 0, &nonparagraph, 1) == nullptr &&
          std::string(pde_error_code()) == "INVALID_REQUEST" &&
          std::string(pde_describe_page(doc, 0)) == before,
          "ordinary inserted text still rejects simultaneous center/right flags");
  const std::string preview = RequireResult(pde_preview_text_insert(doc, 0, &insert),
                                            "preview justified text line boxes");
  const size_t preview_lines = Count(preview, "\"range\":[");
  Require(preview.find("\"overflow\":false") != std::string::npos &&
          preview_lines >= 2 &&
          std::abs(JsonNumberAfter(preview, "\"width\":", 1) - 150) < 0.05 &&
          JsonNumberAfter(preview, "\"width\":", preview_lines) < 149.9 &&
          std::string(pde_describe_page(doc, 0)) == before,
          "preview expands soft lines to box width but leaves the final line natural");
  PdeEditCommand left = insert;
  left.page_id = control_page.c_str(); left.flags = 3 | 16 | 1024;
  Require(pde_apply_commands(control, 0, "insert-left-control", &left, 1) != nullptr &&
          pde_apply_commands(doc, 0, "insert-justify", &insert, 1) != nullptr,
          "apply identical left and justified text to separate real PDFs");
  const auto pixels = RenderPixels(doc, 0, 400, 300);
  Require(pixels != RenderPixels(control, 0, 400, 300),
          "justification changes real printed glyph positions");
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_page(doc, 0)) == before &&
          pde_redo(doc) != nullptr && RenderPixels(doc, 0, 400, 300) == pixels,
          "justify preview and undo/redo restore paragraph geometry and appearance");
  Require(pde_save_memory(control) != nullptr, "save left glyph control PDF");
  const std::vector<uint8_t> left_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  Require(pde_save_memory(doc) != nullptr, "save justified glyph PDF");
  const std::vector<uint8_t> justified_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const std::string raw(justified_bytes.begin(), justified_bytes.end());
  Require(raw.find("/Justify") != std::string::npos &&
          raw.find("/ToUnicode") != std::string::npos,
          "saved Form records justify alignment and a real glyph ToUnicode mapping");
  const auto left_glyphs = InspectParagraphGlyphs(left_bytes);
  const auto justified_glyphs = InspectParagraphGlyphs(justified_bytes);
  Require(justified_glyphs.copied.find(u"One two three") != std::u16string::npos &&
          justified_glyphs.copied.find(u"nine ten") != std::u16string::npos &&
          justified_glyphs.last_origin_x.size() == left_glyphs.last_origin_x.size() &&
          justified_glyphs.last_origin_x.size() >= 2 &&
          justified_glyphs.last_origin_x.front() > left_glyphs.last_origin_x.front() + 5 &&
          std::abs(justified_glyphs.last_origin_x.back() -
                   left_glyphs.last_origin_x.back()) < 0.01f,
          "non-final actual PDF glyph origins reach farther right; final line stays natural");
  const uint32_t reopened = pde_open_memory(justified_bytes.data(),
      static_cast<uint32_t>(justified_bytes.size()), "justify-reopened", "justify-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 400, 300) == pixels,
          "saved justified PDF reopens with identical real glyph placement");
  const std::string block = TextBlockIds(pde_describe_page(reopened, 0)).front();
  PdeTextEdit replace{0, block.c_str(), 0, 3, "Two", nullptr};
  Require(pde_apply_text(reopened, 0, "justify-reflow", &replace, 1) != nullptr &&
          pde_save_memory(reopened) != nullptr,
          "reflow reopened paragraph while preserving justify metadata");
  const std::vector<uint8_t> edited(pde_binary_data(), pde_binary_data() + pde_binary_size());
  Require(std::string(edited.begin(), edited.end()).find("/Justify") != std::string::npos &&
          InspectParagraphGlyphs(edited).copied.find(u"Two two three") != std::u16string::npos,
          "paragraph replacement retains real justify alignment and Unicode text");
  PdeEditCommand unsafe = insert;
  unsafe.text_utf8 = "abc \xD7\x90\xD7\x91\xD7\x92 xyz";
  unsafe.target_id = "rtl-justify";
  Require(pde_preview_commands(doc, 3, &unsafe, 1) != nullptr,
          "mixed RTL line supports paragraph justification");
  unsafe.text_utf8 = "Supercalifragilisticexpialidocious";
  Require(pde_preview_commands(doc, 3, &unsafe, 1) == nullptr &&
          std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY",
          "a long word without safe word or CJK gaps is not stretched between letters");
  PdeEditCommand punctuation = insert;
  punctuation.target_id = "punctuation-justify";
  punctuation.text_utf8 = "Hello, world example";
  punctuation.values[2] = 115;
  Require(pde_preview_commands(doc, 3, &punctuation, 1) != nullptr,
          "safe word spacing across punctuation remains eligible for justification");
  const std::string tagged = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 5 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Contents 4 0 R >>",
      Stream("q Q"),
      "<< /Type /StructTreeRoot /K [] >>",
  });
  const uint32_t tagged_doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(tagged.data()), static_cast<uint32_t>(tagged.size()),
      "tagged-justify", "tagged-justify-source", nullptr);
  Require(tagged_doc != 0, "open tagged PDF to test structural guard");
  const std::string tagged_page = PageIdFromDescription(pde_describe_page(tagged_doc, 0));
  unsafe = insert; unsafe.page_id = tagged_page.c_str();
  Require(pde_preview_commands(tagged_doc, 0, &unsafe, 1) != nullptr &&
          pde_document_revision(tagged_doc) == 0,
          "justified paragraph preview can create valid structure on a tagged page without committing");
  Require(pde_close(tagged_doc) == 1, "close tagged justification fixture");
  const auto saved_glyphs = [&](uint32_t handle) {
    Require(pde_save_memory(handle) != nullptr, "save comparison paragraph");
    return InspectParagraphGlyphs(std::vector<uint8_t>(
        pde_binary_data(), pde_binary_data() + pde_binary_size()));
  };
  const uint32_t cjk_doc = open("cjk-justify"), cjk_left_doc = open("cjk-left");
  Require(cjk_doc != 0 && cjk_left_doc != 0, "open CJK spacing fixtures");
  const std::string cjk_page = PageIdFromDescription(pde_describe_page(cjk_doc, 0));
  const std::string cjk_left_page = PageIdFromDescription(pde_describe_page(cjk_left_doc, 0));
  insert.page_id = cjk_page.c_str(); insert.font_id = cjk_font.c_str();
  insert.text_utf8 = "中文测试中文测试中文测试中文测试";
  insert.values[2] = 125; insert.values[4] = 18;
  left.page_id = cjk_left_page.c_str(); left.font_id = cjk_font.c_str();
  left.text_utf8 = insert.text_utf8; left.values[2] = 125; left.values[4] = 18;
  Require(pde_apply_commands(cjk_doc, 0, "cjk-justify", &insert, 1) != nullptr &&
          pde_apply_commands(cjk_left_doc, 0, "cjk-left", &left, 1) != nullptr,
          "justify non-final CJK lines by safe ideograph gaps without word spaces");
  const auto cjk_just = saved_glyphs(cjk_doc);
  const auto cjk_left = saved_glyphs(cjk_left_doc);
  Require(cjk_just.copied.find(u"中文测试") != std::u16string::npos &&
          cjk_just.last_origin_x.size() == cjk_left.last_origin_x.size() &&
          cjk_just.last_origin_x.size() >= 2 &&
          cjk_just.last_origin_x.front() > cjk_left.last_origin_x.front() + 5 &&
          std::abs(cjk_just.last_origin_x.back() - cjk_left.last_origin_x.back()) < 0.01f,
          "CJK non-final glyph positions expand while final line retains natural spacing");
  const uint32_t hard_doc = open("hard-justify"), hard_left_doc = open("hard-left");
  Require(hard_doc != 0 && hard_left_doc != 0, "open hard-break spacing fixtures");
  const std::string hard_page = PageIdFromDescription(pde_describe_page(hard_doc, 0));
  const std::string hard_left_page = PageIdFromDescription(pde_describe_page(hard_left_doc, 0));
  insert.page_id = hard_page.c_str(); insert.font_id = latin_font.c_str();
  insert.text_utf8 = "One two\nThree four five six seven eight nine ten";
  insert.values[2] = 150; insert.values[4] = 16;
  left.page_id = hard_left_page.c_str(); left.font_id = latin_font.c_str();
  left.text_utf8 = insert.text_utf8; left.values[2] = 150; left.values[4] = 16;
  Require(pde_apply_commands(hard_doc, 0, "hard-justify", &insert, 1) != nullptr &&
          pde_apply_commands(hard_left_doc, 0, "hard-left", &left, 1) != nullptr,
          "insert paragraph containing both explicit break and soft wraps");
  const auto hard_just = saved_glyphs(hard_doc);
  const auto hard_left = saved_glyphs(hard_left_doc);
  Require(hard_just.last_origin_x.size() == hard_left.last_origin_x.size() &&
          hard_just.last_origin_x.size() >= 3 &&
          std::abs(hard_just.last_origin_x.front() - hard_left.last_origin_x.front()) < 0.01f &&
          hard_just.last_origin_x[1] > hard_left.last_origin_x[1] + 5,
          "explicit-break final line stays natural; following soft-wrapped line expands");
  const std::string source_pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 16 Tf 20 250 Td (Old first) Tj ET "
             "BT /F1 16 Tf 20 225 Td (Old second) Tj ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t reflow_doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(source_pdf.data()),
      static_cast<uint32_t>(source_pdf.size()), "justify-reflow", "justify-reflow-source", nullptr);
  Require(reflow_doc != 0, "open two-source reflow justification fixture");
  const std::string source_page = pde_describe_page(reflow_doc, 0);
  const std::string reflow_page_id = PageIdFromDescription(source_page);
  const auto ids = TextBlockIds(source_page);
  Require(ids.size() == 2, "reflow fixture has adjacent original text objects");
  const char* from[] = {ids[0].c_str(), ids[1].c_str()};
  PdeEditCommand reflow = insert;
  reflow.type = 20; reflow.page_id = reflow_page_id.c_str();
  reflow.ids = from; reflow.id_count = 2; reflow.font_id = latin_font.c_str();
  reflow.text_utf8 = text; reflow.values[2] = 150; reflow.values[4] = 16;
  Require(pde_preview_text_insert(reflow_doc, 0, &reflow) != nullptr &&
          pde_apply_commands(reflow_doc, 0, "justify-source-reflow", &reflow, 1) != nullptr,
          "type-20 reflow accepts 32|64 only with the logical paragraph flag");
  const auto reflow_glyphs = saved_glyphs(reflow_doc);
  Require(reflow_glyphs.last_origin_x.size() >= 2 &&
          reflow_glyphs.copied.find(u"Old first") == std::u16string::npos &&
          reflow_glyphs.copied.find(u"One two three") != std::u16string::npos,
          "real PDF replaces source glyphs with justified ToUnicode text");
  Require(pde_undo(reflow_doc) != nullptr &&
          std::string(pde_describe_page(reflow_doc, 0)) == source_page,
          "undo reflow restores the original text objects and identities");
  const std::string vertical_pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 16 Tf 0 1 -1 0 20 250 Tm (Vertical) Tj ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t vertical_doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(vertical_pdf.data()),
      static_cast<uint32_t>(vertical_pdf.size()), "vertical-justify", "vertical-source", nullptr);
  Require(vertical_doc != 0, "open rotated source text fixture");
  const std::string vertical_page = pde_describe_page(vertical_doc, 0);
  const std::string vertical_page_id = PageIdFromDescription(vertical_page);
  const std::string vertical_id = TextBlockIds(vertical_page).front();
  const char* vertical_ids[] = {vertical_id.c_str()};
  reflow.page_id = vertical_page_id.c_str(); reflow.ids = vertical_ids; reflow.id_count = 1;
  Require(pde_preview_commands(vertical_doc, 0, &reflow, 1) == nullptr &&
          std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY",
          "justified reflow rejects rotated or vertical source text");
  Require(pde_close(vertical_doc) == 1 && pde_close(reflow_doc) == 1 &&
          pde_close(hard_left_doc) == 1 &&
          pde_close(hard_doc) == 1 && pde_close(cjk_left_doc) == 1 &&
          pde_close(cjk_doc) == 1 && pde_close(reopened) == 1 &&
          pde_close(doc) == 1 && pde_close(control) == 1,
          "close justified glyph fixtures");
}

void TestParagraphEditing(const std::string& font_id) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 18 Tf 20 250 Td (First line) Tj ET BT /F1 18 Tf 20 225 Td (Second line) Tj ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "paragraph-doc", "paragraph-source", nullptr);
  Require(doc != 0, "open paragraph source");
  const std::string before = pde_describe_page(doc, 0);
  const std::string page = PageIdFromDescription(before);
  const auto ids = TextBlockIds(before);
  const char* block_ids[] = {ids[0].c_str(), ids[1].c_str()};
  PdeEditCommand reflow{};
  reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "logical-paragraph";
  reflow.ids = block_ids; reflow.id_count = 2;
  reflow.font_id = font_id.c_str(); reflow.flags = 3 | 16 | 1024 | 2048;
  reflow.values[0] = 20; reflow.values[1] = 20; reflow.values[2] = 280;
  reflow.values[3] = 180; reflow.values[4] = 18; reflow.values[9] = 1.4;
  reflow.text_utf8 = "\xE4\xB8\xAD\xE6\x96\x87 paragraph\nSecond line with more words to wrap naturally.";
  const std::string layout = RequireResult(pde_preview_text_insert(doc, 0, &reflow), "preview shaped paragraph");
  Require(layout.find("\"overflow\":false") != std::string::npos && Count(layout, "\"range\"") >= 2,
          "HarfBuzz paragraph preview reports real line layout");
  Require(std::string(pde_describe_page(doc, 0)) == before, "paragraph preview does not replace source objects");
  Require(pde_apply_commands(doc, 0, "paragraph-reflow", &reflow, 1) != nullptr, "replace adjacent original objects with real paragraph");
  const std::string paragraph = RequireResult(pde_describe_page(doc, 0), "describe logical paragraph");
  Require(TextBlockIds(paragraph).size() == 1 && paragraph.find("\"isParagraph\":true") != std::string::npos &&
          paragraph.find("\"underline\":true") != std::string::npos,
          "underlined paragraph is one logical block backed by real glyphs");
  Require(paragraph.find("First line") == std::string::npos && paragraph.find("Second line with more") != std::string::npos,
          "original text really replaced, not covered");
  const std::string id = TextBlockIds(paragraph)[0];
  PdeTextEdit edit{0, id.c_str(), 0, 2, "\xE4\xB8\xAD\xE6\x96\x87\nEdited", nullptr};
  Require(pde_preview_text(doc, &edit) != nullptr && pde_apply_text(doc, 1, "paragraph-replace", &edit, 1) != nullptr,
          "existing logical paragraph supports multiline replacement");
  const std::string edited = pde_describe_page(doc, 0);
  Require(TextBlockIds(edited)[0] == id && edited.find("Edited paragraph") != std::string::npos &&
          edited.find("\"underline\":true") != std::string::npos,
          "paragraph replacement preserves logical identity and vector underline");
  Require(pde_save_memory(doc) != nullptr, "save shaped paragraph");
  const std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(bytes.data(), static_cast<uint32_t>(bytes.size()), "paragraph-reopened", "paragraph-saved", nullptr);
  Require(reopened != 0, "reopen shaped paragraph");
  const std::string reloaded = pde_describe_page(reopened, 0);
  Require(TextBlockIds(reloaded).size() == 1 && reloaded.find("\"isParagraph\":true") != std::string::npos &&
          reloaded.find("\"underline\":true") != std::string::npos,
          "saved Form retains logical paragraph and underline metadata");
  Require(RenderPixels(reopened, 0, 400, 300) == RenderPixels(doc, 0, 400, 300), "shaped glyphs survive save and reload");
  const std::string saved_block = TextBlockIds(reloaded)[0];
  PdeTextEdit saved_edit{0, saved_block.c_str(), 0, 2,
      "\xE4\xB8\xAD\xE6\x96\x87\xE4\xB8\xAD\xE6\x96\x87", nullptr};
  Require(pde_apply_text(reopened, 0, "edit-embedded-paragraph", &saved_edit, 1) != nullptr,
          "saved paragraph can reuse embedded glyphs without a source font file");
  Require(pde_close(reopened) == 1, "close reopened paragraph");
  Require(pde_undo(doc) != nullptr && pde_undo(doc) != nullptr && std::string(pde_describe_page(doc, 0)) == before,
          "undo paragraph restores original text objects and IDs");
  Require(pde_close(doc) == 1, "close paragraph fixture");
}

void TestOcrSearchLayer(const std::string& font_id, bool rotated = false) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> /Contents 4 0 R >>",
      Stream("0.8 g 20 60 220 40 re f"),
  });
  uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "ocr-layer", "ocr-layer-source", nullptr);
  Require(doc != 0, "open search layer fixture");
  const std::string page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  const auto original_pixels = RenderPixels(doc, 0, 300, 200);
  PdeEditCommand insert{};
  insert.type = 3; insert.page_id = page_id.c_str(); insert.target_id = "ocr-line";
  insert.text_utf8 = "\xE4\xB8\xAD\xE6\x96\x87 OCR search";
  insert.font_id = font_id.c_str(); insert.flags = 3 | 128 | 256 | 512;
  insert.values[0] = 20; insert.values[1] = 100; insert.values[2] = 220;
  insert.values[3] = 40; insert.values[4] = 12;
  Require(pde_apply_commands(doc, 0, "ocr-insert", &insert, 1) != nullptr, "insert real invisible search text");
  Require(RenderPixels(doc, 0, 300, 200) == original_pixels, "OCR search text never changes visible page pixels");
  std::string described = RequireResult(pde_describe_page(doc, 0), "describe OCR text");
  Require(described.find("\"isOcr\":true") != std::string::npos &&
          described.find(insert.text_utf8) != std::string::npos, "search layer text and marker available to UI");
  const std::string block_id = TextBlockIds(described)[0];
  uint32_t revision = 1;
  if (rotated) {
    const char* ids[] = {"ocr-line"};
    PdeEditCommand rotate{};
    rotate.type = 4; rotate.page_id = page_id.c_str(); rotate.ids = ids; rotate.id_count = 1;
    rotate.values[0] = -1; rotate.values[3] = -1; rotate.values[4] = 260; rotate.values[5] = 240;
    Require(pde_apply_commands(doc, revision, "rotate-ocr-layer", &rotate, 1) != nullptr,
            "position OCR text over upside-down scan");
    ++revision;
  }
  PdeTextEdit correction{0, block_id.c_str(), 0, 13, "Corrected searchable text", nullptr};
  const std::string layout = RequireResult(pde_preview_text(doc, &correction), "preview OCR correction");
  Require(layout.find("\"overflow\":false") != std::string::npos, "OCR correction fits its original recognized box");
  Require(pde_apply_text(doc, revision, "ocr-correct", &correction, 1) != nullptr, "correct invisible search text");
  if (rotated) Require(JsonNumberAfter(pde_describe_page(doc, 0), "\"transform\":[", 1) < 0,
                       "OCR correction retains the recognized orientation");
  Require(RenderPixels(doc, 0, 300, 200) == original_pixels, "correcting OCR does not repaint scan");
  Require(pde_save_memory(doc) != nullptr, "save OCR search layer");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "ocr-reopened", "ocr-saved", nullptr);
  Require(reopened != 0, "reopen OCR search layer");
  described = RequireResult(pde_describe_page(reopened, 0), "describe reopened OCR");
  Require(described.find("Corrected searchable text") != std::string::npos &&
          described.find("\"isOcr\":true") != std::string::npos &&
          RenderPixels(reopened, 0, 300, 200) == original_pixels, "saved OCR text stays searchable and invisible");
  Require(pde_close(reopened) == 1, "close reopened OCR");
  Require(pde_undo(doc) != nullptr && std::string(pde_extract_page(doc, 0)).find(insert.text_utf8) != std::string::npos,
          "undo correction restores recognized text");
  if (rotated) Require(pde_undo(doc) != nullptr, "undo OCR positioning");
  Require(pde_undo(doc) != nullptr && TextBlockIds(pde_describe_page(doc, 0)).empty(),
          "undo OCR removes only the search layer");
  Require(pde_redo(doc) != nullptr && TextBlockIds(pde_describe_page(doc, 0))[0] == block_id,
          "redo OCR preserves its text identity");
  Require(pde_close(doc) == 1, "close OCR search layer");
}

void TestMultilineTextInsert(const std::string& font_id) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 400] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("0 0 1 1 re f"),
  });
  const uint32_t document = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "doc-multiline", "source-multiline",
      nullptr);
  Require(document != 0, "open multiline insertion PDF");
  const std::string page =
      RequireResult(pde_describe_page(document, 0), "describe multiline page");
  const std::string page_id = PageIdFromDescription(page);

  Require(page_id.starts_with("p:"), "generated page ID prefix");
  const size_t session_end = page_id.find(':', 2);
  Require(session_end != std::string::npos, "generated page ID session");
  const std::string collision_root = "multiline-collision";
  const std::string derived_line_id =
      "o:" + page_id.substr(2, session_end - 2) + ":g:" +
      std::to_string(TestStableIdHash(collision_root)) + ":1";
  PdeEditCommand collision[2]{};
  collision[0].type = 3;
  collision[0].page_id = page_id.c_str();
  collision[0].target_id = collision_root.c_str();
  collision[0].text_utf8 = "A\nB";
  collision[0].font_id = font_id.c_str();
  collision[0].flags = 3;
  collision[0].values[0] = 20;
  collision[0].values[1] = 20;
  collision[0].values[2] = 200;
  collision[0].values[3] = 80;
  collision[0].values[4] = 16;
  collision[1].type = 9;
  collision[1].page_id = derived_line_id.c_str();
  collision[1].values[0] = 100;
  collision[1].values[1] = 100;
  Require(pde_preview_text_insert(document, 0, &collision[1]) == nullptr,
          "text insertion preview rejects non-type-3 command");
  Require(pde_apply_commands(document, 0, "multiline-collision-batch",
                             collision, 2) == nullptr,
          "derived text line ID rejects same-batch explicit collision");
  Require(std::string(pde_document_info(document))
                  .find("\"revision\":0") != std::string::npos &&
              std::string(pde_describe_page(document, 0))
                      .find(collision_root) == std::string::npos,
          "derived line collision rolls back the whole batch");

  const std::string explicit_text =
      "\xE7\xAC\xAC\xE4\xB8\x80\xE8\xA1\x8C\xE4\xB8\xAD\xE6\x96\x87\r\nEnglish";
  PdeEditCommand explicit_insert{};
  explicit_insert.type = 3;
  explicit_insert.page_id = page_id.c_str();
  explicit_insert.target_id = "multiline-explicit";
  explicit_insert.text_utf8 = explicit_text.c_str();
  explicit_insert.font_id = font_id.c_str();
  explicit_insert.flags = 3 | 16;
  explicit_insert.values[0] = 20;
  explicit_insert.values[1] = 20;
  explicit_insert.values[2] = 300;
  explicit_insert.values[3] = 100;
  explicit_insert.values[4] = 20;
  explicit_insert.values[9] = 1.4;
  const std::string explicit_preview = RequireResult(
      pde_preview_text_insert(document, 0, &explicit_insert),
      "preview explicit Chinese and English lines");
  Require(explicit_preview.find("\"overflow\":false") != std::string::npos &&
              Count(explicit_preview, "\"range\":[") == 2 &&
              explicit_preview.find("\"range\":[0,5]") !=
                  std::string::npos &&
              explicit_preview.find("\"range\":[7,14]") !=
                  std::string::npos &&
              explicit_preview.find("\"replacementFontId\":\"" + font_id +
                                    "\"") != std::string::npos,
          "explicit multiline preview ranges and font");
  Require(pde_apply_commands(document, 0, "multiline-explicit-tx",
                             &explicit_insert, 1) != nullptr,
          "apply explicit multiline text");
  const std::string applied_page = RequireResult(
      pde_describe_page(document, 0), "describe applied multiline text");
  const std::string extracted =
      RequireResult(pde_extract_page(document, 0), "extract multiline text");
  Require(applied_page.find("\"id\":\"multiline-explicit\"") !=
                  std::string::npos &&
              applied_page.find(":g:") != std::string::npos &&
              extracted.find("\xE4\xB8\xAD\xE6\x96\x87") !=
                  std::string::npos &&
              extracted.find("English") != std::string::npos,
          "explicit lines use the command ID then stable derived IDs");
  Require(pde_undo(document) != nullptr, "undo multiline text insertion");
  Require(std::string(pde_extract_page(document, 0)).find("English") ==
              std::string::npos,
          "multiline undo removes every derived line");
  Require(pde_redo(document) != nullptr, "redo multiline text insertion");
  Require(std::string(pde_extract_page(document, 0)).find("English") !=
                  std::string::npos &&
              RequireResult(pde_describe_page(document, 0),
                            "describe redone multiline text") == applied_page,
          "multiline redo restores stable derived line identities");

  const std::string grapheme_text = "e\xCC\x81" "e\xCC\x81";
  PdeEditCommand grapheme{};
  grapheme.type = 3;
  grapheme.page_id = page_id.c_str();
  grapheme.target_id = "multiline-grapheme";
  grapheme.text_utf8 = grapheme_text.c_str();
  grapheme.font_id = font_id.c_str();
  grapheme.flags = 3;
  grapheme.values[0] = 20;
  grapheme.values[1] = 130;
  grapheme.values[2] = 18;
  grapheme.values[3] = 80;
  grapheme.values[4] = 20;
  const std::string grapheme_preview = RequireResult(
      pde_preview_text_insert(document, 3, &grapheme),
      "preview narrow grapheme wrapping");
  Require(Count(grapheme_preview, "\"range\":[") == 2 &&
              grapheme_preview.find("\"range\":[0,2]") !=
                  std::string::npos &&
              grapheme_preview.find("\"range\":[2,4]") !=
                  std::string::npos &&
              grapheme_preview.find("\"range\":[0,1]") ==
                  std::string::npos,
          "narrow wrapping preserves combining grapheme clusters");

  PdeEditCommand line_height = grapheme;
  line_height.target_id = "multiline-line-height";
  line_height.text_utf8 = "A\nA";
  line_height.flags = 3 | 16;
  line_height.values[0] = 20;
  line_height.values[1] = 130;
  line_height.values[2] = 200;
  line_height.values[3] = 80;
  line_height.values[4] = 20;
  line_height.values[9] = 1.4;
  const std::string line_height_preview = RequireResult(
      pde_preview_text_insert(document, 3, &line_height),
      "preview explicit line height");
  const double first_line_y =
      JsonNumberAfter(line_height_preview, "\"y\":", 1);
  const double second_line_y =
      JsonNumberAfter(line_height_preview, "\"y\":", 2);
  Require(second_line_y - first_line_y > 27.9 &&
              second_line_y - first_line_y < 28.1,
          "line-height multiplier controls real line spacing");

  PdeEditCommand aligned = grapheme;
  aligned.target_id = "multiline-alignment";
  aligned.text_utf8 = "Align";
  aligned.values[0] = 20;
  aligned.values[1] = 130;
  aligned.values[2] = 200;
  aligned.values[3] = 50;
  aligned.values[4] = 16;
  aligned.flags = 3;
  const std::string left_preview = RequireResult(
      pde_preview_text_insert(document, 3, &aligned), "preview left alignment");
  aligned.flags = 3 | 32;
  const std::string center_preview = RequireResult(
      pde_preview_text_insert(document, 3, &aligned),
      "preview center alignment");
  aligned.flags = 3 | 64;
  const std::string right_preview = RequireResult(
      pde_preview_text_insert(document, 3, &aligned),
      "preview right alignment");
  constexpr std::string_view kLineX = "\"lines\":[{\"bounds\":{\"x\":";
  const double left_x = JsonNumberAfter(left_preview, kLineX);
  const double center_x = JsonNumberAfter(center_preview, kLineX);
  const double right_x = JsonNumberAfter(right_preview, kLineX);
  Require(center_x > left_x + 20 && right_x > center_x + 20,
          "center and right alignment move real line bounds");

  PdeEditCommand empty_line{};
  empty_line.type = 3;
  empty_line.page_id = page_id.c_str();
  empty_line.target_id = "multiline-empty";
  empty_line.text_utf8 = "A\n\nB";
  empty_line.font_id = font_id.c_str();
  empty_line.flags = 3 | 16;
  empty_line.values[0] = 20;
  empty_line.values[1] = 190;
  empty_line.values[2] = 200;
  empty_line.values[3] = 100;
  empty_line.values[4] = 16;
  empty_line.values[9] = 1.2;
  const std::string empty_preview = RequireResult(
      pde_preview_text_insert(document, 3, &empty_line),
      "preview occupied empty line");
  Require(Count(empty_preview, "\"range\":[") == 3 &&
              empty_preview.find("\"range\":[0,1]") != std::string::npos &&
              empty_preview.find("\"range\":[2,2]") != std::string::npos &&
              empty_preview.find("\"range\":[3,4]") != std::string::npos,
          "empty line occupies layout without visible text");
  Require(pde_apply_commands(document, 3, "multiline-empty-tx", &empty_line,
                             1) != nullptr,
          "apply text containing an empty line");
  Require(Count(RequireResult(pde_describe_page(document, 0),
                              "describe empty line objects"),
                "\"type\":\"text\"") == 4,
          "visible lines are real text objects; blank lines preserve spacing without phantom identities");

  PdeEditCommand overflow = empty_line;
  overflow.target_id = "multiline-overflow";
  overflow.text_utf8 = "A\nB\nC";
  overflow.values[1] = 310;
  overflow.values[3] = 10;
  overflow.values[4] = 20;
  const std::string overflow_preview = RequireResult(
      pde_preview_text_insert(document, 4, &overflow),
      "preview overflowing multiline text");
  Require(overflow_preview.find("\"overflow\":true") != std::string::npos &&
              Count(overflow_preview, "\"range\":[") == 3,
          "overflow preview returns complete untruncated line layout");
  Require(pde_apply_commands(document, 4, "multiline-overflow-tx", &overflow,
                             1) == nullptr,
          "overflowing multiline apply is rejected");
  Require(std::string(pde_document_info(document))
                      .find("\"revision\":4") != std::string::npos &&
              std::string(pde_describe_page(document, 0))
                      .find("multiline-overflow") == std::string::npos,
          "overflowing insertion fails atomically");

  Require(pde_save_memory(document) != nullptr, "save multiline document");
  const std::vector<uint8_t> saved(pde_binary_data(),
                                   pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()), "doc-multiline-reopen",
      "source-multiline-reopen", nullptr);
  Require(reopened != 0, "reopen multiline document");
  const std::string reopened_text = RequireResult(
      pde_extract_page(reopened, 0), "extract reopened multiline document");
  Require(reopened_text.find("English") != std::string::npos &&
              reopened_text.find("A") != std::string::npos &&
              reopened_text.find("B") != std::string::npos,
          ("multiline text survives save and reopen: " + reopened_text).c_str());
  Require(pde_close(reopened) == 1, "close reopened multiline PDF");
  const auto clear_ids = TextBlockIds(RequireResult(
      pde_describe_page(document, 0), "describe text before clearing"));
  Require(!clear_ids.empty(), "text block available for clearing");
  PdeEditCommand clear{};
  clear.type = 1;
  clear.page_id = page_id.c_str();
  clear.target_id = clear_ids[0].c_str();
  clear.end_utf16 = 5;
  clear.text_utf8 = "";
  RequireResult(pde_apply_commands(document, 4, "clear-text-block", &clear, 1),
                "empty replacement removes the real text object");
  Require(Count(RequireResult(pde_describe_page(document, 0),
                             "describe cleared text"), "\"type\":\"text\"") == 3,
          "cleared text does not leave a phantom identity");
  RequireResult(pde_undo(document), "undo cleared text");
  Require(Count(RequireResult(pde_describe_page(document, 0),
                             "describe restored text"), "\"type\":\"text\"") == 4,
          "undo restores cleared text identity");
  Require(pde_close(document) == 1, "close multiline insertion PDF");
}

void TestFontRuntime(const FontTestOptions& options) {
  if (!options.enabled()) {
    return;
  }
  const std::vector<uint8_t> ttf = ReadTestFile(options.ttf_path);
  const std::vector<uint8_t> otf = ReadTestFile(options.otf_path);
  const std::vector<uint8_t> ttc = ReadTestFile(options.ttc_path);

  const std::string ttf_faces = RequireResult(
      pde_font_faces(ttf.data(), static_cast<uint32_t>(ttf.size())),
      "inspect standalone TrueType font");
  Require(ttf_faces.find("\"index\":0") != std::string::npos &&
              ttf_faces.find("\"format\":\"ttf\"") != std::string::npos &&
              ttf_faces.find("\"editableEmbedding\":true") != std::string::npos,
          "inspect standalone TrueType face");
  const std::string otf_faces = RequireResult(
      pde_font_faces(otf.data(), static_cast<uint32_t>(otf.size())),
      "inspect OpenType CFF font");
  Require(
      otf_faces.find("\"index\":0") != std::string::npos &&
          otf_faces.find("\"format\":\"otf\"") != std::string::npos &&
          otf_faces.find("\"editableEmbedding\":true") != std::string::npos &&
          otf_faces.find("Noto") != std::string::npos,
      "inspect real Noto OpenType CFF face");
  const std::string ttc_faces = RequireResult(
      pde_font_faces(ttc.data(), static_cast<uint32_t>(ttc.size())),
      "inspect TrueType Collection");
  const std::string ttc_index = "\"index\":" + std::to_string(options.ttc_face);
  Require(ttc_faces.find(ttc_index) != std::string::npos,
          "inspect requested non-first TTC face");

  Require(pde_register_truetype_font("legacy-ttf", ttf.data(),
                                     static_cast<uint32_t>(ttf.size())) == 1,
          "legacy standalone TrueType registration");
  Require(pde_register_truetype_font("legacy-otf", otf.data(),
                                     static_cast<uint32_t>(otf.size())) == 0,
          "legacy registration rejects OpenType CFF");
  Require(pde_register_truetype_font("legacy-ttc", ttc.data(),
                                     static_cast<uint32_t>(ttc.size())) == 0,
          "legacy registration rejects collections");
  Require(pde_register_font("runtime-ttc-zero", ttc.data(),
                            static_cast<uint32_t>(ttc.size()), 0) != nullptr,
          "generic registration accepts collection face zero");
  Require(pde_register_truetype_font("runtime-ttc-zero", ttc.data(),
                                     static_cast<uint32_t>(ttc.size())) == 0,
          "legacy registration still rejects an idempotent TTC face zero");

  const std::string ttf_info = RequireResult(
      pde_register_font("runtime-ttf", ttf.data(),
                        static_cast<uint32_t>(ttf.size()), 0),
      "register standalone TrueType face");
  Require(ttf_info.find("\"id\":\"runtime-ttf\"") != std::string::npos &&
              ttf_info.find("\"faceIndex\":0") != std::string::npos &&
              ttf_info.find("\"format\":\"ttf\"") != std::string::npos &&
              ttf_info.find("\"editableEmbedding\":true") != std::string::npos,
          "register standalone TrueType face info");
  ExerciseRegisteredFont("ttf", "runtime-ttf", "TrueType ABC", false);

  const std::string otf_info = RequireResult(
      pde_register_font("runtime-otf", otf.data(),
                        static_cast<uint32_t>(otf.size()), 0),
      "register OpenType CFF face");
  Require(otf_info.find("\"id\":\"runtime-otf\"") != std::string::npos &&
              otf_info.find("\"faceIndex\":0") != std::string::npos &&
              otf_info.find("\"format\":\"otf\"") != std::string::npos &&
              otf_info.find("\"editableEmbedding\":true") != std::string::npos,
          "register OpenType CFF face info");
  TestTrackingAndParagraphFormatting("runtime-ttf");
  TestParagraphRangeStyles("runtime-otf", "runtime-ttf", ttf);
  TestParagraphJustify("runtime-ttf", "runtime-otf");
  TestParagraphEditing("runtime-otf");
  TestOcrSearchLayer("runtime-otf");
  TestOcrSearchLayer("runtime-otf", true);
  TestDocumentTools("runtime-otf");
  TestChoiceFields("runtime-otf");
  TestFormFieldAttributes("runtime-otf");
  TestDocumentTools("runtime-otf", "/MediaBox [-10 -20 300 500] /CropBox [10 20 160 220] /Rotate 90 /UserUnit 2");
  TestMultilineTextInsert("runtime-otf");
  const std::string chinese =
      "\xE4\xB8\xAD\xE6\x96\x87\xE5\xAD\x97\xE4\xBD\x93"
      "\xE6\xB5\x8B\xE8\xAF\x95 ABC";
  const std::vector<uint8_t> saved_otf =
      ExerciseRegisteredFont("otf", "runtime-otf", chinese, true);
  Require(saved_otf.size() < otf.size(),
          "editable Noto CFF is subset rather than fully embedded");

  const char* ttc_registered =
      pde_register_font("runtime-ttc", ttc.data(),
                        static_cast<uint32_t>(ttc.size()), options.ttc_face);
  Require(ttc_registered != nullptr, "register non-first TTC face");
  const std::string ttc_info(ttc_registered);
  Require(ttc_info.find("\"faceIndex\":" + std::to_string(options.ttc_face)) !=
                  std::string::npos &&
              ttc_info.find("\"editableEmbedding\":true") != std::string::npos,
          "non-first TTC registration info");
  Require(pde_register_font("runtime-ttc", ttc.data(),
                            static_cast<uint32_t>(ttc.size()), 0) == nullptr,
          "same font ID rejects a different collection face");
  Require(pde_register_font("runtime-ttc", ttc.data(),
                            static_cast<uint32_t>(ttc.size()),
                            options.ttc_face) != nullptr,
          "same font bytes and face register idempotently");
  const bool ttc_is_otf =
      ttc_info.find("\"format\":\"otf\"") != std::string::npos;
  ExerciseRegisteredFont("ttc", "runtime-ttc", "Collection face ABC",
                         ttc_is_otf);
}

#include "nested_object_test.h"
#include "text_completion_test.h"
#include "shading_test.h"
#include "page_structure_test.h"
#include "tagged_page_test.h"
#include "tagged_content_test.h"

}  // namespace

int main(int argc, char** argv) {
  const FontTestOptions font_options = ParseFontTestOptions(argc, argv);
  const std::string form_contents =
      "0 0 20 10 re f BT /F1 14 Tf 10 20 Td (Nested text) Tj ET";
  const std::string page_contents = "q 1 0 0 1 30 50 cm /Fm Do Q";
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [7 0 R] >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [10 20 210 320] "
      "/CropBox [20 40 180 280] /Rotate 90 /UserUnit 2 "
      "/Resources << /XObject << /Fm 6 0 R >> >> /Contents 4 0 R >>",
      Stream(page_contents),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      Stream(form_contents,
             "/Type /XObject /Subtype /Form /BBox [0 0 120 80] "
             "/Matrix [1 0 0 1 5 7] "
             "/Resources << /Font << /F1 5 0 R >> >>"),
      "<< /FT /Sig /T (Unsigned field) >>",
  });

  Require(pde_abi_version() == 3, "ABI version");
  Require(pde_initialize() == 1, "initialize");
  Require(pde_initialize() == 1, "idempotent initialize");

  const uint32_t document =
      pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
                      static_cast<uint32_t>(pdf.size()), "doc-memory",
                      "source-memory", nullptr);
  Require(document != 0, "open memory PDF");

  const char* info_pointer = pde_document_info(document);
  Require(info_pointer != nullptr, "document info");
  const std::string info(info_pointer);
  Require(info.find("\"id\":\"doc-memory\"") != std::string::npos,
          "caller document ID");
  Require(info.find("\"sourceIds\":[\"source-memory\"]") != std::string::npos,
          "caller source ID");
  Require(info.find("\"revision\":0,\"savedRevision\":0") != std::string::npos,
          "initial revisions");
  Require(
      info.find("\"permissions\":{\"modify\":true,\"copy\":true,"
                "\"annotate\":true,\"fillForms\":true,\"print\":true,"
                "\"encrypted\":false,\"signed\":false}") != std::string::npos,
      "unencrypted PDF grants printing and retains existing permission fields");
  if (!font_options.restricted_pdf_path.empty()) {
    TestRestrictedPrintPermission(font_options.restricted_pdf_path);
  }
  Require(info.find("\"capabilities\":[\"text.replace\",\"text.style\","
                    "\"text.insert\",\"objects.transform\",\"objects.delete\","
                    "\"pages.rotate\",\"pages.delete\",\"pages.reorder\","
                    "\"pages.insert\",\"image.insert\",\"content.insert\","
                    "\"pages.duplicate\",\"pages.import\",\"image.replace\","
                    "\"image.crop\",\"objects.copy\",\"annotation.add\",\"form.fill\",\"form.create\",\"text.reflow\",\"objects.align\",\"annotation.update\",\"annotation.delete\",\"objects.distribute\",\"pages.crop\",\"objects.group\",\"objects.ungroup\",\"form.update\"]") != std::string::npos,
          "real ABI3 editing capabilities");
  Require(std::string(pde_capabilities()).find("\"objects.copy\"") !=
              std::string::npos,
          "global capabilities expose implemented P1b commands");
  Require(pde_binary_size() == 0, "metadata clears old binary output");

  const char* page_pointer = pde_describe_page(document, 0);
  Require(page_pointer != nullptr, "describe page");
  const std::string page(page_pointer);
  Require(page.find("\"widthPt\":480") != std::string::npos,
          "CropBox Rotate UserUnit width");
  Require(page.find("\"heightPt\":320") != std::string::npos,
          "CropBox Rotate UserUnit height");
  Require(page.find("\"rotation\":90") != std::string::npos, "page rotation");
  Require(page.find("\"bounds\":{\"x\":34,\"y\":30,\"width\":20,"
                    "\"height\":40},\"transform\":[0,2,2,0,34,30]") !=
              std::string::npos,
          "CropBox Rotate UserUnit and ancestor form matrices");
  Require(page.find("\"type\":\"form\"") != std::string::npos,
          "real form object");
  Require(page.find("\"type\":\"path\"") != std::string::npos,
          "nested path object");
  Require(page.find("\"type\":\"text\"") != std::string::npos,
          "nested text object");
  Require(
      page.find("\"containerPath\":[0],\"objectIndex\":1") != std::string::npos,
      "nested form locator");
  Require(page.find("Nested text") != std::string::npos,
          "actual text object content");
  Require(Count(page, "\"editability\"") == 1,
          "one text block for one actual text object");
  Require(page.find("\"editability\":\"direct\"") != std::string::npos,
          "unmarked nested Form text is advertised as directly editable");
  Require(Count(page, "\"locator\"") == 3,
          "form and nested objects are enumerated");

  const char* extraction_pointer = pde_extract_page(document, 0);
  Require(extraction_pointer != nullptr, "extract page");
  const std::string extraction(extraction_pointer);
  Require(extraction.find("Nested text") != std::string::npos,
          "extract actual text");
  Require(Count(extraction, "\"editability\"") == 1,
          "extract one actual text block");
  const char* extraction_again_pointer = pde_extract_page(document, 0);
  Require(extraction_again_pointer != nullptr, "extract page again");
  Require(extraction == extraction_again_pointer,
          "stable page and object string IDs within a session");
  const std::vector<std::string> nested_ids = TextBlockIds(page);
  Require(nested_ids.size() == 1, "nested text block ID");
  PdeTextEdit nested_edit{0, nested_ids[0].c_str(), 0, 11, "Edited", nullptr};
  Require(pde_preview_text(document, &nested_edit) != nullptr &&
              std::string(pde_describe_page(document, 0)) == page,
          "safe nested Form text can be previewed without mutation");

  const char* render_pointer =
      pde_render(document, 0, 480, 320, 0, 0, 480, 320);
  Require(render_pointer != nullptr, "render page");
  const std::string render_metadata(render_pointer);
  Require(render_metadata ==
              "{\"width\":480,\"height\":320,\"stride\":1920,"
              "\"format\":\"rgba\",\"revision\":0}",
          "render metadata");
  Require(pde_binary_size() == 480U * 320U * 4U, "render byte size");
  const uint8_t* rgba = pde_binary_data();
  Require(rgba != nullptr, "render binary data");
  bool has_non_white_pixel = false;
  for (uint32_t offset = 0; offset < pde_binary_size(); offset += 4) {
    if (rgba[offset] != 255 || rgba[offset + 1] != 255 ||
        rgba[offset + 2] != 255) {
      has_non_white_pixel = true;
      break;
    }
  }
  Require(has_non_white_pixel, "real page pixels");
  Require(render_metadata == render_pointer,
          "binary getters preserve render metadata");

  const std::vector<uint8_t> full_pixels(rgba, rgba + pde_binary_size());
  Require(pde_render(document, 0, 460, 290, -10, -15, 480, 320) != nullptr,
          "render a viewport with negative full-page placement");
  const uint8_t* clipped = pde_binary_data();
  for (size_t row = 0; row < 290; ++row) {
    Require(std::memcmp(clipped + row * 460 * 4,
                        full_pixels.data() + (row + 15) * 480 * 4 + 10 * 4,
                        460 * 4) == 0,
            "viewport pixels match full-page crop");
  }

  const char* saved_pointer = pde_save_memory(document);
  Require(saved_pointer != nullptr, "save memory");
  Require(std::string(saved_pointer) ==
              "{\"docId\":\"doc-memory\",\"savedRevision\":0,"
              "\"kind\":\"bytes\"}",
          "save metadata");
  Require(pde_binary_size() == pdf.size(), "saved source byte size");
  Require(std::memcmp(pde_binary_data(), pdf.data(), pdf.size()) == 0,
          "memory save is byte-identical");

  static constexpr char kUnicodePath[] =
      "pde-\xE4\xB8\xAD\xE6\x96\x87-test.pdf";
  RemoveUnicodeFixture();
  Require(pde_save_file_utf8(document, kUnicodePath) == 1,
          "save UTF-8 native path");
  Require(pde_binary_size() == 0,
          "file save does not masquerade as memory save");
  Require(pde_save_file_utf8(document, kUnicodePath) == 0,
          "saving to an existing staging file must not truncate it");
  Require(pde_close(document) == 1, "close memory document");

  const uint32_t file_document =
      pde_open_file_utf8(kUnicodePath, "doc-file", "source-file", nullptr);
  Require(file_document != 0, "open UTF-8 native path");
  const char* file_saved_pointer = pde_save_memory(file_document);
  Require(file_saved_pointer != nullptr,
          "copy native source to memory on request");
  Require(pde_binary_size() == pdf.size(), "native source byte size");
  Require(std::memcmp(pde_binary_data(), pdf.data(), pdf.size()) == 0,
          "native file save is byte-identical");
  Require(pde_close(file_document) == 1, "close file document");
  Require(pde_document_info(file_document) == nullptr,
          "closed handle is invalid");
  Require(std::string(pde_error_code()) == "DOCUMENT_NOT_FOUND",
          "closed handle error code");
  Require(
      std::string(pde_error_message()).find(kUnicodePath) == std::string::npos,
      "error does not expose a file path");

  RemoveUnicodeFixture();
  TestTextTransactions();
  TestNativeLongPath();
  TestRangeFormatting();
  TestRecoveryHistory();
  TestAbi3Transactions();
  TestObjectAlignment();
  TestObjectDistribution();
  TestNestedObjectTransform();
  TestNestedTextReplacement();
  TestNestedSharedFormTextTransformAndEdit();
  if (font_options.enabled()) TestNestedTextFont(font_options.ttf_path);
  TestObjectGroup();
  TestNestedObjectCopyAndArrange();
  TestNestedPersistentGroupCopy();
  TestPageCrop();
  TestOutlineNavigation();
  TestLinkAnnotationNavigation();
  TestPageDeleteDestinationIntegrity();
  TestExtractPagesMemory();
  TestExtractPageAnnotationBacklink();
  TestExtractPagesUnsupported();
  TestAnnotationPageDuplicate();
  TestRadioFields();
  TestP1bTransactions();
  TestRegularUnderlineLifecycle();
  TestShadingPreservationAndFormEditing();
  RunAllPageStructureTests();
  TestTaggedPageStructureRoundtrip();
  TestFontRuntime(font_options);
  if (font_options.enabled()) {
    TestShapedFormText("runtime-otf");
    TestSupplementaryParagraphCopy("runtime-otf");
    RunTaggedContentTests("runtime-ttf");
  }
  pde_shutdown();
  Require(pde_binary_size() == 0, "shutdown releases result buffers");
  std::puts(
      "PASS pdf_editor_api ABI3: metadata, render, exact export, generic mixed "
      "transactions, immutable resources, stable IDs, page duplicate/import, "
      "image replace/crop, object copy, save confirmation, preview, undo, "
      "redo, range formatting, complete recovery history and failed-batch atomicity");
  std::puts(font_options.enabled()
      ? "PASS font fixtures: TTF/CFF/TTC, multiline layout, resource recovery, annotations, Unicode AcroForm appearances and save/reopen"
      : "SKIP font-dependent layout and document-tool fixtures: provide --font-ttf/--font-otf/--font-ttc");
  return 0;
}
