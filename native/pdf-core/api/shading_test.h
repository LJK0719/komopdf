// Included by the C API test so the existing PDF fixtures and assertions are shared.
void TestShadingPreservationAndFormEditing() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Fm 6 0 R >> /Shading << /ShPage 7 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      Stream("q 1 0 0 1 10 10 cm /Fm Do Q q 1 0 0 1 160 20 cm 0 0 100 100 re W n /ShPage sh Q"),
      Stream("q 0 0 100 100 re W n /ShForm sh Q "
             "BT /F1 12 Tf 10 120 Td (Nested text) Tj ET",
             "/Type /XObject /Subtype /Form /BBox [0 0 200 200] "
             "/Resources << /Shading << /ShForm 7 0 R >> /Font << /F1 4 0 R >> >>"),
      "<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] "
      "/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> "
      "/Extend [true true] >>",
  });
  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "shading-fixture",
      "shading-source", nullptr);
  Require(doc != 0, "open shading fixture document");
  const std::string before =
      RequireResult(pde_describe_page(doc, 0), "describe shading source");
  const std::string page = PageIdFromDescription(before);

  std::vector<std::string> shadings;
  size_t cursor = 0;
  while ((cursor = before.find("\"type\":\"shading\"", cursor)) !=
         std::string::npos) {
    shadings.push_back(JsonStringAfter(before, "{\"id\":\"",
                                       before.rfind("{\"id\":\"", cursor)));
    ++cursor;
  }
  Require(shadings.size() >= 2,
          "fixture has both page-level and nested Form shading objects");

  const auto baseline = RenderPixels(doc, 0, 300, 300);
  bool has_visible_pixels = false;
  for (uint8_t byte : baseline) {
    if (byte != 0) {
      has_visible_pixels = true;
      break;
    }
  }
  Require(has_visible_pixels, "gradient renders non-empty pixels");

  // 1. Transform: move the top-level shading object with kObjectsTransform.
  const char* target_shading[] = {shadings.back().c_str()};
  PdeEditCommand transform_cmd{};
  transform_cmd.type = 4;
  transform_cmd.page_id = page.c_str();
  transform_cmd.ids = target_shading;
  transform_cmd.id_count = 1;
  transform_cmd.values[0] = 1;
  transform_cmd.values[3] = 1;
  transform_cmd.values[4] = 20;
  transform_cmd.values[5] = 20;
  Require(pde_apply_commands(doc, pde_document_revision(doc),
                             "transform-shading", &transform_cmd, 1) != nullptr,
          "transform native gradient object");
  const auto transformed_pixels = RenderPixels(doc, 0, 300, 300);
  Require(transformed_pixels != baseline,
          "transformed gradient changes rendered pixel output");

  // 2. Copy: clone the top-level shading object with kObjectsCopy.
  const char* copy_pair[] = {shadings.back().c_str(), "copied-shading-1"};
  PdeEditCommand copy_cmd{};
  copy_cmd.type = 16;
  copy_cmd.page_id = page.c_str();
  copy_cmd.ids = copy_pair;
  copy_cmd.id_count = 2;
  copy_cmd.values[0] = -30;
  copy_cmd.values[1] = 30;
  Require(pde_apply_commands(doc, pde_document_revision(doc),
                             "copy-shading", &copy_cmd, 1) != nullptr,
          "copy native gradient object");
  const std::string after_copy =
      RequireResult(pde_describe_page(doc, 0), "describe page after copy");
  Require(after_copy.find("copied-shading-1") != std::string::npos,
          "copied shading object exists in page description");
  const auto copied_pixels = RenderPixels(doc, 0, 300, 300);
  Require(copied_pixels != transformed_pixels,
          "copied gradient renders to new position");

  // 3. Nested text edit: edit text inside Form containing shading.
  // GenerateFormContentForEditing will rewrite the Form stream; verify shading is preserved.
  const auto block_ids = TextBlockIds(after_copy);
  Require(!block_ids.empty(), "nested text block found inside Form");
  PdeTextEdit text_edit{0, block_ids[0].c_str(), 0, 11, "Changed text", nullptr};
  Require(pde_apply_text(doc, pde_document_revision(doc),
                         "edit-form-text", &text_edit, 1) != nullptr,
          "edit text within Form containing shading object");
  const std::string after_text_edit =
      RequireResult(pde_describe_page(doc, 0), "describe after text edit");
  Require(after_text_edit.find("Changed text") != std::string::npos,
          "nested text replacement reflected in page description");
  Require(after_text_edit.find("\"type\":\"shading\"") != std::string::npos,
          "shading objects remain active in Form after stream regeneration");
  const auto after_edit_pixels = RenderPixels(doc, 0, 300, 300);
  bool gradient_still_visible = false;
  for (size_t y = 210; y < 280; ++y) {
    for (size_t x = 20; x < 100; ++x) {
      const size_t i = (y * 300 + x) * 4;
      Require(std::equal(after_edit_pixels.begin() + i, after_edit_pixels.begin() + i + 4,
                         copied_pixels.begin() + i),
              "nested gradient pixels are unchanged by editing the separate text");
      if (after_edit_pixels[i] > after_edit_pixels[i + 1] + 20 ||
          after_edit_pixels[i + 2] > after_edit_pixels[i + 1] + 20) gradient_still_visible = true;
    }
  }
  Require(gradient_still_visible, "the retained nested region contains color, not blank white pixels");

  // 4. Save and reopen: verify serialization and resource dictionary retention.
  Require(pde_save_memory(doc) != nullptr, "save document with shading objects");
  const std::vector<uint8_t> saved(
      pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()),
      "shading-reopened", "saved-shading", nullptr);
  Require(reopened != 0, "reopen document with serialized shading");
  const std::string restored =
      RequireResult(pde_describe_page(reopened, 0), "describe reopened page");
  Require(restored.find("\"type\":\"shading\"") != std::string::npos,
          "shading objects survive save and reopen");
  Require(restored.find("Changed text") != std::string::npos,
          "edited text in Form survives save and reopen");
  Require(RenderPixels(reopened, 0, 300, 300) == after_edit_pixels,
          "rendered pixels match exactly after save and reopen");

  Require(pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close shading test documents");
}
