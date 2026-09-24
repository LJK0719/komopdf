void TestTaggedPageStructureRoundtrip() {
  const std::string pdf = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /StructParents 0 "
      "/Resources << /Font << /F1 9 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /StructParents 1 "
      "/Resources << /Font << /F1 9 0 R >> >> /Contents 10 0 R >>",
      Stream("/P << /MCID 0 >> BDC BT /F1 12 Tf 20 150 Td (First tagged) Tj ET EMC"),
      "<< /Type /StructTreeRoot /K [7 0 R 8 0 R] /ParentTree 11 0 R /ParentTreeNextKey 2 >>",
      "<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 0 >>",
      "<< /Type /StructElem /S /P /P 6 0 R /Pg 4 0 R /K 0 >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      Stream("/P << /MCID 0 >> BDC BT /F1 12 Tf 20 150 Td (Second tagged) Tj ET EMC"),
      "<< /Nums [0 [7 0 R] 1 [8 0 R]] >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(pdf.data()),
      static_cast<uint32_t>(pdf.size()), "tagged-real", "tagged-real-source", nullptr);
  Require(doc != 0, "open real tagged two-page fixture");
  const std::string page = PageIdFromDescription(pde_describe_page(doc, 1));
  const char* selected[] = {page.c_str()};
  Require(pde_extract_pages_memory(doc, selected, 1) != nullptr, "extract selected tagged page");
  const std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT extracted = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
  Require(extracted != nullptr && FPDF_GetPageCount(extracted) == 1, "open real tagged extraction result");
  auto* native = CPDFDocumentFromFPDFDocument(extracted);
  const auto tree = native->GetRoot()->GetDictFor("StructTreeRoot");
  const auto roots = tree ? tree->GetArrayFor("K") : nullptr;
  Require(roots && roots->size() == 1, "selected tagged tree contains no orphan structure from omitted pages");
  const auto element = roots->GetDictAt(0);
  const auto target_page = native->GetPageDictionary(0);
  Require(element && element->GetDictFor("P").Get() == tree.Get() &&
          element->GetDictFor("Pg").Get() == target_page.Get() && element->GetIntegerFor("K", -1) == 0,
          "structure element points to the actual extracted page and the actual tree root");
  const auto parent_tree = tree->GetDictFor("ParentTree");
  const auto nums = parent_tree ? parent_tree->GetArrayFor("Nums") : nullptr;
  Require(nums && nums->size() == 2 && nums->GetIntegerAt(0) == target_page->GetIntegerFor("StructParents", -1),
          "ParentTree key matches the copied page StructParents index");
  const auto mcids = nums->GetArrayAt(1);
  Require(mcids && mcids->GetDictAt(0).Get() == element.Get(),
          "ParentTree and forward K tree reference the identical structure object");
  FPDF_CloseDocument(extracted);
  const char* copied[] = {page.c_str(), "tagged-page-copy"};
  PdeEditCommand duplicate{};
  duplicate.type = 12; duplicate.target_id = page.c_str(); duplicate.ids = copied; duplicate.id_count = 2;
  Require(pde_apply_commands(doc, 0, "duplicate-real-tagged-page", &duplicate, 1) != nullptr &&
          pde_save_memory(doc) != nullptr, "copy real tagged page and save");
  const std::vector<uint8_t> copied_bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT copied_doc = FPDF_LoadMemDocument64(copied_bytes.data(), copied_bytes.size(), nullptr);
  Require(copied_doc != nullptr, "reopen tagged page duplication");
  auto* copied_native = CPDFDocumentFromFPDFDocument(copied_doc);
  const auto original = copied_native->GetPageDictionary(1);
  const auto copy = copied_native->GetPageDictionary(2);
  Require(original->GetIntegerFor("StructParents", -1) != copy->GetIntegerFor("StructParents", -1),
          "duplicated page gets independent parent-tree identity");
  FPDF_CloseDocument(copied_doc);
  Require(pde_close(doc) == 1, "close tagged fixture");
}
