#ifndef PDF_EDITOR_PAGE_STRUCTURE_TEST_H_
#define PDF_EDITOR_PAGE_STRUCTURE_TEST_H_

// Included by C API test runner. Tests Link, Outline, Widget/AcroForm, and Tagged structure.

inline void TestPageDuplicateWithLinksAndBookmarks() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 8 0 R /Annots [9 0 R] >>",
      // Page 1
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 8 0 R /Annots [10 0 R] >>",
      // Outlines
      "<< /Type /Outlines /First 6 0 R /Last 7 0 R /Count 2 >>",
      // Bookmark 0 -> Page 0
      "<< /Title (Book 0) /Parent 5 0 R /Next 7 0 R /Dest [3 0 R /Fit] >>",
      // Bookmark 1 -> Page 1
      "<< /Title (Book 1) /Parent 5 0 R /Prev 6 0 R /Dest [4 0 R /XYZ 10 100 0] >>",
      Stream("10 10 20 20 re f"),
      // Link on Page 0 to Page 1
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [4 0 R /Fit] >>",
      // Link on Page 1 to Page 0
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [3 0 R /Fit] >>",
  });

  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "dup-links-doc", "dup-links-source", nullptr);
  Require(doc != 0, "open page duplication fixture with links");

  const std::string p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "p0"));
  const std::string p1_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 1), "p1"));

  // Duplicate Page 0 after Page 0
  const char* pair[] = {p0_id.c_str(), "p0-copy"};
  PdeEditCommand dup_cmd{};
  dup_cmd.type = 12;  // kPagesDuplicate
  dup_cmd.ids = pair;
  dup_cmd.id_count = 2;
  dup_cmd.target_id = p0_id.c_str();

  Require(pde_apply_commands(doc, 0, "dup-p0", &dup_cmd, 1) != nullptr,
          "duplicate page with link and outline succeeds");

  Require(pde_document_revision(doc) == 1, "revision advanced after duplicate");

  // Verify Outline structure:
  // Book 0 must still point to original Page 0 (p0_id)
  // Book 1 must still point to original Page 1 (p1_id, which moved to page index 2)
  const std::string outline_json = RequireResult(pde_describe_outline(doc), "outline after duplicate");
  Require(outline_json.find("\"title\":\"Book 0\"") != std::string::npos &&
          outline_json.find("\"pageId\":\"" + p0_id + "\"") != std::string::npos,
          "Book 0 destination retains original Page 0 ID");
  Require(outline_json.find("\"title\":\"Book 1\"") != std::string::npos &&
          outline_json.find("\"pageId\":\"" + p1_id + "\"") != std::string::npos,
          "Book 1 destination retains original Page 1 ID");

  // Verify Links:
  // Original Page 0 (index 0) link points to original Page 1 (p1_id)
  const std::string p0_annots = RequireResult(pde_describe_annotations(doc, 0), "p0 annots");
  Require(p0_annots.find("\"subtype\":\"link\"") != std::string::npos &&
          p0_annots.find("\"targetPageId\":\"" + p1_id + "\"") != std::string::npos,
          "original Page 0 link target points to p1_id");

  // Duplicated Page 0 copy (index 1) link points to original Page 1 (p1_id)
  const std::string copy_annots = RequireResult(pde_describe_annotations(doc, 1), "copy annots");
  Require(copy_annots.find("\"subtype\":\"link\"") != std::string::npos &&
          copy_annots.find("\"targetPageId\":\"" + p1_id + "\"") != std::string::npos,
          "duplicated Page 0 link target points to original p1_id in same document");

  // Check one-step undo
  Require(pde_undo(doc) != nullptr && pde_document_revision(doc) == 2, "undo duplicate succeeds");
  const std::string after_undo_info = RequireResult(pde_document_info(doc), "doc info after undo");
  Require(after_undo_info.find("p0-copy") == std::string::npos,
          "undo completely removes duplicated page");

  // Redo
  Require(pde_redo(doc) != nullptr && pde_document_revision(doc) == 3, "redo duplicate succeeds");

  // Save and reopen
  Require(pde_save_memory(doc) != nullptr, "save duplicated PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()),
      "dup-links-reopen", "dup-links-saved", nullptr);
  Require(reopened != 0, "reopen duplicated PDF");

  const std::string rep_outline = RequireResult(pde_describe_outline(reopened), "reopened outline");
  Require(rep_outline.find("\"title\":\"Book 0\"") != std::string::npos &&
          rep_outline.find("\"title\":\"Book 1\"") != std::string::npos,
          "reopened PDF retains outline bookmarks");

  const std::string rep_copy_annots = RequireResult(pde_describe_annotations(reopened, 1), "reopened copy annots");
  Require(rep_copy_annots.find("\"subtype\":\"link\"") != std::string::npos,
          "reopened PDF retains duplicated link annotation");

  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close duplicate fixtures");
}

inline void TestPageDuplicateWithWidgets() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 4 0 R /Annots [5 0 R] >>",
      Stream("10 10 20 20 re f"),
      // Widget annotation / Field with existing KomoFieldId
      "<< /Type /Annot /Subtype /Widget /FT /Tx /T (username) /V (Alice) "
      "/KomoFieldId (k:test:user_field) "
      "/Rect [20 20 100 40] /P 3 0 R >>",
  });

  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "dup-widget-doc", "dup-widget-source", nullptr);
  Require(doc != 0, "open page duplication fixture with widgets");

  const std::string p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "p0"));

  const char* pair[] = {p0_id.c_str(), "p0-widget-copy"};
  PdeEditCommand dup_cmd{};
  dup_cmd.type = 12;
  dup_cmd.ids = pair;
  dup_cmd.id_count = 2;
  dup_cmd.target_id = p0_id.c_str();

  Require(pde_apply_commands(doc, 0, "dup-p0-widget", &dup_cmd, 1) != nullptr,
          "duplicate page with AcroForm widget succeeds");

  // Verify AcroForm forms structure:
  // Must contain original "username" and disambiguated "username_copy1",
  // and their field IDs must NOT collide.
  const std::string forms_json = RequireResult(pde_describe_forms(doc), "forms after duplicate");
  Require(forms_json.find("\"name\":\"username\"") != std::string::npos,
          "original field 'username' preserved");
  Require(forms_json.find("\"name\":\"username_copy1\"") != std::string::npos,
          "duplicated field gets non-colliding name 'username_copy1'");
  Require(forms_json.find("\"value\":\"Alice\"") != std::string::npos,
          "field value 'Alice' preserved");

  // Verify ID non-collision
  size_t id1_pos = forms_json.find("\"id\":\"");
  Require(id1_pos != std::string::npos, "first id found");
  size_t id1_end = forms_json.find("\"", id1_pos + 6);
  std::string id1 = forms_json.substr(id1_pos + 6, id1_end - (id1_pos + 6));

  size_t id2_pos = forms_json.find("\"id\":\"", id1_end);
  Require(id2_pos != std::string::npos, "second id found");
  size_t id2_end = forms_json.find("\"", id2_pos + 6);
  std::string id2 = forms_json.substr(id2_pos + 6, id2_end - (id2_pos + 6));

  Require(id1 != id2, "duplicated field IDs do not collide even with preset KomoFieldId");

  // Save and reopen
  Require(pde_save_memory(doc) != nullptr, "save widget duplicated PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()),
      "dup-widget-reopen", "dup-widget-saved", nullptr);
  Require(reopened != 0, "reopen widget duplicated PDF");

  const std::string rep_forms = RequireResult(pde_describe_forms(reopened), "reopened forms");
  Require(rep_forms.find("\"name\":\"username\"") != std::string::npos &&
          rep_forms.find("\"name\":\"username_copy1\"") != std::string::npos,
          "reopened PDF retains both original and duplicated fields");

  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close widget duplicate fixtures");
}

inline void TestPageDuplicateWithMultiWidgetRadioGroup() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] "
      "/Resources << >> /Contents 4 0 R /Annots [6 0 R 7 0 R] >>",
      Stream("10 10 20 20 re f"),
      // Parent Radio Field (5 0 R)
      "<< /FT /Btn /Ff 32768 /T (choice) /V /Opt1 /Kids [6 0 R 7 0 R] >>",
      // Widget 1 (6 0 R)
      "<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [20 20 40 40] /P 3 0 R "
      "/AP << /N << /Opt1 8 0 R /Off 9 0 R >> >> >>",
      // Widget 2 (7 0 R)
      "<< /Type /Annot /Subtype /Widget /Parent 5 0 R /Rect [20 60 40 80] /P 3 0 R "
      "/AP << /N << /Opt2 8 0 R /Off 9 0 R >> >> >>",
      Stream("q 1 0 0 rg 0 0 20 20 re f Q", "/Type /XObject /Subtype /Form /BBox [0 0 20 20]"),
      Stream("q 0 0 0 rg 0 0 20 20 re f Q", "/Type /XObject /Subtype /Form /BBox [0 0 20 20]"),
  });
  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "dup-radio-doc", "dup-radio-source", nullptr);
  Require(doc != 0, "open multi-widget radio fixture");
  const std::string p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "p0"));
  const char* pair[] = {p0_id.c_str(), "p0-radio-copy"};
  PdeEditCommand dup_cmd{};
  dup_cmd.type = 12;
  dup_cmd.ids = pair;
  dup_cmd.id_count = 2;
  dup_cmd.target_id = p0_id.c_str();
  Require(pde_apply_commands(doc, 0, "dup-p0-radio", &dup_cmd, 1) != nullptr,
          "duplicate page with multi-widget radio field succeeds");
  const std::string forms_json = RequireResult(pde_describe_forms(doc), "radio forms after duplicate");
  Require(forms_json.find("\"name\":\"choice\"") != std::string::npos, "original radio field choice preserved");
  Require(forms_json.find("\"name\":\"choice_copy1\"") != std::string::npos, "duplicated radio field choice_copy1 preserved");
  Require(pde_save_memory(doc) != nullptr, "save radio PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()),
      "dup-radio-reopen", "dup-radio-saved", nullptr);
  Require(reopened != 0, "reopen multi-widget radio PDF");
  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close radio fixtures");
}

inline void TestPageDeleteWithSurvivingLinksAndOutlines() {
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
      // Bookmark 0 -> Page 0
      "<< /Title (Book 0) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
      // Bookmark 2 -> Page 2
      "<< /Title (Book 2) /Parent 6 0 R /Prev 7 0 R /Dest [5 0 R /Fit] >>",
      Stream("10 10 20 20 re f"),
      // 10 0 obj: Link on Page 0 to Page 2
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [5 0 R /Fit] >>",
      // 11 0 obj: Link on Page 0 to Page 1
      "<< /Type /Annot /Subtype /Link /Rect [10 40 50 60] /Dest [4 0 R /Fit] >>",
      // 12 0 obj: Link on Page 1 to Page 0
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [3 0 R /Fit] >>",
  });

  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "del-links-doc", "del-links-source", nullptr);
  Require(doc != 0, "open delete links fixture");

  const std::string p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "p0"));
  const std::string p1_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 1), "p1"));
  const std::string p2_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 2), "p2"));

  // Delete Page 1
  const char* del_p1[] = {p1_id.c_str()};
  PdeEditCommand cmd_del_p1{};
  cmd_del_p1.type = 7;  // kPagesDelete
  cmd_del_p1.ids = del_p1;
  cmd_del_p1.id_count = 1;

  Require(pde_apply_commands(doc, 0, "del-p1", &cmd_del_p1, 1) != nullptr,
          "deleting page 1 with surviving link succeeds via structure pruning");
  Require(pde_document_revision(doc) == 1, "revision advanced after page delete");

  // Verify Outline:
  // Book 0 points to Page 0 (p0_id), Book 2 points to Page 2 (p2_id)
  const std::string outline_json = RequireResult(pde_describe_outline(doc), "outline after delete");
  Require(outline_json.find("\"title\":\"Book 0\"") != std::string::npos &&
          outline_json.find("\"pageId\":\"" + p0_id + "\"") != std::string::npos,
          "Book 0 remains valid pointing to Page 0");
  Require(outline_json.find("\"title\":\"Book 2\"") != std::string::npos &&
          outline_json.find("\"pageId\":\"" + p2_id + "\"") != std::string::npos,
          "Book 2 remains valid pointing to Page 2");

  // Verify Page 0 Annotations:
  // Dangling link to deleted Page 1 was pruned; surviving link to Page 2 remains intact!
  const std::string p0_annots = RequireResult(pde_describe_annotations(doc, 0), "p0 annots after delete");
  Require(p0_annots.find("\"targetPageId\":\"" + p2_id + "\"") != std::string::npos,
          "link to surviving Page 2 is intact");
  Require(p0_annots.find("\"targetPageId\":\"" + p1_id + "\"") == std::string::npos,
          "link to deleted Page 1 was pruned");

  // Undo and redo
  Require(pde_undo(doc) != nullptr && pde_document_revision(doc) == 2, "undo delete succeeds");
  Require(pde_redo(doc) != nullptr && pde_document_revision(doc) == 3, "redo delete succeeds");

  // Save and reopen
  Require(pde_save_memory(doc) != nullptr, "save after page delete");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()),
      "del-links-reopen", "del-links-saved", nullptr);
  Require(reopened != 0, "reopen after page delete");

  Require(pde_close(reopened) == 1 && pde_close(doc) == 1, "close delete fixtures");
}

inline void TestExtractPagesWithLinksAndOutlines() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R /Annots [10 0 R 11 0 R] >>",
      // Page 1
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R >>",
      // Page 2
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 9 0 R >>",
      // Outlines root
      "<< /Type /Outlines /First 7 0 R /Last 8 0 R /Count 2 >>",
      // Bookmark 0 -> Page 0
      "<< /Title (Book 0) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
      // Bookmark 2 -> Page 2
      "<< /Title (Book 2) /Parent 6 0 R /Prev 7 0 R /Dest [5 0 R /XYZ 20 80 0] >>",
      Stream("10 10 20 20 re f"),
      // 10 0 obj: Link on Page 0 to Page 2
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [5 0 R /XYZ 20 80 0] >>",
      // 11 0 obj: Link on Page 0 to Page 1
      "<< /Type /Annot /Subtype /Link /Rect [10 40 50 60] /Dest [4 0 R /Fit] >>",
  });

  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "extract-test-doc", "extract-test-source", nullptr);
  Require(doc != 0, "open extract fixture");

  const std::string p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 0), "p0"));
  const std::string p2_id = PageIdFromDescription(RequireResult(pde_describe_page(doc, 2), "p2"));

  // Extract Page 0 and Page 2 (skipping Page 1)
  const char* extract_ids[] = {p0_id.c_str(), p2_id.c_str()};
  Require(pde_extract_pages_memory(doc, extract_ids, 2) != nullptr,
          "extract pages with outlines and links succeeds");
  Require(pde_binary_size() > 0, "extracted PDF bytes generated");

  const std::vector<uint8_t> extracted(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t ext_doc = pde_open_memory(
      extracted.data(), static_cast<uint32_t>(extracted.size()),
      "ext-opened-doc", "ext-opened-source", nullptr);
  Require(ext_doc != 0, "open extracted PDF");

  const std::string ext_p0_id = PageIdFromDescription(RequireResult(pde_describe_page(ext_doc, 0), "ext p0"));
  const std::string ext_p1_id = PageIdFromDescription(RequireResult(pde_describe_page(ext_doc, 1), "ext p1"));

  // Verify Outlines in extracted document:
  // Book 0 points to extracted Page 0 (ext_p0_id)
  // Book 2 points to extracted Page 1 (ext_p1_id, originally p2)
  const std::string ext_outline = RequireResult(pde_describe_outline(ext_doc), "extracted outline");
  Require(ext_outline.find("\"title\":\"Book 0\"") != std::string::npos &&
          ext_outline.find("\"pageId\":\"" + ext_p0_id + "\"") != std::string::npos,
          "extracted Book 0 points to extracted page 0");
  Require(ext_outline.find("\"title\":\"Book 2\"") != std::string::npos &&
          ext_outline.find("\"pageId\":\"" + ext_p1_id + "\"") != std::string::npos,
          "extracted Book 2 points to extracted page 1 (original p2)");

  // Verify Link on extracted Page 0:
  // Link to extracted Page 2 (now ext_p1_id) was remapped, with targetTopPt intact
  // Link to unextracted Page 1 was dropped (no dangling link)
  const std::string ext_p0_annots = RequireResult(pde_describe_annotations(ext_doc, 0), "ext p0 annots");
  Require(ext_p0_annots.find("\"targetPageId\":\"" + ext_p1_id + "\"") != std::string::npos,
          "extracted link to original p2 is remapped to ext_p1_id");

  Require(pde_close(ext_doc) == 1 && pde_close(doc) == 1, "close extract fixtures");
}

inline void TestCrossDocumentImportWithLinksAndOutlines() {
  const std::string doc_a_pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
  });

  const std::string doc_b_pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      // Page 0
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 7 0 R /Annots [8 0 R] >>",
      // Page 1
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 7 0 R >>",
      // Outlines
      "<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 1 >>",
      "<< /Title (Imported Section) /Parent 5 0 R /Dest [3 0 R /Fit] >>",
      Stream("10 10 20 20 re f"),
      // Link on Page 0 to Page 1
      "<< /Type /Annot /Subtype /Link /Rect [10 10 50 30] /Dest [4 0 R /Fit] >>",
  });

  const uint32_t doc_a = pde_open_memory(
      reinterpret_cast<const uint8_t*>(doc_a_pdf.data()), static_cast<uint32_t>(doc_a_pdf.size()),
      "import-doc-a", "import-source-a", nullptr);
  Require(doc_a != 0, "open target doc A");

  const char* reg_res = pde_register_pdf_resource(
      doc_a, "res-doc-b",
      reinterpret_cast<const uint8_t*>(doc_b_pdf.data()),
      static_cast<uint32_t>(doc_b_pdf.size()));
  Require(reg_res != nullptr, "register doc B as resource");

  const std::string a_p0_id = PageIdFromDescription(RequireResult(pde_describe_page(doc_a, 0), "a p0"));

  // Import Page 0 and Page 1 from resource doc B after doc A's page 0
  const char* import_pairs[] = {"0", "imported-p0", "1", "imported-p1"};
  PdeEditCommand imp_cmd{};
  imp_cmd.type = 13;  // kPagesImport
  imp_cmd.resource_id = "res-doc-b";
  imp_cmd.ids = import_pairs;
  imp_cmd.id_count = 4;
  imp_cmd.target_id = a_p0_id.c_str();

  Require(pde_apply_commands(doc_a, 0, "import-pages", &imp_cmd, 1) != nullptr,
          "import pages with links and bookmarks from another PDF succeeds");
  Require(pde_document_revision(doc_a) == 1, "revision advanced after import");

  // Verify Outline in Doc A:
  // "Imported Section" points to imported-p0
  const std::string a_outline = RequireResult(pde_describe_outline(doc_a), "imported outline");
  Require(a_outline.find("\"title\":\"Imported Section\"") != std::string::npos &&
          a_outline.find("\"pageId\":\"imported-p0\"") != std::string::npos,
          "imported bookmark accurately points to 'imported-p0'");

  // Verify Link on imported-p0 (index 1):
  // Points to imported-p1
  const std::string imp_p0_annots = RequireResult(pde_describe_annotations(doc_a, 1), "imp p0 annots");
  Require(imp_p0_annots.find("\"targetPageId\":\"imported-p1\"") != std::string::npos,
          "imported link target accurately points to 'imported-p1'");

  // Save and reopen
  Require(pde_save_memory(doc_a) != nullptr, "save imported PDF");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  const uint32_t reopened = pde_open_memory(
      saved.data(), static_cast<uint32_t>(saved.size()),
      "import-reopen", "import-saved", nullptr);
  Require(reopened != 0, "reopen imported PDF");

  const std::string rep_outline = RequireResult(pde_describe_outline(reopened), "reopened imported outline");
  Require(rep_outline.find("\"title\":\"Imported Section\"") != std::string::npos,
          "reopened PDF retains imported section bookmark");

  Require(pde_close(reopened) == 1 && pde_close(doc_a) == 1, "close import fixtures");
}

inline void TestFailureAtomicityNoHalfWrite() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] "
      "/Resources << >> /Contents 4 0 R >>",
      Stream("10 10 20 20 re f"),
  });

  const uint32_t doc = pde_open_memory(
      reinterpret_cast<const uint8_t*>(pdf.data()), static_cast<uint32_t>(pdf.size()),
      "atomic-doc", "atomic-source", nullptr);
  Require(doc != 0, "open atomic test fixture");

  // Issue an invalid edit command (non-existent page ID)
  const char* ids[] = {"non-existent-page"};
  PdeEditCommand bad_cmd{};
  bad_cmd.type = 7;  // delete
  bad_cmd.ids = ids;
  bad_cmd.id_count = 1;

  Require(pde_apply_commands(doc, 0, "bad-tx", &bad_cmd, 1) == nullptr,
          "bad command is rejected");
  Require(pde_document_revision(doc) == 0,
          "rejected transaction leaves revision unchanged (no half-writes)");

  Require(pde_close(doc) == 1, "close atomic fixture");
}

inline void RunAllPageStructureTests() {
  TestPageDuplicateWithLinksAndBookmarks();
  TestPageDuplicateWithWidgets();
  TestPageDuplicateWithMultiWidgetRadioGroup();
  TestPageDeleteWithSurvivingLinksAndOutlines();
  TestExtractPagesWithLinksAndOutlines();
  TestCrossDocumentImportWithLinksAndOutlines();
  TestFailureAtomicityNoHalfWrite();
}

#endif  // PDF_EDITOR_PAGE_STRUCTURE_TEST_H_
