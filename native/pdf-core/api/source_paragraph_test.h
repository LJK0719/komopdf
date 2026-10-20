// Synthetic fixtures only: original glyph placement and font-resource identity.
struct SourceFixtureWriter : FPDF_FILEWRITE {
  std::vector<uint8_t> bytes;
  SourceFixtureWriter() {
    version = 1;
    WriteBlock = [](FPDF_FILEWRITE* base, const void* data, unsigned long size) {
      auto* self = static_cast<SourceFixtureWriter*>(base);
      const auto* begin = static_cast<const uint8_t*>(data);
      self->bytes.insert(self->bytes.end(), begin, begin + size); return 1;
    };
  }
};
void TestPlainSourceParagraphEdit() {
  const std::string source = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 18 Tf 0.6 Tc 2 Tw 20 240 Td [(Original) 20 ( text)] TJ ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"});
  const auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(source.data()), source.size(), "plain-source", "synthetic-source", nullptr);
  const auto description = RequireResult(pde_describe_page(doc, 0), "describe synthetic source");
  const auto page = PageIdFromDescription(description);
  const auto block = TextBlockIds(description).front(); const char* ids[] = {block.c_str()};
  const auto original_pixels = RenderPixels(doc, 0, 300, 300);
  Require(description.find("\"baseline\":") != std::string::npos, "source frame reports a native baseline");
  const double width = JsonNumberAfter(description, "\"frame\":{\"width\":");
  const double height = JsonNumberAfter(description, "\"height\":", Count(description.substr(0, description.find("\"frame\"")), "\"height\":"));
  const double x = JsonNumberAfter(description, "\"bounds\":{\"x\":");
  const double y = JsonNumberAfter(description, "\"y\":");
  PdeEditCommand reflow{}; reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "plain-source-paragraph";
  reflow.ids = ids; reflow.id_count = 1; reflow.text_utf8 = "Original text\nAdded line";
  reflow.flags = 2 | 1024; reflow.values[0] = x; reflow.values[1] = y;
  reflow.values[2] = width; reflow.values[3] = height + 100; reflow.values[4] = 18;
  auto invalid = reflow; invalid.flags = 1024;
  Require(pde_preview_commands(doc, 0, &invalid, 1) == nullptr && std::string(pde_error_code()) == "INVALID_REQUEST", "source-preserving reflow still requires font size");
  Require(pde_preview_commands(doc, 0, &reflow, 1) != nullptr && std::string(pde_describe_page(doc, 0)) == description,
      "fontId-omitted source reflow previews without mutating source");
  Require(pde_apply_commands(doc, 0, "plain-source-edit", &reflow, 1) != nullptr, "plain source reflow needs no default replacement font");
  auto unchanged_prefix = [&](const std::vector<uint8_t>& pixels) {
    for (size_t row = 0; row < 67; ++row) {
      Require(std::memcmp(pixels.data() + row * 300 * 4, original_pixels.data() + row * 300 * 4, 300 * 4) == 0,
          "original glyph pixels, TJ/Tc/Tw spacing and baseline remain unchanged");
    }
  };
  unchanged_prefix(RenderPixels(doc, 0, 300, 300));
  auto updated = RequireResult(pde_describe_page(doc, 0), "source paragraph result");
  const auto paragraph_block = TextBlockIds(updated).front();
  const char* paragraph_ids[] = {paragraph_block.c_str()};
  PdeEditCommand resize{}; resize.type = 29; resize.page_id = page.c_str(); resize.ids = paragraph_ids; resize.id_count = 1;
  resize.values[2] = width; resize.values[3] = height + 100;
  Require(pde_apply_commands(doc, 1, "fixed-source-frame", &resize, 1) != nullptr, "source paragraph retains fixed sizing");
  PdeEditCommand replace{}; replace.type = 1; replace.page_id = page.c_str(); replace.target_id = paragraph_block.c_str();
  replace.start_utf16 = 0; replace.end_utf16 = 24; replace.text_utf8 = "Original text\nAdded line\nAnother line"; replace.flags = 65536;
  Require(pde_apply_commands(doc, 2, "continue-source-frame", &replace, 1) != nullptr, "saved source paragraph can continue with multiline plain content");
  unchanged_prefix(RenderPixels(doc, 0, 300, 300));
  updated = RequireResult(pde_describe_page(doc, 0), "continued fixed source paragraph");
  Require(updated.find("\"fixedFrame\":true") != std::string::npos && updated.find("Another line") != std::string::npos,
      "plain source continuation retains fixed frame and logical lines");
  Require(pde_save_memory(doc) != nullptr, "save plain source paragraph");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const auto reopened = pde_open_memory(saved.data(), saved.size(), "plain-reopen", "synthetic-saved", nullptr);
  unchanged_prefix(RenderPixels(reopened, 0, 300, 300));
  Require(pde_undo(doc) != nullptr && pde_redo(doc) != nullptr, "plain source edit uses ordinary atomic undo/redo");
  pde_close(reopened); pde_close(doc);
}

void TestUnregisteredSessionFontIdentity() {
  for (const auto* prefix : {"user-font-", "system-font-"}) {
    const std::string stale_id = std::string(prefix) + "synthetic-prior-session";
    const std::string font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /KomoFontId (" + stale_id + ") >>";
    const std::string source = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        Stream("BT /F1 18 Tf 20 150 Td (AB) Tj ET"), font});
    auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(source.data()), source.size(), "stale-raw-font", "synthetic-session-font", nullptr);
    auto description = RequireResult(pde_describe_page(doc, 0), "describe stale session-font text");
    Require(description.find(stale_id) == std::string::npos && description.find("\"fontId\":\"pdf:Helvetica\"") != std::string::npos,
        "unregistered user/system raw text font exposes its actual PDF BaseFont after restart");
    pde_close(doc);
    const std::string metadata = "/KomoParagraph << /Version 2 /Text (AB) /Width 160 /Height 80 /SourceFont true "
        "/Font 5 0 R /RegisteredFontId (" + stale_id + ") /FontSize 18 /LineHeight 1.2 "
        "/StyleRuns [<< /Start 0 /End 2 /Font 5 0 R /SourceFont true /RegisteredFontId (" + stale_id + ") /FontSize 18 >>] >>";
    const std::string paragraph = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Fm 6 0 R >> >> /Contents 4 0 R >>",
        Stream("q 1 0 0 1 20 80 cm /Fm Do Q"), font,
        Stream("BT /F1 18 Tf 0 60 Td (AB) Tj ET", "/Type /XObject /Subtype /Form /BBox [0 0 160 80] /Resources << /Font << /F1 5 0 R >> >> " + metadata)});
    doc = pde_open_memory(reinterpret_cast<const uint8_t*>(paragraph.data()), paragraph.size(), "stale-paragraph-font", "synthetic-session-paragraph", nullptr);
    description = RequireResult(pde_describe_page(doc, 0), "describe stale session-font paragraph");
    Require(description.find(stale_id) == std::string::npos && description.find("\"fontId\":\"pdf:Helvetica\"") != std::string::npos &&
        description.find("\"isParagraph\":true") != std::string::npos,
        "saved paragraph and style runs resolve stale user/system identity from their Font dictionary");
    pde_close(doc);
  }
}

void TestScaledAndNegativeBearingSourceParagraph() {
  for (const bool italic : {false, true}) {
    const double scale = italic ? 1 : 2;
    const std::string value = italic ? "jazz text" : "Original text";
    const std::string source = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        Stream("BT /F1 10 Tf 0.3 Tc " + std::string(italic ? "1 0 0 1" : "2 0 0 2") + " 40 220 Tm (" + value + ") Tj ET"),
        std::string("<< /Type /Font /Subtype /Type1 /BaseFont /") + (italic ? "Helvetica-Oblique" : "Helvetica") + " >>"});
    const auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(source.data()), source.size(), italic ? "bearing-source" : "scale-source", "synthetic-transform", nullptr);
    const auto before = RequireResult(pde_describe_page(doc, 0), "describe transformed source");
    const auto page = PageIdFromDescription(before), block = TextBlockIds(before).front(); const char* ids[] = {block.c_str()};
    const auto pixels = RenderPixels(doc, 0, 300, 300);
    if (italic) {
      auto external = FPDF_LoadMemDocument64(reinterpret_cast<const uint8_t*>(source.data()), source.size(), nullptr);
      auto loaded = FPDF_LoadPage(external, 0);
      auto clone = CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(loaded, 0))->AsText()->Clone();
      clone->SetTextMatrix(CFX_Matrix());
      Require(clone->GetRect().left < 0, "negative left-bearing fixture really extends before its text origin");
      FPDF_ClosePage(loaded); FPDF_CloseDocument(external);
    }
    PdeEditCommand reflow{}; reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "transform-source-paragraph";
    reflow.ids = ids; reflow.id_count = 1; reflow.text_utf8 = value.c_str(); reflow.flags = 2 | 1024;
    reflow.values[0] = JsonNumberAfter(before, "\"bounds\":{\"x\":"); reflow.values[1] = JsonNumberAfter(before, "\"y\":");
    reflow.values[2] = JsonNumberAfter(before, "\"frame\":{\"width\":") * scale;
    reflow.values[3] = 100; reflow.values[4] = 10 * scale;
    Require(pde_apply_commands(doc, 0, "preserve-source-transform", &reflow, 1) != nullptr,
        "plain source reflow preserves the source matrix rather than baking in an identity transform");
    Require(RenderPixels(doc, 0, 300, 300) == pixels, "scale2 and negative bearing no-op materialization retain exact source pixels");
    const auto result = RequireResult(pde_describe_page(doc, 0), "describe preserved source transform");
    if (!italic) Require(result.find("\"fixedFrame\":true") != std::string::npos,
        "scaled source paragraph uses the existing fixed-frame flow boundary");
    const auto paragraph_block = TextBlockIds(result).front();
    const std::string continued = value + "\nNext line";
    PdeEditCommand replace{}; replace.type = 1; replace.page_id = page.c_str(); replace.target_id = paragraph_block.c_str();
    replace.start_utf16 = 0; replace.end_utf16 = static_cast<uint32_t>(value.size()); replace.text_utf8 = continued.c_str(); replace.flags = 65536;
    Require(pde_apply_commands(doc, 1, "continue-transformed-source", &replace, 1) != nullptr,
        "scaled and negative-bearing source paragraphs continue without losing their original placement");
    const auto appended = RenderPixels(doc, 0, 300, 300);
    Require(std::memcmp(appended.data(), pixels.data(), 81 * 300 * 4) == 0,
        "appending a line keeps the unchanged transformed first-line pixels");
    Require(pde_save_memory(doc) != nullptr, "save transformed source paragraph");
    const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
    const auto reopened = pde_open_memory(saved.data(), saved.size(), "transformed-reopen", "transformed-saved", nullptr);
    Require(RenderPixels(reopened, 0, 300, 300) == appended, "scaled and negative-bearing source paragraph pixels survive save/reopen");
    pde_close(reopened); pde_close(doc);
  }
}

void TestSourceParagraphGapsAndFlow() {
  const std::string source = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 160] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 18 Tf 20 125 Td [(Alpha) -350 (Beta) -350 (Gamma)] TJ ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"});
  const auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(source.data()), source.size(), "gapped-source", "synthetic-gapped", nullptr);
  const auto before = RequireResult(pde_describe_page(doc, 0), "describe gapped source");
  const auto page = PageIdFromDescription(before), block = TextBlockIds(before).front(); const char* ids[] = {block.c_str()};
  Require(before.find("\"inferredSpaces\":[5,9]") != std::string::npos, "fixture has inferred source TJ spaces");
  PdeEditCommand reflow{}; reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "gapped-paragraph";
  reflow.ids = ids; reflow.id_count = 1; reflow.text_utf8 = "Alpha Beta Gamma\nAdded"; reflow.flags = 2 | 1024;
  reflow.values[0] = JsonNumberAfter(before, "\"bounds\":{\"x\":"); reflow.values[1] = JsonNumberAfter(before, "\"y\":");
  reflow.values[2] = 190; reflow.values[3] = 80; reflow.values[4] = 18;
  const auto original = RenderPixels(doc, 0, 240, 160);
  Require(pde_apply_commands(doc, 0, "gapped-reflow", &reflow, 1) != nullptr, "source reflow retains inferred spaces without encoding missing subset space");
  const auto gapped = RenderPixels(doc, 0, 240, 160);
  Require(std::memcmp(original.data(), gapped.data(), 42 * 240 * 4) == 0, "inferred TJ spaces keep original source glyph placement");
  const auto paragraph_block = TextBlockIds(pde_describe_page(doc, 0)).front();
  std::string continued = "Alpha Beta Gamma\nAdded";
  for (int i = 0; i < 24; ++i) continued += "\nAdded line";
  PdeEditCommand replace{}; replace.type = 1; replace.page_id = page.c_str(); replace.target_id = paragraph_block.c_str();
  replace.start_utf16 = 0; replace.end_utf16 = 22; replace.text_utf8 = continued.c_str(); replace.flags = 65536;
  Require(pde_apply_commands(doc, 1, "source-flow", &replace, 1) != nullptr && pde_save_memory(doc) != nullptr,
      "plain source paragraph continues across pages using original font");
  std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  auto external = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
  Require(FPDF_GetPageCount(external) > 1, "source flow produces multiple fragments");
  std::string joined; uint32_t shared_flow = 0;
  for (int p = 0; p < FPDF_GetPageCount(external); ++p) {
    auto loaded = FPDF_LoadPage(external, p);
    for (int i = 0; i < FPDFPage_CountObjects(loaded); ++i) {
      auto* object = CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(loaded, i));
      if (!object->AsForm()) continue;
      auto info = object->AsForm()->form()->GetDict()->GetDictFor("KomoParagraph"); if (!info) continue;
      const auto raw = info->GetUnicodeTextFor("Text").ToUTF8(); joined.append(raw.c_str(), raw.GetLength());
      const auto flow = info->GetDictFor("Flow"); Require(flow && flow->GetObjNum(), "source paragraph uses existing shared Flow contract");
      if (!shared_flow) shared_flow = flow->GetObjNum(); Require(shared_flow == flow->GetObjNum(), "source fragments share one Flow dictionary");
      Require(info->GetBooleanFor("SourceFont", false), "continued fragments retain source-font metadata");
    }
    FPDF_ClosePage(loaded);
  }
  FPDF_CloseDocument(external);
  Require(joined == continued, "source flow preserves every logical character once");
  const auto reopened = pde_open_memory(bytes.data(), bytes.size(), "source-flow-reopen", "source-flow-saved", nullptr);
  const auto reopened_page = PageIdFromDescription(pde_describe_page(reopened, 0)), reopened_block = TextBlockIds(pde_describe_page(reopened, 0)).front();
  replace.page_id = reopened_page.c_str(); replace.target_id = reopened_block.c_str(); replace.start_utf16 = 0;
  replace.end_utf16 = static_cast<uint32_t>(continued.size()); replace.text_utf8 = "Alpha Beta Gamma\nAdded";
  Require(pde_apply_commands(reopened, 0, "shrink-source-flow", &replace, 1) != nullptr,
      "reopened source Flow remains editable with retained glyphs");
  const auto shortened = RenderPixels(reopened, 0, 240, 160);
  Require(std::memcmp(original.data(), shortened.data(), 42 * 240 * 4) == 0, "source flow roundtrip keeps original inferred TJ spacing");
  Require(pde_undo(reopened) != nullptr && pde_redo(reopened) != nullptr, "source flow replacement is atomic undo/redo");
  pde_close(reopened); pde_close(doc);
}

void TestSourceParagraphRangeStyles() {
  for (const bool flow : {false, true}) {
    const std::string source = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        Stream("BT /F1 18 Tf 0.6 Tc 2 Tw 20 150 Td [(Original) 20 ( text)] TJ ET"),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"});
    const auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(source.data()), source.size(), "source-range-style", "synthetic-source-style", nullptr);
    const auto before = RequireResult(pde_describe_page(doc, 0), "describe source style fixture");
    const auto page = PageIdFromDescription(before), block = TextBlockIds(before).front(); const char* ids[] = {block.c_str()};
    const auto original_pixels = RenderPixels(doc, 0, 300, 200);
    std::string text = "Original text\nTail";
    if (flow) for (int i = 0; i < 24; ++i) text += "\nTail";
    PdeEditCommand reflow{}; reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "source-style-paragraph";
    reflow.ids = ids; reflow.id_count = 1; reflow.text_utf8 = text.c_str(); reflow.flags = 2 | 1024;
    reflow.values[0] = JsonNumberAfter(before, "\"bounds\":{\"x\":"); reflow.values[1] = JsonNumberAfter(before, "\"y\":");
    reflow.values[2] = 260; reflow.values[3] = 100; reflow.values[4] = 18;
    Require(pde_apply_commands(doc, 0, "materialize-range-style", &reflow, 1) != nullptr, "materialize source style fixture");
    const auto described = RequireResult(pde_describe_page(doc, 0), "describe materialized style fixture");
    const auto paragraph_block = TextBlockIds(described).front(); const char* paragraph_ids[] = {paragraph_block.c_str()};
    PdeEditCommand style{}; style.type = 2; style.page_id = page.c_str(); style.ids = paragraph_ids; style.id_count = 1;
    style.start_utf16 = 14; style.end_utf16 = 18;
    uint32_t revision = 1;
    for (const uint32_t flag : {2U, 8U, 4U, 32U}) {
      style.flags = 16 | flag;
      style.values[0] = 20; style.values[1] = 0.8; style.values[2] = 0.1; style.values[3] = 0.2;
      style.values[4] = 1.2; style.values[5] = 1;
      const auto prior = RenderPixels(doc, 0, 300, 200);
      const std::string transaction = "local-source-style-" + std::to_string(flag);
      Require(pde_apply_commands(doc, revision++, transaction.c_str(), &style, 1) != nullptr,
          "local size, tracking, color and underline edit succeeds for source and flow paragraphs");
      const auto styled = RenderPixels(doc, 0, 300, 200);
      Require(styled != prior, "requested local source formatting changes visible pixels");
      Require(std::memcmp(original_pixels.data(), styled.data(), 55 * 300 * 4) == 0,
          "local style preserves untouched first-line glyphs, TJ/Tc/Tw spacing and baseline, including flow");
    }
    const auto styled = RenderPixels(doc, 0, 300, 200);
    Require(pde_save_memory(doc) != nullptr, "save source range styles");
    const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
    const auto reopened = pde_open_memory(saved.data(), saved.size(), "source-range-reopen", "synthetic-styled-source", nullptr);
    Require(RenderPixels(reopened, 0, 300, 200) == styled, "source range formatting and untouched pixels survive save/reopen");
    Require(pde_undo(doc) != nullptr && pde_redo(doc) != nullptr && RenderPixels(doc, 0, 300, 200) == styled,
        "source range styles remain ordinary atomic undo/redo transactions");
    if (flow) Require(pde_describe_page(doc, 1) != nullptr, "range style fixture really spans pages");
    pde_close(reopened); pde_close(doc);
  }
}

void TestSourceReplacementInitialStyles(const std::string& regular_path, const std::string& bold_path) {
  const auto regular = ReadTestFile(regular_path), bold = ReadTestFile(bold_path);
  Require(pde_register_font("source-explicit-regular", regular.data(), regular.size(), 0) != nullptr &&
      pde_register_font("source-explicit-bold", bold.data(), bold.size(), 0) != nullptr, "register explicit insertion font faces");
  const std::string source = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 18 Tf 0.6 Tc 2 Tw 20 150 Td [(Original) 20 ( text)] TJ ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"});
  const auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(source.data()), source.size(), "source-initial-styles", "synthetic-initial-styles", nullptr);
  const auto before = RequireResult(pde_describe_page(doc, 0), "describe initial style fixture");
  const auto page = PageIdFromDescription(before), block = TextBlockIds(before).front(); const char* ids[] = {block.c_str()};
  const auto original_pixels = RenderPixels(doc, 0, 300, 200);
  PdeEditCommand commands[4]{};
  auto& reflow = commands[0]; reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "initial-style-paragraph";
  reflow.ids = ids; reflow.id_count = 1; reflow.text_utf8 = "Original text"; reflow.flags = 2 | 1024 | 65536;
  reflow.values[0] = JsonNumberAfter(before, "\"bounds\":{\"x\":"); reflow.values[1] = JsonNumberAfter(before, "\"y\":");
  reflow.values[2] = 260; reflow.values[3] = 100; reflow.values[4] = 18;
  auto& replace = commands[1]; replace.type = 1; replace.page_id = page.c_str(); replace.target_id = "initial-style-paragraph:text";
  replace.start_utf16 = 0; replace.end_utf16 = 13; replace.text_utf8 = "Original text\n\xC4\x80\xC5\x90"; replace.flags = 65536;
  const char* paragraph_ids[] = {"initial-style-paragraph:text"};
  for (size_t i = 2; i < 4; ++i) {
    auto& style = commands[i]; style.type = 2; style.page_id = page.c_str(); style.ids = paragraph_ids; style.id_count = 1;
    style.flags = 1 | 16; style.start_utf16 = static_cast<uint32_t>(12 + i); style.end_utf16 = style.start_utf16 + 1;
    style.font_id = i == 2 ? "source-explicit-regular" : "source-explicit-bold";
  }
  Require(pde_preview_commands(doc, 0, commands, 2) == nullptr && std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
      std::string(pde_describe_page(doc, 0)) == before, "uncovered added source glyph is still rejected atomically");
  Require(pde_preview_commands(doc, 0, commands, 4) != nullptr && std::string(pde_describe_page(doc, 0)) == before,
      "replacement preview sees all adjacent explicit font ranges before subset completion");
  Require(pde_apply_commands(doc, 0, "materialize-replace-mixed-style", commands, 4) != nullptr,
      "source materialization, replacement and two explicit new fonts commit in one transaction");
  const auto result = RequireResult(pde_describe_page(doc, 0), "describe initial style result");
  Require(result.find("source-explicit-regular") != std::string::npos && result.find("source-explicit-bold") != std::string::npos,
      "both explicit insertion fonts are retained as style runs");
  const auto mixed_pixels = RenderPixels(doc, 0, 300, 200);
  Require(std::memcmp(original_pixels.data(), mixed_pixels.data(), 55 * 300 * 4) == 0,
      "mixed-font insertion preserves every unchanged source glyph and source spacing");
  PdeEditCommand style = commands[3]; style.start_utf16 = 9; style.end_utf16 = 13;
  Require(pde_apply_commands(doc, 1, "bold-local-source-word", &style, 1) != nullptr, "local source font change preserves all other source runs");
  PdeEditCommand append = replace; append.start_utf16 = 16; append.end_utf16 = 16; append.text_utf8 = "Z"; append.font_id = "source-explicit-bold";
  Require(pde_apply_commands(doc, 2, "type-after-local-bold", &append, 1) != nullptr, "typing continues after a local source bold edit");
  Require(pde_save_memory(doc) != nullptr, "save source paragraph after mixed-font insertion and continued typing");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const auto reopened = pde_open_memory(saved.data(), saved.size(), "mixed-source-reopen", "synthetic-mixed-source", nullptr);
  Require(RenderPixels(reopened, 0, 300, 200) == RenderPixels(doc, 0, 300, 200), "mixed source fonts and local bold survive save/reopen");
  const auto reopened_description = RequireResult(pde_describe_page(reopened, 0), "describe reopened mixed source");
  const auto reopened_page = PageIdFromDescription(reopened_description), reopened_block = TextBlockIds(reopened_description).front();
  const char* reopened_ids[] = {reopened_block.c_str()};
  PdeEditCommand continued[3] = {replace, commands[2], commands[3]};
  continued[0].page_id = reopened_page.c_str(); continued[0].target_id = reopened_block.c_str();
  continued[0].start_utf16 = 17; continued[0].end_utf16 = 17; continued[0].text_utf8 = "\xC4\x92\xC5\xB0";
  for (size_t i = 1; i < 3; ++i) {
    continued[i].page_id = reopened_page.c_str(); continued[i].ids = reopened_ids;
    continued[i].start_utf16 = static_cast<uint32_t>(16 + i); continued[i].end_utf16 = continued[i].start_utf16 + 1;
  }
  Require(pde_apply_commands(reopened, 0, "reuse-explicit-source-font-faces", continued, 3) != nullptr,
      "explicit styles use registered full faces instead of saved subsets with the same font IDs");
  Require(pde_undo(doc) != nullptr && pde_undo(doc) != nullptr && pde_undo(doc) != nullptr &&
      std::string(pde_describe_page(doc, 0)) == before && pde_redo(doc) != nullptr && RenderPixels(doc, 0, 300, 200) == mixed_pixels,
      "materialize, replace and explicit fonts are one atomic undo/redo step");
  pde_close(reopened); pde_close(doc);
}

void TestSubsetSourceParagraphEdit(const std::string& path) {
  const auto font_bytes = ReadTestFile(path);
  Require(pde_register_font("source-completion", font_bytes.data(), font_bytes.size(), 0) != nullptr,
      "register exact full source family for subset completion");
  const std::string empty = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R >>", Stream("")});
  const auto seed = pde_open_memory(reinterpret_cast<const uint8_t*>(empty.data()), empty.size(), "subset-seed", "synthetic-empty", nullptr);
  const auto seed_page = PageIdFromDescription(pde_describe_page(seed, 0));
  PdeEditCommand insert{}; insert.type = 3; insert.page_id = seed_page.c_str(); insert.target_id = "subset-origin";
  insert.text_utf8 = "AB BA"; insert.font_id = "source-completion"; insert.flags = 3 | 1024;
  insert.values[0] = 20; insert.values[1] = 20; insert.values[2] = 200; insert.values[3] = 90; insert.values[4] = 18;
  Require(pde_apply_commands(seed, 0, "make-subset", &insert, 1) != nullptr && pde_save_memory(seed) != nullptr, "make a non-sensitive embedded subset");
  std::vector<uint8_t> seed_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  auto external = FPDF_LoadMemDocument64(seed_bytes.data(), seed_bytes.size(), nullptr);
  auto external_page = FPDF_LoadPage(external, 0);
  auto* paragraph = CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(external_page, 0))->AsForm()->form();
  auto metadata = paragraph->GetMutableDict()->GetMutableDictFor("KomoParagraph");
  metadata->SetNewFor<CPDF_Boolean>("SourceFont", true);
  auto* source_font = paragraph->GetPageObjectByIndex(0)->AsText()->GetFont().Get();
  Require(source_font->UnicodeFromCharCode(source_font->CharCodeFromUnicode(L'Z')) != L"Z",
      "synthetic subset really lacks the added Unicode character");
  const uint32_t original_font = source_font->GetFontDictObjNum();
  SourceFixtureWriter writer; Require(FPDF_SaveAsCopy(external, &writer, 0), "save source-font subset fixture");
  FPDF_ClosePage(external_page); FPDF_CloseDocument(external); pde_close(seed);
  const auto doc = pde_open_memory(writer.bytes.data(), writer.bytes.size(), "subset-source", "synthetic-subset", nullptr);
  const auto page = PageIdFromDescription(pde_describe_page(doc, 0));
  const auto block = TextBlockIds(pde_describe_page(doc, 0)).front();
  PdeEditCommand replace{}; replace.type = 1; replace.page_id = page.c_str(); replace.target_id = block.c_str();
  replace.start_utf16 = 0; replace.end_utf16 = 5; replace.text_utf8 = "AB BAZ"; replace.flags = 65536;
  const auto before = RequireResult(pde_describe_page(doc, 0), "describe subset before edit");
  Require(pde_preview_commands(doc, 0, &replace, 1) == nullptr && std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
      std::string(pde_describe_page(doc, 0)) == before, "missing subset glyph fails atomically rather than defaulting to Noto");
  replace.font_id = "source-completion";
  Require(pde_apply_commands(doc, 0, "subset-complete", &replace, 1) != nullptr && pde_save_memory(doc) != nullptr,
      "only missing added glyph uses the registered same-family full font");
  std::vector<uint8_t> completed(pde_binary_data(), pde_binary_data() + pde_binary_size());
  external = FPDF_LoadMemDocument64(completed.data(), completed.size(), nullptr); external_page = FPDF_LoadPage(external, 0);
  paragraph = CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(external_page, 0))->AsForm()->form();
  size_t unchanged = 0, added = 0;
  for (const auto& child : *paragraph) {
    auto* text = child->AsText(); if (!text) continue;
    const auto unicode = text->GetFont()->UnicodeFromCharCode(text->GetCharCode(0)).ToUTF8();
    if (unicode == "Z") { ++added; Require(text->GetFont()->GetFontDictObjNum() != original_font, "added glyph has a separate completion resource"); }
    else { ++unchanged; Require(text->GetFont()->GetFontDictObjNum() == original_font, "all unchanged subset glyphs keep the original font resource"); }
  }
  Require(unchanged == 5 && added == 1, "subset completion never rewrites the old full text with the supplied font");
  FPDF_ClosePage(external_page); FPDF_CloseDocument(external);
  const auto reopened = pde_open_memory(completed.data(), completed.size(), "subset-reopen", "subset-completed", nullptr);
  const auto reopened_page = PageIdFromDescription(pde_describe_page(reopened, 0));
  const auto reopened_block = TextBlockIds(pde_describe_page(reopened, 0)).front();
  replace.page_id = reopened_page.c_str(); replace.target_id = reopened_block.c_str(); replace.start_utf16 = 6; replace.end_utf16 = 6;
  replace.text_utf8 = "Z\nAB"; replace.font_id = nullptr;
  Require(pde_apply_commands(reopened, 0, "subset-continue", &replace, 1) != nullptr,
      "reopened mixed source and completion paragraph continues in its last source font");
  Require(pde_undo(doc) != nullptr && pde_redo(doc) != nullptr, "subset completion remains one undoable transaction");
  pde_close(reopened); pde_close(doc);

  const std::string standard = Pdf({"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 18 Tf 20 150 Td (AB) Tj ET"), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"});
  const auto explicit_doc = pde_open_memory(reinterpret_cast<const uint8_t*>(standard.data()), standard.size(), "explicit-source", "synthetic-explicit", nullptr);
  const auto explicit_page = PageIdFromDescription(pde_describe_page(explicit_doc, 0)), source_block = TextBlockIds(pde_describe_page(explicit_doc, 0)).front();
  const char* source_ids[] = {source_block.c_str()};
  PdeEditCommand reflow{}; reflow.type = 20; reflow.page_id = explicit_page.c_str(); reflow.target_id = "explicit-source-paragraph";
  reflow.ids = source_ids; reflow.id_count = 1; reflow.text_utf8 = "AB"; reflow.flags = 2 | 1024;
  reflow.values[0] = 20; reflow.values[1] = 35; reflow.values[2] = 160; reflow.values[3] = 90; reflow.values[4] = 18;
  Require(pde_apply_commands(explicit_doc, 0, "materialize-explicit-source", &reflow, 1) != nullptr, "create source paragraph for explicit font semantics");
  const auto explicit_block = TextBlockIds(pde_describe_page(explicit_doc, 0)).front();
  replace = {}; replace.type = 1; replace.page_id = explicit_page.c_str(); replace.target_id = explicit_block.c_str();
  replace.start_utf16 = 2; replace.end_utf16 = 2; replace.text_utf8 = "\xC4\x80"; replace.font_id = "source-completion"; replace.flags = 65536;
  const auto explicit_before = RequireResult(pde_describe_page(explicit_doc, 0), "describe source before mismatched supplement");
  Require(pde_preview_commands(explicit_doc, 1, &replace, 1) == nullptr && std::string(pde_error_code()) == "UNSUPPORTED_CAPABILITY" &&
      std::string(pde_describe_page(explicit_doc, 0)) == explicit_before, "preserveSource rejects a different-family supplement atomically");
  replace.flags = 0;
  Require(pde_apply_commands(explicit_doc, 1, "explicit-different-family-insertion", &replace, 1) != nullptr,
      "fontId without preserveSource retains explicit different-font insertion semantics");
  const char* explicit_ids[] = {explicit_block.c_str()};
  reflow.ids = explicit_ids; reflow.target_id = "explicit-whole-font"; reflow.font_id = "source-completion";
  reflow.text_utf8 = "AB\xC4\x80"; reflow.flags = 3 | 1024;
  Require(pde_apply_commands(explicit_doc, 2, "explicit-whole-font-reflow", &reflow, 1) != nullptr && pde_save_memory(explicit_doc) != nullptr,
      "fontId without preserveSource retains explicit whole-font reflow semantics");
  external = FPDF_LoadMemDocument64(pde_binary_data(), pde_binary_size(), nullptr); external_page = FPDF_LoadPage(external, 0);
  paragraph = CPDFPageObjectFromFPDFPageObject(FPDFPage_GetObject(external_page, 0))->AsForm()->form();
  Require(!paragraph->GetDict()->GetDictFor("KomoParagraph")->GetBooleanFor("SourceFont", false), "explicit whole-font reflow does not falsely retain source-font mode");
  FPDF_ClosePage(external_page); FPDF_CloseDocument(external); pde_close(explicit_doc);
}
