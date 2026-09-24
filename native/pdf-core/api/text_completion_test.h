void TestRegularUnderlineLifecycle() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("BT /F1 18 Tf 30 120 Td (Underline text) Tj ET"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "underline-doc", "underline-source", nullptr);
  Require(doc != 0, "open ordinary text underline fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "ordinary text source");
  const std::string page = PageIdFromDescription(before);
  const std::string block = TextBlockIds(before).front();
  const std::string object = FirstObjectId(before);
  const auto plain = RenderPixels(doc, 0, 300, 200);
  const char* blocks[] = {block.c_str()};
  PdeEditCommand style{};
  style.type = 2; style.page_id = page.c_str(); style.ids = blocks; style.id_count = 1;
  style.flags = 32; style.values[5] = 1;
  Require(pde_apply_commands(doc, 0, "underline-on", &style, 1) != nullptr,
          "ordinary text uses a real vector underline");
  const auto underlined = RenderPixels(doc, 0, 300, 200);
  Require(underlined != plain && std::string(pde_describe_page(doc, 0)).find("\"underline\":true") != std::string::npos,
          "underline is visible and reported as text formatting");
  Require(pde_apply_commands(doc, 1, "underline-on-again", &style, 1) != nullptr &&
          RenderPixels(doc, 0, 300, 200) == underlined,
          "reapplying underline never adds another painted decoration");
  const char* objects[] = {object.c_str()};
  PdeEditCommand move{};
  move.type = 4; move.page_id = page.c_str(); move.ids = objects; move.id_count = 1;
  move.values[0] = 1; move.values[3] = 1; move.values[4] = 15;
  Require(pde_apply_commands(doc, 2, "move-underlined-text", &move, 1) != nullptr,
          "underline follows a text transform");
  const auto moved = RenderPixels(doc, 0, 300, 200);
  Require(pde_save_memory(doc) != nullptr, "save transformed underlined text");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "underline-reopen", "underline-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 300, 200) == moved,
          "underlined text persists through real PDF save/reopen");
  const std::string reopened_desc = RequireResult(pde_describe_page(reopened, 0), "reopened underline");
  const std::string reopened_page = PageIdFromDescription(reopened_desc);
  const std::string reopened_block = TextBlockIds(reopened_desc).front();
  const char* reopened_blocks[] = {reopened_block.c_str()};
  style.page_id = reopened_page.c_str(); style.ids = reopened_blocks; style.values[5] = 0;
  Require(pde_apply_commands(reopened, 0, "remove-saved-underline", &style, 1) != nullptr &&
          RenderPixels(reopened, 0, 300, 200) != moved,
          "removing saved underline removes the vector decoration, not only metadata");
  Require(pde_undo(reopened) != nullptr && RenderPixels(reopened, 0, 300, 200) == moved &&
          pde_redo(reopened) != nullptr, "underline removal is one undoable transaction");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close underline fixtures");
}

void TestShapedFormText(const std::string& font_id) {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Contents 4 0 R >>",
      Stream(""),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "shaped-field", "shaped-field-source", nullptr);
  Require(doc != 0, "open supplementary form text fixture");
  const std::string page = PageIdFromDescription(pde_describe_page(doc, 0));
  PdeEditCommand create{};
  create.type = 19; create.page_id = page.c_str(); create.target_id = "unicode-field";
  create.resource_id = "text"; create.text_utf8 = "UnicodeField"; create.font_id = font_id.c_str();
  create.flags = 1; create.values[0] = 30; create.values[1] = 40;
  create.values[2] = 300; create.values[3] = 45; create.values[4] = 18;
  Require(pde_apply_commands(doc, 0, "create-unicode-field", &create, 1) != nullptr,
          "create text field with an explicit font");
  const auto blank = RenderPixels(doc, 0, 400, 240);
  const char* value = "\xF0\xA0\xAE\xB7 e\xCC\x81";
  PdeEditCommand fill{};
  fill.type = 18; fill.target_id = "unicode-field"; fill.text_utf8 = value;
  Require(pde_apply_commands(doc, 1, "fill-supplementary-field", &fill, 1) != nullptr &&
          std::string(pde_describe_forms(doc)).find(value) != std::string::npos,
          "supplementary and combining field text preserves its exact Unicode value");
  const auto rendered = RenderPixels(doc, 0, 400, 240);
  Require(rendered != blank && pde_save_memory(doc) != nullptr, "complex text paints a visible field appearance");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "shaped-field-reopen", "shaped-field-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 400, 240) == rendered &&
          std::string(pde_describe_forms(reopened)).find(value) != std::string::npos,
          "complex AcroForm appearance and value survive PDF save/reopen");
  Require(pde_undo(doc) != nullptr && RenderPixels(doc, 0, 400, 240) == blank &&
          pde_redo(doc) != nullptr && RenderPixels(doc, 0, 400, 240) == rendered,
          "complex field filling retains atomic undo/redo");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close supplementary form fixtures");
}
