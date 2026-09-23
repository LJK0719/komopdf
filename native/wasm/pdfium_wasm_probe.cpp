#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "public/fpdf_edit.h"
#include "public/fpdf_save.h"
#include "public/fpdfview.h"

namespace {

struct VectorWriter {
  FPDF_FILEWRITE base;
  std::vector<uint8_t> bytes;
};

int WriteBlock(FPDF_FILEWRITE* self, const void* data, unsigned long size) {
  auto* writer = reinterpret_cast<VectorWriter*>(self);
  const auto* first = static_cast<const uint8_t*>(data);
  writer->bytes.insert(writer->bytes.end(), first, first + size);
  return 1;
}

}  // namespace

int main() {
  FPDF_InitLibrary();

  FPDF_DOCUMENT document = FPDF_CreateNewDocument();
  if (!document) {
    std::puts("pdfium_wasm_probe:create-document-failed");
    FPDF_DestroyLibrary();
    return 1;
  }

  FPDF_PAGE page = FPDFPage_New(document, 0, 72.0, 72.0);
  if (!page) {
    std::puts("pdfium_wasm_probe:create-page-failed");
    FPDF_CloseDocument(document);
    FPDF_DestroyLibrary();
    return 2;
  }
  FPDF_ClosePage(page);

  VectorWriter writer{{1, WriteBlock}, {}};
  if (!FPDF_SaveAsCopy(document, &writer.base, FPDF_NO_INCREMENTAL)) {
    std::puts("pdfium_wasm_probe:save-failed");
    FPDF_CloseDocument(document);
    FPDF_DestroyLibrary();
    return 3;
  }
  FPDF_CloseDocument(document);

  FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(
      writer.bytes.data(), writer.bytes.size(), nullptr);
  if (!reopened) {
    std::puts("pdfium_wasm_probe:reopen-failed");
    FPDF_DestroyLibrary();
    return 4;
  }

  const int pages = FPDF_GetPageCount(reopened);
  FPDF_CloseDocument(reopened);
  FPDF_DestroyLibrary();
  if (pages != 1) {
    std::printf("pdfium_wasm_probe:wrong-page-count=%d\n", pages);
    return 5;
  }

  std::printf("pdfium_wasm_probe:ok bytes=%zu pages=%d\n",
              writer.bytes.size(), pages);
  return 0;
}
