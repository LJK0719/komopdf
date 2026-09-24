// Included by the C API test so the existing PDF fixtures and assertions are shared.
void TestNestedObjectCopyAndArrange() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << /XObject << /Fm 6 0 R >> >> /Contents 5 0 R >>",
      Stream("q 1 0 0 1 20 30 cm /Fm Do Q"),
      Stream("1 0 0 rg 10 20 15 10 re f 0 0 1 rg 60 40 15 10 re f "
             "0 1 0 rg 140 60 15 10 re f",
             "/Type /XObject /Subtype /Form /BBox [0 0 240 160] /Resources << >>"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "nested-copy", "nested-copy-source", nullptr);
  Require(doc != 0, "open shared nested drawing fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "nested drawing source");
  const std::string page = PageIdFromDescription(before);
  const auto unchanged = RenderPixels(doc, 1, 300, 300);
  std::vector<std::string> paths;
  size_t cursor = 0;
  while ((cursor = before.find("\"type\":\"path\"", cursor)) != std::string::npos) {
    paths.push_back(JsonStringAfter(before, "{\"id\":\"", before.rfind("{\"id\":\"", cursor)));
    ++cursor;
  }
  Require(paths.size() == 3, "three independently addressable Form children");
  const char* pair[] = {paths[0].c_str(), "copied-nested-path"};
  PdeEditCommand copy{};
  copy.type = 16; copy.page_id = page.c_str(); copy.ids = pair; copy.id_count = 2;
  copy.values[0] = 30; copy.values[1] = -30;
  Require(pde_preview_commands(doc, 0, &copy, 1) != nullptr &&
          std::string(pde_describe_page(doc, 0)) == before,
          "nested copy preview leaves the shared source unchanged");
  Require(pde_apply_commands(doc, 0, "copy-nested-path", &copy, 1) != nullptr &&
          std::string(pde_describe_page(doc, 0)).find("copied-nested-path") != std::string::npos &&
          RenderPixels(doc, 1, 300, 300) == unchanged,
          "nested copy retains its container and isolates the other shared page");
  const auto copied = RenderPixels(doc, 0, 300, 300);
  Require(pde_undo(doc) != nullptr && std::string(pde_describe_page(doc, 0)) == before &&
          pde_redo(doc) != nullptr && RenderPixels(doc, 0, 300, 300) == copied,
          "nested copy is one reversible transaction");
  const char* selected[] = {paths[0].c_str(), paths[1].c_str(), paths[2].c_str()};
  PdeEditCommand arrange{};
  arrange.type = 21; arrange.page_id = page.c_str();
  arrange.ids = selected; arrange.id_count = 3; arrange.values[0] = 3;
  Require(pde_apply_commands(doc, pde_document_revision(doc), "align-nested-paths", &arrange, 1) != nullptr,
          "align shared Form children in page coordinates");
  arrange.type = 24; arrange.values[0] = 0;
  Require(pde_apply_commands(doc, pde_document_revision(doc), "distribute-nested-paths", &arrange, 1) != nullptr &&
          RenderPixels(doc, 1, 300, 300) == unchanged,
          "distribute nested paths without changing another Form instance");
  const auto arranged = RenderPixels(doc, 0, 300, 300);
  Require(pde_save_memory(doc) != nullptr, "save copied and arranged nested paths");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "nested-copy-reopened", "nested-copy-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 300, 300) == arranged &&
          RenderPixels(reopened, 1, 300, 300) == unchanged,
          "nested copy/arrangement survives PDF save and reopen with shared instance isolation");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close nested copy documents");
}

void TestNestedPersistentGroupCopy() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << >> /Contents [4 0 R 5 0 R] >>",
      Stream("1 0 0 rg 10 20 20 20 re f 0 1 0 rg 40 20 20 20 re f"),
      Stream("0 0 1 rg 70 20 20 20 re f"),
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "nested-group", "nested-group-source", nullptr);
  Require(doc != 0, "open cross-stream persistent group fixture");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "group fixture objects");
  const std::string page = PageIdFromDescription(before);
  std::vector<std::string> paths;
  size_t cursor = 0;
  while ((cursor = before.find("\"type\":\"path\"", cursor)) != std::string::npos) {
    paths.push_back(JsonStringAfter(before, "{\"id\":\"", before.rfind("{\"id\":\"", cursor)));
    ++cursor;
  }
  Require(paths.size() == 3, "cross-stream group source has three paths");
  const auto original = RenderPixels(doc, 0, 300, 300);
  const char* inner[] = {paths[0].c_str(), paths[1].c_str()};
  PdeEditCommand group{};
  group.type = 26; group.page_id = page.c_str(); group.target_id = "inner-group";
  group.ids = inner; group.id_count = 2;
  Require(pde_apply_commands(doc, 0, "make-inner-group", &group, 1) != nullptr,
          "create inner persistent group");
  const char* outer[] = {"inner-group", paths[2].c_str()};
  group.target_id = "outer-group"; group.ids = outer;
  Require(pde_apply_commands(doc, 1, "make-outer-group", &group, 1) != nullptr &&
          RenderPixels(doc, 0, 300, 300) == original,
          "group a Form and a path across content streams without changing pixels");
  const char* pair[] = {"outer-group", "outer-copy"};
  PdeEditCommand copy{};
  copy.type = 16; copy.page_id = page.c_str(); copy.ids = pair; copy.id_count = 2;
  copy.values[0] = 100;
  Require(pde_apply_commands(doc, 2, "copy-nested-group", &copy, 1) != nullptr,
          "copy a nested persistent group with new descendant identities");
  const auto copied = RenderPixels(doc, 0, 300, 300);
  Require(copied != original && pde_save_memory(doc) != nullptr, "save nested group copy");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(saved.data(), static_cast<uint32_t>(saved.size()),
      "nested-group-reopened", "nested-group-saved", nullptr);
  Require(reopened != 0 && RenderPixels(reopened, 0, 300, 300) == copied,
          "nested group copy appearance survives save and reopen");
  const std::string description = RequireResult(pde_describe_page(reopened, 0), "reopened nested group");
  const auto first = description.find("\"id\":\"inner-group\"");
  Require(first != std::string::npos &&
          description.find("\"id\":\"inner-group\"", first + 1) == std::string::npos &&
          description.find("\"id\":\"outer-copy\"") != std::string::npos,
          "copied nested group metadata never reuses the source group ID");
  const std::string reopened_page = PageIdFromDescription(description);
  PdeEditCommand ungroup{};
  ungroup.type = 27; ungroup.page_id = reopened_page.c_str(); ungroup.target_id = "outer-copy";
  Require(pde_apply_commands(reopened, 0, "ungroup-nested-copy", &ungroup, 1) != nullptr &&
          RenderPixels(reopened, 0, 300, 300) == copied && pde_save_memory(reopened) != nullptr,
          "ungroup the copied outer group while retaining the inner group and placement");
  const char* deleted_ids[] = {paths[0].c_str()};
  PdeEditCommand remove{};
  remove.type = 5; remove.page_id = reopened_page.c_str();
  remove.ids = deleted_ids; remove.id_count = 1;
  Require(pde_apply_commands(reopened, 1, "delete-nested-member", &remove, 1) != nullptr &&
          std::string(pde_describe_page(reopened, 0)).find("\"id\":\"inner-group\"") != std::string::npos,
          "deleting a nested member preserves the remaining persistent group identity");
  const auto deleted = RenderPixels(reopened, 0, 300, 300);
  ungroup.target_id = "inner-group";
  Require(pde_apply_commands(reopened, 2, "ungroup-nested-member", &ungroup, 1) != nullptr &&
          RenderPixels(reopened, 0, 300, 300) == deleted && pde_save_memory(reopened) != nullptr,
          "ungroup a nested single-member group without changing appearance");
  const std::vector<uint8_t> final_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t final_doc = pde_open_memory(final_bytes.data(), static_cast<uint32_t>(final_bytes.size()),
      "nested-group-final", "nested-group-final-source", nullptr);
  Require(final_doc != 0 && RenderPixels(final_doc, 0, 300, 300) == deleted,
          "nested group deletion and ungroup metadata survive a second roundtrip");
  Require(pde_close(final_doc) == 1 && pde_close(reopened) == 1 && pde_close(doc) == 1,
          "close nested group documents");
}
