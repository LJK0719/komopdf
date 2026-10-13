// Text frame changes are candidate edits, never affine glyph scaling.

bool ApplyTextResize(const Document& document, FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata, const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) return false;
  std::vector<ObjectTarget> targets;
  for (const auto& id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], id, true, &target)) return false;
    if (target.path.size() != 1) {
      SetError("UNSUPPORTED_CAPABILITY", "Resize the containing text frame rather than a nested text object.");
      return false;
    }
    targets.push_back(target);
  }
  auto info = ParagraphMetadata(targets.front().object);
  const auto flow = info ? info->GetDictFor("Flow") : nullptr;
  if (info && targets.size() != 1) {
    SetError("INVALID_REQUEST", "Select one logical text frame to resize."); return false;
  }
  struct Part { size_t page, index; uint32_t start; ObjectIdentity identity; };
  std::vector<Part> parts;
  if (flow) {
    for (size_t p = 0; p < metadata->pages.size(); ++p) {
      ScopedPage candidate(FPDF_LoadPage(pdf, static_cast<int>(p)));
      for (size_t i = 0; i < metadata->pages[p].objects.size(); ++i) {
        auto object = FPDFPage_GetObject(candidate.get(), static_cast<int>(i));
        const auto stored = ParagraphMetadata(object);
        const auto shared = stored ? stored->GetDictFor("Flow") : nullptr;
        if (!shared || shared->GetObjNum() != flow->GetObjNum()) continue;
        FS_MATRIX matrix{}; Matrix to_page, to_pdf;
        if (!FPDFPageObj_GetMatrix(object, &matrix) || !GetPageMatrices(candidate.get(), &to_page, &to_pdf)) return false;
        const auto placement = MatrixFromFs(matrix).Then(to_page);
        if (std::abs(placement.a - 1) > 0.01 || std::abs(placement.b) > 0.01 ||
            std::abs(placement.c) > 0.01 || std::abs(placement.d + 1) > 0.01) {
          SetError("UNSUPPORTED_CAPABILITY", "This continued paragraph has a transformed frame."); return false;
        }
        parts.push_back({p, i, static_cast<uint32_t>(stored->GetIntegerFor("FlowStart")), metadata->pages[p].objects[i]});
      }
    }
    std::sort(parts.begin(), parts.end(), [](const Part& a, const Part& b) { return a.start < b.start; });
    if (parts.empty() || parts.front().start != 0) { SetUnexpectedError(); return false; }
    page_index = parts.front().page;
    page = ScopedPage(FPDF_LoadPage(pdf, static_cast<int>(page_index)));
    ObjectTarget anchor;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], parts.front().identity.text_block_id, true, &anchor)) return false;
    targets = {anchor}; info = ParagraphMetadata(anchor.object);
  }
  auto* native_page = CPDFPageFromFPDFPage(page.get());
  auto* native_doc = CPDFDocumentFromFPDFDocument(pdf);
  auto* old_object = CPDFPageObjectFromFPDFPageObject(targets.front().object);
  const auto original_marks = old_object->GetContentMarks()->Clone();
  const int original_mcid = original_marks->GetMarkedContentID();
  if (original_mcid >= 0 &&
      (!pdf_editor::tagged::ElementFor(native_doc, native_page, original_mcid) ||
       pdf_editor::tagged::HasOtherMember(native_page, original_mcid, old_object))) {
    SetError("UNSUPPORTED_CAPABILITY", "The selected text shares a structure scope with other objects."); return false;
  }
  ObjectIdentity retained = *targets.front().identity;
  FS_MATRIX original_matrix{};
  if (!FPDFPageObj_GetMatrix(targets.front().object, &original_matrix)) return false;
  Matrix matrix = MatrixFromFs(original_matrix);
  float old_width = 0, old_height = 0;
  pdf_editor::ParagraphRequest request;
  std::vector<std::shared_ptr<const FontResource>> fonts;
  std::vector<std::unique_ptr<CPDF_TextObject>> source_children;
  if (info) {
    const auto logical = flow ? flow : info;
    const auto raw = logical->GetUnicodeTextFor("Text").ToUTF8();
    request.utf8.assign(raw.c_str(), raw.GetLength());
    if (!ReadParagraphStyles(logical.Get(), Utf16Length(request.utf8), resources,
                             &fonts, &request, native_doc)) return false;
    old_width = info->GetFloatFor("Width"); old_height = info->GetFloatFor("Height");
  } else {
    if (!MaterializeSourceParagraph(page.get(), targets, matrix, &request, &fonts,
                                    &old_width, &old_height, &source_children)) return false;
    const float frame_left = -request.text_inset;
    float ascent = 0, descent = 0;
    const auto font = FPDFFontFromCPDFFont(fonts.front()->source_font);
    if (!FPDFFont_GetAscent(font, request.font_size, &ascent) ||
        !FPDFFont_GetDescent(font, request.font_size, &descent)) return false;
    const float step = request.line_spacing > 0 ? request.line_spacing : request.font_size * request.line_height;
    const float frame_top = request.baseline_offset + std::max(0.0f, step - ascent + descent) / 2 + ascent;
    matrix = Matrix{1, 0, 0, 1, frame_left, frame_top - old_height}.Then(matrix);
  }
  request.width = static_cast<float>(command.values[2]);
  request.height = static_cast<float>(command.values[3]);
  request.fixed_frame = true;
  const Matrix old_frame_matrix = matrix;
  const float dy = old_height - static_cast<float>(command.values[1]) - request.height;
  matrix.e += matrix.a * command.values[0] + matrix.c * dy;
  matrix.f += matrix.b * command.values[0] + matrix.d * dy;
  const bool preserve_source = !info && std::abs(request.width - old_width) < 0.02f;
  const bool preserve_frame = info && !flow && std::abs(request.width - old_width) < 0.02f;
  pdf_editor::ParagraphResult paragraph;
  if (preserve_frame) {
    const auto cloned = old_object->AsForm()->form()->GetMutableStreamForEditing()->Clone();
    auto stream = pdfium::WrapRetain(cloned->AsMutableStream());
    native_doc->AddIndirectObject(stream);
    auto dictionary = stream->GetMutableDict();
    // Parse the stored operators without baking the old/new frame BBox into
    // each glyph's clip path; the Form itself applies the new container clip.
    dictionary->RemoveFor("BBox");
    auto stored = dictionary->GetMutableDictFor("KomoParagraph");
    stored->SetNewFor<CPDF_Number>("Height", request.height);
    stored->SetNewFor<CPDF_Name>("Sizing", "Fixed");
    auto form = std::make_unique<CPDF_Form>(native_doc, nullptr, stream, nullptr);
    form->ParseContent();
    dictionary->SetRectFor("BBox", CFX_FloatRect(0, 0, request.width, request.height));
    const CFX_Matrix shift(1, 0, 0, 1, 0, request.height - old_height);
    for (const auto& child : *form) {
      child->Transform(shift); child->TransformClipPath(shift); child->SetDirty(true);
    }
    CPDF_PageContentGenerator(form.get()).GenerateFormContentForEditing(form.get());
    auto object = std::make_unique<CPDF_FormObject>(CPDF_PageObject::kNoContentStream, std::move(form), CFX_Matrix());
    object->SetRect(CFX_FloatRect(0, 0, request.width, request.height)); object->SetDirty(true);
    paragraph.object = FPDFPageObjectFromCPDFPageObject(object.release());
  } else if (preserve_source) {
    LayoutText logical;
    if (!DecodeLayoutText(request.utf8, &logical)) return false;
    std::vector<pdf_editor::ParagraphFont> faces;
    for (const auto& font : fonts) faces.push_back({font->id, font->face, font->SfntBytes(), font->source_font});
    std::string error;
    if (!pdf_editor::CreatePreservedTextFrame(pdf, faces, request,
        std::u16string(logical.utf16.begin(), logical.utf16.end()), &paragraph, &error)) {
      SetError("UNSUPPORTED_CAPABILITY", std::move(error)); return false;
    }
  } else if (!CreateParagraphObject(pdf, fonts, request, &paragraph)) return false;
  std::unique_ptr<CPDF_PageObject> replacement(CPDFPageObjectFromFPDFPageObject(paragraph.object));
  const FS_MATRIX placement{static_cast<float>(matrix.a), static_cast<float>(matrix.b),
      static_cast<float>(matrix.c), static_cast<float>(matrix.d),
      static_cast<float>(matrix.e), static_cast<float>(matrix.f)};
  if (!FPDFPageObj_SetMatrix(paragraph.object, &placement)) return false;
  // A height-only first resize keeps the original PDF glyph placements exactly,
  // including TJ adjustments and text rendering state.
  if (preserve_source) {
    auto* form = replacement->AsForm()->form();
    while (form->GetPageObjectCount()) form->ErasePageObjectAtIndex(0);
    const auto original_to_form = InverseMatrix(old_frame_matrix);
    if (!original_to_form) return false;
    const Matrix to_form = original_to_form->Then(Matrix{1, 0, 0, 1, 0, request.height - old_height});
    for (auto& source : source_children) {
      const auto source_matrix = MatrixFromCfx(source->GetTextMatrix()).Then(to_form);
      auto font = source->GetFont();
      const auto positions = source->GetCharPositions();
      const bool vertical = source->CalcPositionData(1).y != 0;
      for (size_t index = 0; index < source->CharCount(); ++index) {
        const uint32_t code = source->GetCharCode(index);
        ByteString encoded; font->AppendChar(&encoded, code);
        auto glyph = source->Clone(); glyph->SetText(encoded);
        const auto origin = source_matrix.Apply(vertical ? 0 : positions[index], vertical ? positions[index] : 0);
        glyph->SetTextMatrix(CFX_Matrix(static_cast<float>(source_matrix.a), static_cast<float>(source_matrix.b),
            static_cast<float>(source_matrix.c), static_cast<float>(source_matrix.d),
            static_cast<float>(origin[0]), static_cast<float>(origin[1])));
        glyph->TransformClipPath(CFX_Matrix(static_cast<float>(to_form.a), static_cast<float>(to_form.b),
            static_cast<float>(to_form.c), static_cast<float>(to_form.d),
            static_cast<float>(to_form.e), static_cast<float>(to_form.f)));
        glyph->SetContentMarks(CPDF_ContentMarks());
        auto values = pdfium::MakeRetain<CPDF_Dictionary>();
        values->SetNewFor<CPDF_String>("ActualText", font->UnicodeFromCharCode(code).AsStringView());
        const float next = index + 1 < positions.size() ? positions[index + 1] : source->CalcPositionData(1).x;
        values->SetNewFor<CPDF_Number>("KomoAdvance", static_cast<float>(source_matrix.a) * (next - positions[index]));
        values->SetNewFor<CPDF_Number>("KomoBaseline", static_cast<float>(origin[1]) -
            (request.height - request.source_baseline.value_or(0)));
        glyph->GetContentMarks()->AddMarkWithDirectDict("Span", values);
        glyph->SetContentStream(CPDF_PageObject::kNoContentStream); glyph->SetDirty(true);
        form->AppendPageObject(std::move(glyph));
      }
    }
    CPDF_PageContentGenerator(form).GenerateFormContentForEditing(form);
  }
  replacement->mutable_clip_path() = old_object->clip_path();
  replacement->SetContentStream(old_object->GetContentStream());
  replacement->SetContentMarks(*original_marks);
  if (pdf_editor::tagged::ActualMark(replacement.get()))
    pdf_editor::tagged::SetLocalActualText(replacement.get(), request.utf8);
  ObjectIdentity identity;
  if (!ParagraphIdentity(document, paragraph.object, retained.id, &retained, &identity)) return false;
  const std::string anchor_id = identity.id;
  const std::string anchor_page = metadata->pages[page_index].id;
  if (flow) {
    for (size_t p = 0; p < metadata->pages.size(); ++p) {
      std::vector<size_t> removing;
      for (const auto& part : parts) if (part.page == p && part.identity.id != anchor_id) removing.push_back(part.index);
      if (removing.empty()) continue;
      ScopedPage changed(p == page_index ? nullptr : FPDF_LoadPage(pdf, static_cast<int>(p)));
      FPDF_PAGE changed_page = p == page_index ? page.get() : changed.get();
      auto* native = CPDFPageFromFPDFPage(changed_page);
      std::sort(removing.rbegin(), removing.rend());
      for (size_t position : removing) {
        auto* object = native->GetPageObjectByIndex(position);
        const int mcid = object->GetContentMarks()->GetMarkedContentID();
        if (!native->RemovePageObject(object)) return false;
        if (mcid >= 0 && !pdf_editor::tagged::HasOtherMember(native, mcid, nullptr))
          pdf_editor::tagged::ClearMcid(native_doc, native, mcid);
        metadata->pages[p].objects.erase(metadata->pages[p].objects.begin() + position);
      }
      metadata->flow_changed_pages.insert(metadata->pages[p].id);
      if (!FPDFPage_GenerateContent(changed_page)) return false;
    }
  }
  std::vector<size_t> removing;
  if (info) {
    const auto& objects = metadata->pages[page_index].objects;
    const auto found = std::find_if(objects.begin(), objects.end(), [&](const auto& item) { return item.id == anchor_id; });
    if (found == objects.end()) return false;
    removing.push_back(static_cast<size_t>(found - objects.begin()));
  } else for (const auto& target : targets) removing.push_back(target.path[0]);
  const size_t insertion = *std::min_element(removing.begin(), removing.end());
  std::sort(removing.rbegin(), removing.rend());
  for (size_t position : removing) {
    auto* object = native_page->GetPageObjectByIndex(position);
    const int mcid = object->GetContentMarks()->GetMarkedContentID();
    if (!native_page->RemovePageObject(object)) return false;
    if (mcid >= 0 && mcid != original_mcid && !pdf_editor::tagged::HasOtherMember(native_page, mcid, nullptr))
      pdf_editor::tagged::ClearMcid(native_doc, native_page, mcid);
    metadata->pages[page_index].objects.erase(metadata->pages[page_index].objects.begin() + position);
  }
  if (!native_page->InsertPageObjectAtIndex(insertion, std::move(replacement))) return false;
  metadata->pages[page_index].objects.insert(metadata->pages[page_index].objects.begin() + insertion, std::move(identity));
  metadata->flow_changed_pages.insert(anchor_page);
  return FPDFPage_GenerateContent(page.get()) != 0;
}
