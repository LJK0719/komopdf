// Included after page insertion/deletion helpers. Flow rewrites are ordinary
// candidate mutations: the existing transaction owns their rollback and undo.

float ParagraphRoom(FPDF_PAGE page, const Rect& box, FPDF_PAGEOBJECT excluded) {
  auto* native = CPDFPageFromFPDFPage(page);
  Matrix to_page, to_pdf;
  if (!GetPageMatrices(page, &to_page, &to_pdf)) return 0;
  const float page_height = native->GetPageHeight() * GetUserUnit(native);
  float limit = page_height;
  for (int i = 0; i < FPDFPage_CountObjects(page); ++i) {
    auto object = FPDFPage_GetObject(page, i);
    if (object == excluded || !IsActiveObject(object) || HasObjectMark(object, "KomoUnderlinePath")) continue;
    float left = 0, bottom = 0, right = 0, top = 0;
    if (!FPDFPageObj_GetBounds(object, &left, &bottom, &right, &top)) continue;
    const Rect bounds = TransformBounds(left, bottom, right, top, to_page);
    // Backgrounds enclosing the insertion point are not downstream obstacles.
    if (bounds.y >= box.y + box.height - 0.01 && bounds.x < box.x + box.width && bounds.x + bounds.width > box.x)
      limit = std::min(limit, static_cast<float>(bounds.y));
  }
  return std::max(0.0f, limit - static_cast<float>(box.y));
}

pdf_editor::ParagraphRequest SliceParagraph(const pdf_editor::ParagraphRequest& original,
    const LayoutText& decoded, uint32_t start, uint32_t end) {
  auto result = original;
  result.utf8 = original.utf8.substr(decoded.byte_offsets[start], decoded.byte_offsets[end] - decoded.byte_offsets[start]);
  result.styles.clear();
  result.continues = end < decoded.utf16.size() && end > start && decoded.utf16[end - 1] != u'\n' && decoded.utf16[end - 1] != u'\r';
  for (auto run : original.styles) {
    if (run.range.end <= start || run.range.start >= end) continue;
    run.range = {std::max(run.range.start, start) - start, std::min(run.range.end, end) - start};
    result.styles.push_back(run);
  }
  if (start && decoded.utf16[start - 1] != u'\n' && decoded.utf16[start - 1] != u'\r') {
    result.first_line_indent = 0;
    result.space_before = 0;
  }
  return result;
}

bool ReflowParagraphAcrossPages(const Document& document, FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata, const EditCommand& command, const std::string& object_id,
    const std::vector<std::shared_ptr<const FontResource>>& fonts,
    const pdf_editor::ParagraphRequest& request, TextInsertLayoutResult* layout) {
  struct Part { std::string page_id; size_t position; uint32_t start; ObjectIdentity identity; Rect box; };
  std::vector<Part> old_parts;
  RetainPtr<const CPDF_Dictionary> old_flow;
  std::string flow_id;
  // Find the edited object before touching any page vectors.
  for (size_t p = 0; p < metadata->pages.size() && flow_id.empty(); ++p) {
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(p)));
    for (size_t i = 0; i < metadata->pages[p].objects.size(); ++i) {
      if (metadata->pages[p].objects[i].id != object_id) continue;
      auto object = FPDFPage_GetObject(page.get(), static_cast<int>(i));
      const auto info = ParagraphMetadata(object);
      old_flow = info->GetDictFor("Flow");
      if (old_flow) {
        const auto id = old_flow->GetByteStringFor("Id");
        flow_id.assign(id.c_str(), id.GetLength());
      }
      if (flow_id.empty()) flow_id = object_id;
      break;
    }
  }
  if (flow_id.empty()) { SetUnexpectedError(); return false; }
  for (size_t p = 0; p < metadata->pages.size(); ++p) {
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(p)));
    Matrix to_page, to_pdf;
    if (!GetPageMatrices(page.get(), &to_page, &to_pdf)) return false;
    for (size_t i = 0; i < metadata->pages[p].objects.size(); ++i) {
      auto object = FPDFPage_GetObject(page.get(), static_cast<int>(i));
      const auto info = ParagraphMetadata(object);
      if (!info) continue;
      const auto flow = info->GetDictFor("Flow");
      if (metadata->pages[p].objects[i].id != object_id &&
          (!old_flow || !flow || flow->GetObjNum() != old_flow->GetObjNum())) continue;
      FS_MATRIX matrix{};
      if (!FPDFPageObj_GetMatrix(object, &matrix)) return false;
      const Matrix placement = MatrixFromFs(matrix).Then(to_page);
      if (std::abs(placement.a - 1) > 0.01 || std::abs(placement.b) > 0.01 ||
          std::abs(placement.c) > 0.01 || std::abs(placement.d + 1) > 0.01) {
        SetError("UNSUPPORTED_CAPABILITY", "Automatic paragraph flow requires an unrotated, unscaled text frame."); return false;
      }
      old_parts.push_back({metadata->pages[p].id, i, static_cast<uint32_t>(info->GetIntegerFor("FlowStart")),
          metadata->pages[p].objects[i], TransformBounds(0, 0, info->GetFloatFor("Width"), info->GetFloatFor("Height"),
          MatrixFromFs(matrix).Then(to_page))});
    }
  }
  if (old_parts.empty()) { SetUnexpectedError(); return false; }
  std::stable_sort(old_parts.begin(), old_parts.end(), [](const Part& a, const Part& b) { return a.start < b.start; });
  const Part anchor = old_parts.front();
  const auto anchor_index = FindPageIndex(*metadata, anchor.page_id);
  ScopedPage anchor_page(FPDF_LoadPage(pdf, static_cast<int>(*anchor_index)));
  auto* native_anchor = CPDFPageFromFPDFPage(anchor_page.get());
  const float page_width = native_anchor->GetPageWidth() * GetUserUnit(native_anchor);
  const float page_height = native_anchor->GetPageHeight() * GetUserUnit(native_anchor);
  const float margin = std::min(36.0f, page_height * 0.05f);
  RetainPtr<CPDF_Dictionary> anchor_element;
  const auto anchor_marks = native_anchor->GetPageObjectByIndex(anchor.position)->GetContentMarks()->Clone();
  const int anchor_mcid = native_anchor->GetPageObjectByIndex(anchor.position)->GetContentMarks()->GetMarkedContentID();
  if (anchor_mcid >= 0) anchor_element = pdf_editor::tagged::ElementFor(
      CPDFDocumentFromFPDFDocument(pdf), native_anchor, anchor_mcid);
  anchor_page = ScopedPage(nullptr);

  // Remove only members of this logical flow. Non-flow objects stay in place.
  for (size_t p = 0; p < metadata->pages.size(); ++p) {
    std::vector<size_t> positions;
    for (const auto& part : old_parts) if (part.page_id == metadata->pages[p].id) positions.push_back(part.position);
    if (positions.empty()) continue;
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(p)));
    auto* native = CPDFPageFromFPDFPage(page.get());
    std::sort(positions.rbegin(), positions.rend());
    for (size_t position : positions) {
      auto* object = native->GetPageObjectByIndex(position);
      const int mcid = object->GetContentMarks()->GetMarkedContentID();
      if (!native->RemovePageObject(object)) return false;
      if (mcid >= 0 && !(!request.utf8.empty() && metadata->pages[p].id == anchor.page_id && position == anchor.position) &&
          !pdf_editor::tagged::HasOtherMember(native, mcid, nullptr))
        pdf_editor::tagged::ClearMcid(CPDFDocumentFromFPDFDocument(pdf), native, mcid);
      metadata->pages[p].objects.erase(metadata->pages[p].objects.begin() + position);
    }
    metadata->flow_changed_pages.insert(metadata->pages[p].id);
    if (!FPDFPage_GenerateContent(page.get())) return false;
  }
  const auto remove_unused_pages = [&](const std::set<std::string>& used_pages) {
    for (const auto& part : old_parts) {
      if (used_pages.contains(part.page_id)) continue;
      const auto index = FindPageIndex(*metadata, part.page_id);
      if (!index) continue;
      bool empty_generated = false;
      {
        ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(*index)));
        const auto marker = CPDFPageFromFPDFPage(page.get())->GetDict()->GetByteStringFor("KomoFlowPage");
        empty_generated = std::string_view(marker.c_str(), marker.GetLength()) == flow_id &&
            FPDFPage_CountObjects(page.get()) == 0 && FPDFPage_GetAnnotCount(page.get()) == 0;
      }
      auto* doc = CPDFDocumentFromFPDFDocument(pdf);
      const std::set<size_t> removing{*index};
      if (empty_generated && !OutlineTargetsDeletedPages(pdf, doc, removing) &&
          !SurvivingPageLinksTargetDeletedPages(pdf, doc, metadata->pages.size(), removing)) {
        EditCommand remove; remove.ids = {part.page_id};
        if (!ApplyPagesDelete(pdf, metadata, remove)) return false;
      }
    }
    return true;
  };
  if (request.utf8.empty()) {
    if (layout) { layout->bounds = {anchor.box.x, anchor.box.y, 0, 0}; layout->overflow = false; layout->lines.clear(); }
    return remove_unused_pages({});
  }
  LayoutText decoded;
  if (!DecodeLayoutText(request.utf8, &decoded)) return false;
  const uint32_t length = static_cast<uint32_t>(decoded.utf16.size());
  auto* native_doc = CPDFDocumentFromFPDFDocument(pdf);
  RetainPtr<CPDF_Dictionary> flow;
  uint32_t offset = 0;
  size_t part_number = 0;
  std::string previous_page = anchor.page_id;
  std::string first_page = anchor.page_id;
  const auto add_page = [&](size_t number, const std::string& after) -> std::optional<std::string> {
    std::string id = anchor.identity.id + ":page:" + std::to_string(number);
    if (MetadataContainsId(*metadata, id)) id += ":" + command.transaction_id;
    EditCommand insert;
    insert.page_id = id; insert.target_id = after;
    insert.values[0] = page_width; insert.values[1] = page_height;
    MigrateAllDestinations(pdf);
    if (!ApplyPageInsert(pdf, metadata, insert)) return std::nullopt;
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(*FindPageIndex(*metadata, id))));
    CPDFPageFromFPDFPage(page.get())->GetMutableDict()->SetNewFor<CPDF_String>("KomoFlowPage", ByteString(flow_id.c_str()));
    return id;
  };
  std::set<std::string> used_pages;
  if (layout) { layout->overflow = false; layout->lines.clear(); layout->bounds = anchor.box; }
  while (offset < length) {
    if (part_number >= 4096) { SetError("RESOURCE_LIMIT", "This paragraph exceeds the page limit."); return false; }
    std::string page_id = first_page;
    Rect box = anchor.box;
    if (first_page != anchor.page_id) box.y = margin;
    if (part_number) {
      box.y = margin;
      if (part_number < old_parts.size()) {
        page_id = old_parts[part_number].page_id;
        box = old_parts[part_number].box;
      } else {
        const auto added = add_page(part_number, previous_page);
        if (!added) return false;
        page_id = *added;
      }
    }
    const size_t page_index = *FindPageIndex(*metadata, page_id);
    ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(page_index)));
    const float available = ParagraphRoom(page.get(), box, nullptr) - ((part_number || first_page != anchor.page_id) ? margin : 0);
    auto remaining = SliceParagraph(request, decoded, offset, length);
    remaining.height = std::max(1.0f, available);
    auto part_fonts = fonts;
    CompactParagraphFonts(&remaining, &part_fonts);
    pdf_editor::ParagraphResult measured;
    if (!CreateParagraphObject(pdf, part_fonts, remaining, &measured)) return false;
    std::unique_ptr<CPDF_PageObject> measured_object(CPDFPageObjectFromFPDFPageObject(measured.object));
    if (!flow) {
      const auto cloned = ParagraphMetadata(measured.object)->Clone();
      flow = pdfium::WrapRetain(cloned->AsMutableDictionary());
      flow->SetNewFor<CPDF_String>("Id", ByteString(flow_id.c_str()));
      flow->SetNewFor<CPDF_Number>("Version", 3);
      native_doc->AddIndirectObject(flow);
    }
    size_t fit = 0;
    for (const auto& line : measured.lines) {
      if (line.bounds.x < -0.01f || line.bounds.x + line.bounds.width > request.width + 0.01f) {
        SetError("UNSUPPORTED_CAPABILITY", "A character is wider than the paragraph. Widen the paragraph to continue."); return false;
      }
      const float after = &line == &measured.lines.back() ? request.space_after : 0;
      if (line.bounds.y + line.bounds.height + after > available + 0.01f) break;
      ++fit;
    }
    if (!fit && part_number == 0 && first_page == anchor.page_id) {
      if (anchor_mcid >= 0) pdf_editor::tagged::ClearMcid(native_doc, CPDFPageFromFPDFPage(page.get()), anchor_mcid);
      const auto added = add_page(0, anchor.page_id);
      if (!added) return false;
      first_page = *added;
      continue;
    }
    if (!fit) {
      SetError("UNSUPPORTED_CAPABILITY", "A single line cannot fit on an empty page with the chosen paragraph settings."); return false;
    }
    const uint32_t end = fit == measured.lines.size() ? length : offset + measured.lines[fit].text_range.start;
    if (end <= offset) { SetUnexpectedError(); return false; }
    auto part_request = SliceParagraph(request, decoded, offset, end);
    part_request.height = std::max(1.0f, measured.lines[fit - 1].bounds.y + measured.lines[fit - 1].bounds.height +
        (end == length ? request.space_after : 0));
    part_fonts = fonts;
    CompactParagraphFonts(&part_request, &part_fonts);
    pdf_editor::ParagraphResult part;
    if (!CreateParagraphObject(pdf, part_fonts, part_request, &part)) return false;
    std::unique_ptr<CPDF_PageObject> object(CPDFPageObjectFromFPDFPageObject(part.object));
    auto info = CPDFPageObjectFromFPDFPageObject(part.object)->AsForm()->form()->GetMutableDict()->GetMutableDictFor("KomoParagraph");
    info->SetNewFor<CPDF_Reference>("Flow", native_doc, flow->GetObjNum());
    info->SetNewFor<CPDF_Number>("FlowStart", static_cast<int>(offset));
    info->SetNewFor<CPDF_Number>("FlowEnd", static_cast<int>(end));
    if (!SetObjectMatrix(page.get(), part.object, Matrix{1, 0, 0, -1, box.x, box.y + part_request.height})) return false;
    ObjectIdentity identity;
    const auto* retained = part_number < old_parts.size() ? &old_parts[part_number].identity : nullptr;
    const std::string seed = part_number ? anchor.identity.id + ":part:" + std::to_string(part_number) : anchor.identity.id;
    if (!ParagraphIdentity(document, part.object, seed, retained, &identity)) return false;
    if (retained && old_parts[part_number].page_id != page_id) {
      auto [move, added] = metadata->paragraph_relocations.try_emplace(identity.text_block_id,
          std::make_pair(old_parts[part_number].page_id, page_id));
      if (!added) move->second.second = page_id;
    }
    auto* native = CPDFPageFromFPDFPage(page.get());
    if (part_number == 0 && page_id == anchor.page_id) {
      object->SetContentMarks(*anchor_marks);
      if (pdf_editor::tagged::ActualMark(object.get())) pdf_editor::tagged::SetLocalActualText(object.get(), part_request.utf8);
    } else if (!pdf_editor::tagged::TagNewParagraph(native_doc, native, object.get(), part_request.utf8, anchor_element.Get())) return false;
    const size_t position = part_number ? native->GetPageObjectCount() : std::min(anchor.position, native->GetPageObjectCount());
    if (!native->InsertPageObjectAtIndex(position, std::move(object))) return false;
    metadata->pages[page_index].objects.insert(metadata->pages[page_index].objects.begin() + position, std::move(identity));
    if (!FPDFPage_GenerateContent(page.get())) return false;
    metadata->flow_changed_pages.insert(page_id);
    if (layout && part_number == 0) {
      layout->bounds = {box.x, box.y, request.width, part_request.height};
      for (const auto& line : part.lines) layout->lines.push_back({
          {box.x + line.bounds.x, box.y + line.bounds.y, line.bounds.width, line.bounds.height},
          line.text_range.start, line.text_range.end});
    }
    used_pages.insert(page_id); previous_page = page_id;
    offset = end; ++part_number;
  }
  return remove_unused_pages(used_pages);
}
