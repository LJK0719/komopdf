std::string TaggedContentFixture() {
  return Pdf({
      "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 200] /StructParents 0 "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("/Span << /MCID 0 /ActualText (AlphaBetaGamma) >> BDC "
             "BT /F1 14 Tf 20 155 Td (Alpha) Tj ET "
             "BT /F1 14 Tf 65 155 Td (Beta) Tj ET "
             "BT /F1 14 Tf 100 155 Td (Gamma) Tj ET EMC"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>",
      "<< /Type /StructTreeRoot /K 6 0 R /ParentTree 8 0 R /ParentTreeNextKey 1 >>",
      "<< /Nums [0 [6 0 R]] >>",
  });
}

std::vector<std::string> TaggedObjectIds(std::string_view page) {
  std::vector<std::string> ids;
  size_t at = page.find("\"objects\":[");
  Require(at != std::string_view::npos, "tagged object list");
  while ((at = page.find("{\"id\":\"", at + 1)) != std::string_view::npos) {
    // A nested textBlock has its own ID, but its '{' follows a colon.
    if (at == 0 || (page[at - 1] != '[' && page[at - 1] != ',')) continue;
    const size_t start = at + 7;
    const size_t end = page.find('"', start);
    Require(end != std::string_view::npos, "tagged object ID terminator");
    ids.emplace_back(page.substr(start, end - start));
  }
  return ids;
}

uint32_t OpenTaggedContent(const std::string& id) {
  const std::string fixture = TaggedContentFixture();
  const auto doc = pde_open_memory(reinterpret_cast<const uint8_t*>(fixture.data()),
                                   static_cast<uint32_t>(fixture.size()), id.c_str(), id.c_str(), nullptr);
  Require(doc != 0, "open shared-MCID, multi-object ActualText fixture");
  return doc;
}

bool TaggedKHasMcr(const CPDF_Object* object, int mcid,
                   const CPDF_Dictionary* page, uint32_t stream) {
  if (!object) return false;
  const auto direct = object->GetDirect();
  if (!direct) return false;
  if (const auto* array = direct->AsArray()) {
    for (size_t i = 0; i < array->size(); ++i)
      if (TaggedKHasMcr(array->GetObjectAt(i).Get(), mcid, page, stream)) return true;
    return false;
  }
  if (direct->IsNumber()) return stream == 0 && direct->GetInteger() == mcid;
  const auto* dict = direct->AsDictionary();
  if (!dict || dict->GetNameFor("Type") != "MCR" || dict->GetIntegerFor("MCID", -1) != mcid ||
      dict->GetDictFor("Pg").Get() != page) return false;
  const auto stm = dict->GetObjectFor("Stm");
  return (stm && stm->IsReference() ? stm->AsReference()->GetRefObjNum() : 0) == stream;
}

void CheckTaggedOwner(CPDF_Document* doc, CPDF_Page* page,
                      CPDF_PageObjectHolder* holder, const CPDF_Dictionary* element,
                      CPDF_PageObject* object) {
  const int mcid = object->GetContentMarks()->GetMarkedContentID();
  Require(mcid >= 0, "marked content retains a real MCID");
  const int key = pdf_editor::tagged::ParentKey(holder);
  const auto parent = pdf_editor::tagged::ParentArray(doc, key);
  Require(parent && static_cast<size_t>(mcid) < parent->size() &&
          parent->GetDictAt(mcid).Get() == element,
          "ParentTree resolves MCID to the exact same structure element");
  const auto k = element->GetObjectFor("K");
  const uint32_t stream = holder->IsPage() ? 0 :
      static_cast<CPDF_Form*>(holder)->GetStream()->GetObjNum();
  Require(TaggedKHasMcr(k.Get(), mcid, page->GetDict().Get(), stream),
          "structure K MCR and /Stm point back to the exact owning content stream");
}

void CheckTaggedContentSaved(uint32_t doc, size_t page_objects,
                             size_t expected_tagged, size_t expected_form_children = 0) {
  Require(pde_save_memory(doc) != nullptr, "serialize edited tagged content");
  const std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT saved = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
  Require(saved != nullptr, "reopen actual tagged PDF bytes");
  FPDF_PAGE parsed = FPDF_LoadPage(saved, 0);
  Require(parsed != nullptr, "parse reopened tagged page");
  auto* page = CPDFPageFromFPDFPage(parsed);
  auto* native = CPDFDocumentFromFPDFDocument(saved);
  const auto tree = native->GetRoot()->GetDictFor("StructTreeRoot");
  const auto element = tree ? tree->GetDictFor("K") : nullptr;
  Require(element && element->GetDictFor("P").Get() == tree.Get() &&
          element->GetDictFor("Pg").Get() == page->GetDict().Get(),
          "reopened root, element P, and Pg are identical indirect objects");
  Require(page->GetPageObjectCount() == page_objects, "reopened object count");
  size_t tagged = 0;
  size_t form_children = 0;
  for (const auto& object : *page) {
    if (object->GetContentMarks()->GetMarkedContentID() >= 0) {
      CheckTaggedOwner(native, page, page, element.Get(), object.get());
      ++tagged;
    }
    if (auto* form = object->AsForm()) {
      for (const auto& child : *form->form()) {
        if (child->GetContentMarks()->GetMarkedContentID() < 0) continue;
        CheckTaggedOwner(native, page, form->form(), element.Get(), child.get());
        ++tagged; ++form_children;
      }
    }
  }
  Require(tagged == expected_tagged && form_children == expected_form_children,
          "all reopened marks have live and distinct parent-tree and structure links");
  FPDF_ClosePage(parsed);
  FPDF_CloseDocument(saved);
}

void TestNestedTaggedFormIsolation() {
  const std::string fixture = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 220 180] "
      "/Resources << /XObject << /Fm 5 0 R >> >> /Contents 4 0 R >>",
      Stream("q /Fm Do Q q 1 0 0 1 60 0 cm /Fm Do Q"),
      Stream("/Span << /MCID 0 /ActualText (Two) >> BDC "
             "BT /F1 14 Tf 20 110 Td (Two) Tj ET EMC",
             "/Type /XObject /Subtype /Form /BBox [0 0 150 150] /StructParents 1 "
             "/Resources << /Font << /F1 6 0 R >> >>"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /StructTreeRoot /K 8 0 R /ParentTree 9 0 R /ParentTreeNextKey 2 >>",
      "<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R "
      "/K << /Type /MCR /Pg 3 0 R /Stm 5 0 R /MCID 0 >> >>",
      "<< /Nums [1 [8 0 R]] >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(fixture.data()),
      static_cast<uint32_t>(fixture.size()), "shared-tagged-form", "shared-tagged-form", nullptr);
  Require(doc != 0, "open Form shared across two tagged instances");
  const std::string before = pde_describe_page(doc, 0);
  const auto blocks = TextBlockIds(before);
  Require(blocks.size() == 2, "both tagged Form instances expose distinct text IDs");
  PdeTextEdit edit{0, blocks[0].c_str(), 0, 3, "New", nullptr};
  Require(pde_apply_text(doc, 0, "tagged-form-isolation", &edit, 1) != nullptr &&
          pde_save_memory(doc) != nullptr, "write tagged Form only after isolating its content stream");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(saved.data(), saved.size(), nullptr);
  FPDF_PAGE parsed = FPDF_LoadPage(reopened, 0);
  auto* page = CPDFPageFromFPDFPage(parsed);
  auto* native = CPDFDocumentFromFPDFDocument(reopened);
  const auto tree = native->GetRoot()->GetDictFor("StructTreeRoot");
  const auto element = tree->GetDictFor("K");
  auto* changed = page->GetPageObjectByIndex(0)->AsForm()->form();
  auto* original = page->GetPageObjectByIndex(1)->AsForm()->form();
  Require(changed->GetStream()->GetObjNum() != original->GetStream()->GetObjNum() &&
          pdf_editor::tagged::ParentKey(changed) != pdf_editor::tagged::ParentKey(original),
          "tagged Form instances own separate streams and StructParents keys");
  CheckTaggedOwner(native, page, changed, element.Get(), changed->GetPageObjectByIndex(0));
  CheckTaggedOwner(native, page, original, element.Get(), original->GetPageObjectByIndex(0));
  Require(pdf_editor::tagged::ActualMark(changed->GetPageObjectByIndex(0))->GetParam()->
              GetUnicodeTextFor("ActualText") == L"New" &&
          pdf_editor::tagged::ActualMark(original->GetPageObjectByIndex(0))->GetParam()->
              GetUnicodeTextFor("ActualText") == L"Two",
          "writing one nested Form does not mutate the second instance's ActualText");
  FPDF_ClosePage(parsed); FPDF_CloseDocument(reopened);
  const auto nested_objects = TaggedObjectIds(pde_describe_page(doc, 0));
  Require(nested_objects.size() == 4, "both Form parents and nested text have stable object IDs");
  const char* copy_ids[]{nested_objects[1].c_str(), "nested-tagged-copy"};
  PdeEditCommand copy{};
  copy.type = 16; copy.ids = copy_ids; copy.id_count = 2;
  const auto page_id = PageIdFromDescription(pde_describe_page(doc, 0));
  copy.page_id = page_id.c_str(); copy.values[0] = 10;
  Require(pde_apply_commands(doc, 1, "copy-tagged-form-child", &copy, 1) != nullptr &&
          pde_save_memory(doc) != nullptr, "copy tagged child inside isolated Form instance");
  const std::vector<uint8_t> copied(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT opened = FPDF_LoadMemDocument64(copied.data(), copied.size(), nullptr);
  FPDF_PAGE copied_page = FPDF_LoadPage(opened, 0);
  auto* copied_native = CPDFDocumentFromFPDFDocument(opened);
  auto* copied_root = CPDFPageFromFPDFPage(copied_page);
  auto* isolated = copied_root->GetPageObjectByIndex(0)->AsForm()->form();
  auto* untouched = copied_root->GetPageObjectByIndex(1)->AsForm()->form();
  const auto copied_element = copied_native->GetRoot()->GetDictFor("StructTreeRoot")->GetDictFor("K");
  Require(isolated->GetPageObjectCount() == 2 && untouched->GetPageObjectCount() == 1 &&
          isolated->GetPageObjectByIndex(0)->GetContentMarks()->GetMarkedContentID() !=
              isolated->GetPageObjectByIndex(1)->GetContentMarks()->GetMarkedContentID(),
          "nested copy gets a fresh MCID without mutating the other Form instance");
  CheckTaggedOwner(copied_native, copied_root, isolated, copied_element.Get(),
                   isolated->GetPageObjectByIndex(1));
  CheckTaggedOwner(copied_native, copied_root, untouched, copied_element.Get(),
                   untouched->GetPageObjectByIndex(0));
  FPDF_ClosePage(copied_page); FPDF_CloseDocument(opened);
  Require(pde_undo(doc) != nullptr && pde_undo(doc) != nullptr &&
          pde_describe_page(doc, 0) == before,
          "undo restores both tagged Form instances and their nested MCIDs");
  Require(pde_close(doc) == 1, "close shared Form test");
}

void TestWholeNonLocalActualTextCopy() {
  const std::string fixture = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /StructParents 0 "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("/Span << /MCID 0 /ActualText (ReadAsOne) >> BDC "
             "BT /F1 14 Tf 20 155 Td (A) Tj ET "
             "BT /F1 14 Tf 40 155 Td (B) Tj ET EMC"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>",
      "<< /Type /StructTreeRoot /K 6 0 R /ParentTree 8 0 R /ParentTreeNextKey 1 >>",
      "<< /Nums [0 [6 0 R]] >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(fixture.data()),
      static_cast<uint32_t>(fixture.size()), "non-local-whole-scope", "non-local-whole-scope", nullptr);
  Require(doc != 0, "open non-local ActualText shared by two text objects");
  const auto page_description = std::string(pde_describe_page(doc, 0));
  const auto ids = TaggedObjectIds(page_description);
  Require(ids.size() == 2, "two drawable objects in non-local marked scope");
  const auto page_id = PageIdFromDescription(page_description);
  const char* pairs[]{ids[0].c_str(), "alias-a-copy", ids[1].c_str(), "alias-b-copy"};
  PdeEditCommand copy{};
  copy.type = 16; copy.page_id = page_id.c_str(); copy.ids = pairs; copy.id_count = 4;
  copy.values[0] = 20;
  Require(pde_apply_commands(doc, 0, "copy-full-alias-scope", &copy, 1) != nullptr,
          "copy the complete non-local marked scope as one new MCID");
  CheckTaggedContentSaved(doc, 4, 4);
  Require(pde_save_memory(doc) != nullptr, "save non-local ActualText scope copy");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(saved.data(), saved.size(), nullptr);
  FPDF_PAGE page = FPDF_LoadPage(reopened, 0);
  auto* holder = CPDFPageFromFPDFPage(page);
  auto* first = holder->GetPageObjectByIndex(2);
  auto* second = holder->GetPageObjectByIndex(3);
  Require(first->GetContentMarks()->GetMarkedContentID() ==
              second->GetContentMarks()->GetMarkedContentID() &&
          first->GetContentMarks()->GetMarkedContentID() !=
              holder->GetPageObjectByIndex(0)->GetContentMarks()->GetMarkedContentID() &&
          pdf_editor::tagged::ActualMark(first) == pdf_editor::tagged::ActualMark(second) &&
          pdf_editor::tagged::ActualMark(first)->GetParam()->GetUnicodeTextFor("ActualText") == L"ReadAsOne",
          "the copy retains one lexical ActualText and a fresh shared MCID");
  FPDF_ClosePage(page); FPDF_CloseDocument(reopened);
  Require(pde_close(doc) == 1, "close non-local whole-scope test");
}

void TestAdjacentTaggedParagraphMerge(const std::string& font_id) {
  const std::string fixture = Pdf({
      "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 9 0 R /MarkInfo << /Marked true >> >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 200] /StructParents 0 "
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      Stream("/P << /MCID 0 >> BDC BT /F1 14 Tf 20 155 Td (First) Tj ET EMC "
             "/P << /MCID 1 >> BDC BT /F1 14 Tf 60 155 Td (Second) Tj ET EMC "
             "/P << /MCID 2 >> BDC BT /F1 14 Tf 125 155 Td (Neighbor) Tj ET EMC"),
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      "<< /Type /StructElem /S /P /P 9 0 R /Pg 3 0 R /K 0 >>",
      "<< /Type /StructElem /S /Span /P 9 0 R /Pg 3 0 R /K 1 >>",
      "<< /Type /StructElem /S /P /P 9 0 R /Pg 3 0 R /K 2 >>",
      "<< /Type /StructTreeRoot /K [6 0 R 7 0 R 8 0 R] /ParentTree 10 0 R /ParentTreeNextKey 1 >>",
      "<< /Nums [0 [6 0 R 7 0 R 8 0 R]] >>",
  });
  const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(fixture.data()),
      static_cast<uint32_t>(fixture.size()), "merge-tagged-siblings", "merge-tagged-siblings", nullptr);
  Require(doc != 0, "open adjacent P/Span structure leaves");
  const std::string before = pde_describe_page(doc, 0);
  const auto blocks = TextBlockIds(before);
  const auto page_id = PageIdFromDescription(before);
  const char* ids[]{blocks[0].c_str(), blocks[1].c_str()};
  PdeEditCommand reflow{};
  reflow.type = 20; reflow.page_id = page_id.c_str(); reflow.ids = ids;
  reflow.id_count = 2; reflow.target_id = "merged-tagged-p";
  reflow.font_id = font_id.c_str(); reflow.text_utf8 = "First Second";
  reflow.flags = 3 | 1024; reflow.values[0] = 20; reflow.values[1] = 20;
  reflow.values[2] = 215; reflow.values[3] = 50; reflow.values[4] = 14;
  Require(pde_apply_commands(doc, 0, "tagged-sibling-merge", &reflow, 1) != nullptr &&
          pde_save_memory(doc) != nullptr, "merge ordinary adjacent P and Span leaves");
  const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(saved.data(), saved.size(), nullptr);
  FPDF_PAGE page = FPDF_LoadPage(reopened, 0);
  auto* native = CPDFDocumentFromFPDFDocument(reopened);
  auto* native_page = CPDFPageFromFPDFPage(page);
  const auto tree = native->GetRoot()->GetDictFor("StructTreeRoot");
  const auto roots = tree->GetArrayFor("K");
  const auto parent = pdf_editor::tagged::ParentArray(native, 0);
  Require(roots && roots->size() == 2 && roots->GetDictAt(0)->GetNameFor("S") == "P" &&
          roots->GetDictAt(1)->GetIntegerFor("K", -1) == 2 && parent && parent->size() == 4 &&
          !parent->GetDictAt(0) && !parent->GetDictAt(1) &&
          parent->GetDictAt(2).Get() == roots->GetDictAt(1).Get(),
          "old empty leaves and MCIDs are removed; untouched neighbor is preserved");
  CheckTaggedOwner(native, native_page, native_page, roots->GetDictAt(0).Get(),
                   native_page->GetPageObjectByIndex(0));
  Require(roots->GetDictAt(0)->GetDictFor("P").Get() == tree.Get(),
          "merged paragraph retains an actual root parent and page MCR");
  FPDF_ClosePage(page); FPDF_CloseDocument(reopened);
  Require(pde_undo(doc) != nullptr && pde_describe_page(doc, 0) == before,
          "undo restores both source structure leaves and parent references");
  Require(pde_close(doc) == 1, "close tagged paragraph merge test");
}

void TestTaggedUnderlineScope() {
  const auto doc = OpenTaggedContent("tagged-underline");
  const std::string before = RequireResult(pde_describe_page(doc, 0), "tagged underline page");
  const std::string page = PageIdFromDescription(before);
  const std::string block = TextBlockIds(before).front();
  const char* blocks[] = {block.c_str()};
  PdeEditCommand style{};
  style.type = 2; style.page_id = page.c_str(); style.ids = blocks; style.id_count = 1;
  style.flags = 32; style.values[5] = 1;
  Require(pde_apply_commands(doc, 0, "underline-tagged-first-object", &style, 1) != nullptr,
          "underline one object within a shared marked sequence");
  Require(Count(RequireResult(pde_describe_page(doc, 0), "tagged underline state"), "\"underline\":true") == 1,
          "underline selection does not mutate sibling mark lists");
  CheckTaggedContentSaved(doc, 4, 4);
  Require(pde_save_memory(doc) != nullptr, "save tagged underline for independent text extraction");
  const std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
  FPDF_DOCUMENT saved = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
  FPDF_PAGE parsed = saved ? FPDF_LoadPage(saved, 0) : nullptr;
  FPDF_TEXTPAGE text = parsed ? FPDFText_LoadPage(parsed) : nullptr;
  Require(text != nullptr, "load tagged underline text through PDFium public API");
  std::vector<unsigned short> buffer(static_cast<size_t>(FPDFText_CountChars(text)) + 1);
  const int written = FPDFText_GetText(text, 0, FPDFText_CountChars(text), buffer.data());
  Require(written > 0, "copy tagged underline text");
  const std::u16string copied(buffer.begin(), buffer.begin() + written - 1);
  Require(copied.find(u"AlphaBetaGamma") != std::u16string::npos &&
          copied.find(u"AlphaBetaGamma") == copied.rfind(u"AlphaBetaGamma"),
          "derived underline keeps one ActualText scope rather than duplicating accessible text");
  FPDFText_ClosePage(text); FPDF_ClosePage(parsed); FPDF_CloseDocument(saved);
  style.values[5] = 0;
  Require(pde_apply_commands(doc, 1, "clear-tagged-underline", &style, 1) != nullptr,
          "clear underline after its marked decorative path has been generated");
  CheckTaggedContentSaved(doc, 3, 3);
  Require(pde_close(doc) == 1, "close tagged underline fixture");
}

void RunTaggedContentTests(const std::string& font_id) {
  TestTaggedUnderlineScope();
  TestNestedTaggedFormIsolation();
  TestWholeNonLocalActualTextCopy();
  if (!font_id.empty()) TestAdjacentTaggedParagraphMerge(font_id);
  {
    const uint32_t doc = OpenTaggedContent("tagged-content-text");
    const std::string before = pde_describe_page(doc, 0);
    const auto blocks = TextBlockIds(before);
    Require(blocks.size() == 3, "three parts of one marked scope are selectable");
    PdeTextEdit edit{0, blocks[0].c_str(), 0, 5, "Alto", nullptr};
    Require(pde_apply_text(doc, 0, "tagged-replace-shared", &edit, 1) != nullptr,
            "replace just the first object in a shared ActualText scope");
    CheckTaggedContentSaved(doc, 3, 3);
    Require(pde_save_memory(doc) != nullptr, "save shared ActualText replacement");
    const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
    FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(saved.data(), saved.size(), nullptr);
    FPDF_PAGE page = FPDF_LoadPage(reopened, 0);
    auto* first = CPDFPageFromFPDFPage(page)->GetPageObjectByIndex(0);
    const auto* mark = pdf_editor::tagged::ActualMark(first);
    Require(mark && mark->GetParam()->GetUnicodeTextFor("ActualText") == L"AltoBetaGamma",
            "shared ActualText is recalculated for the full lexical scope");
    FPDF_ClosePage(page); FPDF_CloseDocument(reopened);
    Require(pde_undo(doc) != nullptr && pde_describe_page(doc, 0) == before,
            "undo shared ActualText replacement");
    Require(pde_close(doc) == 1, "close tagged text test");
  }
  {
    const uint32_t doc = OpenTaggedContent("tagged-content-copy");
    const std::string before = RequireResult(pde_describe_page(doc, 0), "describe tagged copy source");
    const auto blocks = TextBlockIds(before);
    Require(blocks.size() == 3 && before.find("Alpha") != std::string::npos &&
            before.find("Beta") != std::string::npos, "shared ActualText still exposes editable objects");
    const std::string page = PageIdFromDescription(before);
    const std::string source = FirstObjectId(before);
    const char* pairs[]{source.c_str(), "tagged-copy"};
    PdeEditCommand copy{};
    copy.type = 16; copy.page_id = page.c_str(); copy.ids = pairs; copy.id_count = 2;
    copy.values[0] = 25;
    const char* missing[]{"does-not-exist", "unused-copy"};
    PdeEditCommand failed[2]{copy, copy};
    failed[1].ids = missing;
    Require(pde_apply_commands(doc, 0, "tagged-copy-rollback", failed, 2) == nullptr &&
            pde_document_revision(doc) == 0 && pde_describe_page(doc, 0) == before,
            "failed two-command tagged transaction leaves source and tree untouched");
    Require(pde_apply_commands(doc, 0, "tag-copy-one-of-three", &copy, 1) != nullptr,
            "copy one object without reusing its source MCID");
    CheckTaggedContentSaved(doc, 4, 4);
    Require(pde_undo(doc) != nullptr && pde_describe_page(doc, 0) == before,
            "undo restores original shared scope without a copied MCR");
    Require(pde_close(doc) == 1, "close tagged copy test");
  }
  {
    const uint32_t doc = OpenTaggedContent("tagged-content-range");
    const std::string before = pde_describe_page(doc, 0);
    const auto blocks = TextBlockIds(before);
    const std::string page = PageIdFromDescription(before);
    const char* ids[]{blocks[0].c_str()};
    PdeEditCommand style{};
    style.type = 2; style.page_id = page.c_str(); style.ids = ids; style.id_count = 1;
    style.flags = 16 | 4; style.start_utf16 = 1; style.end_utf16 = 3; style.values[1] = 1;
    Require(pde_apply_commands(doc, 0, "tagged-style-shared", &style, 1) != nullptr,
            "range formatting keeps all pieces in their shared lexical MCID");
    CheckTaggedContentSaved(doc, 5, 5);
    Require(pde_undo(doc) != nullptr && pde_describe_page(doc, 0) == before,
            "undo tagged range styling");
    Require(pde_close(doc) == 1, "close tagged range test");
  }
  {
    const uint32_t doc = OpenTaggedContent("tagged-content-group");
    const auto before = std::string(pde_describe_page(doc, 0));
    const auto page = PageIdFromDescription(before);
    const auto members = TaggedObjectIds(before);
    Require(members.size() == 3, "three tagged objects have distinct object IDs");
    const char* ids[]{members[0].c_str(), members[1].c_str()};
    PdeEditCommand group{};
    group.type = 26; group.page_id = page.c_str(); group.target_id = "tagged-group";
    group.ids = ids; group.id_count = 2;
    Require(pde_apply_commands(doc, 0, "group-partial-scope", &group, 1) != nullptr,
            "group only part of a three-object tagged scope");
    CheckTaggedContentSaved(doc, 2, 3, 2);
    PdeEditCommand ungroup{};
    ungroup.type = 27; ungroup.page_id = page.c_str(); ungroup.target_id = "tagged-group";
    Require(pde_apply_commands(doc, 1, "ungroup-partial-scope", &ungroup, 1) != nullptr,
            "ungroup tagged Form back into distinct page MCIDs");
    CheckTaggedContentSaved(doc, 3, 3);
    Require(pde_undo(doc) != nullptr &&
            std::string(pde_describe_page(doc, 0)).find("tagged-group") != std::string::npos,
            "undo ungroup restores Form structure");
    Require(pde_close(doc) == 1, "close tagged group test");
  }
  {
    const std::string fixture = Pdf({
        "<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 7 0 R /MarkInfo << /Marked true >> >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 260 200] /StructParents 0 "
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        Stream("/Span << /MCID 0 /ActualText (ABCD) >> BDC "
               "BT /F1 14 Tf 20 155 Td (A) Tj ET BT /F1 14 Tf 40 155 Td (B) Tj ET "
               "BT /F1 14 Tf 60 155 Td (C) Tj ET BT /F1 14 Tf 80 155 Td (D) Tj ET EMC"),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        "<< /Type /StructElem /S /P /P 7 0 R /Pg 3 0 R /K 0 >>",
        "<< /Type /StructTreeRoot /K 6 0 R /ParentTree 8 0 R /ParentTreeNextKey 1 >>",
        "<< /Nums [0 [6 0 R]] >>",
    });
    const uint32_t doc = pde_open_memory(reinterpret_cast<const uint8_t*>(fixture.data()),
        static_cast<uint32_t>(fixture.size()), "tagged-middle-group", "tagged-middle-group", nullptr);
    Require(doc != 0, "open four-object tagged scope");
    const auto description = std::string(pde_describe_page(doc, 0));
    const auto object_ids = TaggedObjectIds(description);
    Require(object_ids.size() == 4, "four source objects in one actual-text scope");
    const auto page_id = PageIdFromDescription(description);
    const char* selected[]{object_ids[1].c_str(), object_ids[2].c_str()};
    PdeEditCommand group{};
    group.type = 26; group.page_id = page_id.c_str(); group.target_id = "tagged-middle";
    group.ids = selected; group.id_count = 2;
    Require(pde_apply_commands(doc, 0, "group-middle-scope", &group, 1) != nullptr,
            "group the middle of one shared-MCID lexical sequence");
    CheckTaggedContentSaved(doc, 3, 4, 2);
    Require(pde_save_memory(doc) != nullptr, "save middle-scope group");
    const std::vector<uint8_t> bytes(pde_binary_data(), pde_binary_data() + pde_binary_size());
    FPDF_DOCUMENT saved = FPDF_LoadMemDocument64(bytes.data(), bytes.size(), nullptr);
    FPDF_PAGE parsed = FPDF_LoadPage(saved, 0);
    auto* native_page = CPDFPageFromFPDFPage(parsed);
    Require(native_page->GetPageObjectByIndex(0)->GetContentMarks()->GetMarkedContentID() !=
            native_page->GetPageObjectByIndex(2)->GetContentMarks()->GetMarkedContentID(),
            "page-side prefix and suffix have different MCIDs after split");
    FPDF_ClosePage(parsed); FPDF_CloseDocument(saved);
    PdeEditCommand ungroup{};
    ungroup.type = 27; ungroup.page_id = page_id.c_str(); ungroup.target_id = "tagged-middle";
    Require(pde_apply_commands(doc, 1, "ungroup-middle-scope", &ungroup, 1) != nullptr,
            "ungroup a middle-scope Form without merging split page MCIDs");
    CheckTaggedContentSaved(doc, 4, 4);
    Require(pde_close(doc) == 1, "close middle-scope group fixture");
  }
  if (!font_id.empty()) {
    const uint32_t doc = OpenTaggedContent("tagged-content-reflow");
    const auto before = std::string(pde_describe_page(doc, 0));
    const auto page = PageIdFromDescription(before);
    const auto blocks = TextBlockIds(before);
    const char* ids[]{blocks[0].c_str(), blocks[1].c_str()};
    PdeEditCommand reflow{};
    reflow.type = 20; reflow.page_id = page.c_str(); reflow.target_id = "tagged-paragraph";
    reflow.ids = ids; reflow.id_count = 2; reflow.font_id = font_id.c_str();
    reflow.flags = 3 | 1024 | 32 | 64;
    reflow.text_utf8 = "Alpha Beta";
    reflow.values[0] = 20; reflow.values[1] = 20;
    reflow.values[2] = 210; reflow.values[3] = 60; reflow.values[4] = 14;
    Require(pde_apply_commands(doc, 0, "tagged-justify-reflow", &reflow, 1) != nullptr,
            "justify/reflow tagged source objects while retaining their structure element");
    CheckTaggedContentSaved(doc, 2, 2);
    const auto styled_block = TextBlockIds(pde_describe_page(doc, 0));
    Require(styled_block.size() == 2, "tagged paragraph and untouched neighbor remain selectable");
    const char* style_ids[]{styled_block[0].c_str()};
    PdeEditCommand style{};
    style.type = 2; style.page_id = page.c_str(); style.ids = style_ids; style.id_count = 1;
    style.flags = 16 | 4; style.start_utf16 = 0; style.end_utf16 = 5;
    style.values[1] = 1;
    Require(pde_apply_commands(doc, 1, "tagged-paragraph-style", &style, 1) != nullptr,
            "style part of a tagged logical paragraph without dropping outer MCID");
    CheckTaggedContentSaved(doc, 2, 2);
    Require(pde_undo(doc) != nullptr && pde_undo(doc) != nullptr &&
            pde_describe_page(doc, 0) == before,
            "undo tagged reflow and range styling including old MCID and ActualText");
    Require(pde_close(doc) == 1, "close tagged reflow test");
  }
  if (!font_id.empty()) {
    const uint32_t doc = OpenTaggedContent("tagged-content-insert");
    const auto page_id = PageIdFromDescription(pde_describe_page(doc, 0));
    PdeEditCommand insert{};
    insert.type = 3; insert.page_id = page_id.c_str(); insert.target_id = "new-tagged-paragraph";
    insert.font_id = font_id.c_str(); insert.text_utf8 = "New marked paragraph";
    insert.flags = 3 | 1024; insert.values[0] = 20; insert.values[1] = 80;
    insert.values[2] = 210; insert.values[3] = 50; insert.values[4] = 14;
    Require(pde_apply_commands(doc, 0, "new-tagged-structure", &insert, 1) != nullptr &&
            pde_save_memory(doc) != nullptr, "new paragraph acquires real PDF structure");
    const std::vector<uint8_t> saved(pde_binary_data(), pde_binary_data() + pde_binary_size());
    FPDF_DOCUMENT reopened = FPDF_LoadMemDocument64(saved.data(), saved.size(), nullptr);
    FPDF_PAGE page = FPDF_LoadPage(reopened, 0);
    auto* native = CPDFDocumentFromFPDFDocument(reopened);
    const auto tree = native->GetRoot()->GetDictFor("StructTreeRoot");
    const auto roots = tree ? tree->GetArrayFor("K") : nullptr;
    Require(roots && roots->size() == 2 && roots->GetDictAt(0) && roots->GetDictAt(1),
            "new tagged paragraph has a distinct StructElem under the root");
    auto* native_page = CPDFPageFromFPDFPage(page);
    auto* added = native_page->GetPageObjectByIndex(3);
    Require(added && added->AsForm(), "new paragraph remains a real Form");
    CheckTaggedOwner(native, native_page, native_page, roots->GetDictAt(1).Get(), added);
    Require(roots->GetDictAt(1)->GetDictFor("P").Get() == tree.Get(),
            "new paragraph P is the live root, not a copied dictionary");
    FPDF_TEXTPAGE extracted = FPDFText_LoadPage(page);
    Require(extracted != nullptr, "load saved tagged paragraph text independently of editor metadata");
    const int character_count = FPDFText_CountChars(extracted);
    std::vector<unsigned short> text_buffer(static_cast<size_t>(character_count) + 1);
    const int copied_count = FPDFText_GetText(extracted, 0, character_count, text_buffer.data());
    Require(copied_count > 0, "extract saved tagged paragraph characters");
    const std::u16string copied(text_buffer.begin(), text_buffer.begin() + copied_count - 1);
    Require(copied.find(u"New marked paragraph") != std::u16string::npos &&
            copied.find(u"New marked paragraph") == copied.rfind(u"New marked paragraph"),
            "tagged paragraph stays searchable and copies once in the PDFium reader");
    FPDFText_ClosePage(extracted);
    FPDF_ClosePage(page); FPDF_CloseDocument(reopened);
    Require(pde_close(doc) == 1, "close tagged paragraph insert test");
  }
}
