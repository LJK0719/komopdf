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
    Matrix to_page, to_pdf;
    if (!GetPageMatrices(page.get(), &to_page, &to_pdf)) return false;
    // The caller's source IDs are in reading order, as exposed by selectionScope.
    auto* first_text = old_object->AsText();
    if (!first_text) { SetError("INVALID_REQUEST", "The target is not text."); return false; }
    auto first_local = first_text->Clone(); first_local->SetTextMatrix(CFX_Matrix());
    const auto first_box = first_local->GetRect();
    const auto inverse = InverseMatrix(matrix);
    if (!inverse) { SetError("UNSUPPORTED_CAPABILITY", "The text frame transform is singular."); return false; }
    CFX_FloatRect union_box = first_box;
    float prior_y = first_box.top, prior_right = first_box.left;
    float prior_baseline = 0;
    uint32_t offset = 0;
    for (const auto& target : targets) {
      auto* text = CPDFPageObjectFromFPDFPageObject(target.object)->AsText();
      if (!text || !HasSupportedTextMarks(target.object) || IsOcrTextObject(target.object) ||
          !pdf_editor::tagged::CanEditTextScope(native_page, text)) {
        SetError("UNSUPPORTED_CAPABILITY", "This source cannot be made into an editable text frame."); return false;
      }
      std::string value;
      if (!GetObjectText(page.get(), target.object, &value, native_page)) return false;
      const Matrix local = MatrixFromCfx(text->GetTextMatrix()).Then(*inverse);
      auto clone = text->Clone(); clone->SetTextMatrix(CFX_Matrix());
      const auto box = clone->GetRect();
      const auto bounds = TransformBounds(box.left, box.bottom, box.right, box.top, local);
      const float top = static_cast<float>(bounds.y + bounds.height);
      const auto baseline = local.Apply(0, 0);
      const auto advance_end = local.Apply(clone->CalcPositionData(1).x, 0);
      if (offset && std::abs(top - prior_y) > text->GetFontSize() * 0.5f) {
        request.utf8 += '\n'; ++offset;
        if (request.line_spacing == 0) request.line_spacing = static_cast<float>(std::abs(baseline[1] - prior_baseline));
      } else if (offset && bounds.x - prior_right > text->GetFontSize() * 0.18f &&
                 !request.utf8.empty() && request.utf8.back() != ' ' && !value.empty() && value.front() != ' ') {
        request.utf8 += ' '; ++offset;
      }
      prior_y = top; prior_baseline = static_cast<float>(baseline[1]);
      prior_right = static_cast<float>(advance_end[0]);
      union_box.Union(CFX_FloatRect(static_cast<float>(bounds.x), static_cast<float>(bounds.y),
          static_cast<float>(bounds.x + bounds.width), top));
      union_box.right = std::max(union_box.right, static_cast<float>(advance_end[0]));
      auto resource = std::make_shared<FontResource>();
      resource->source_font = text->GetFont().Get();
      resource->id = GetTextStyle(target.object).font_id.value_or("pdf-source-font");
      uint32_t font_index = 0;
      for (; font_index < fonts.size(); ++font_index)
        if (fonts[font_index]->source_font == resource->source_font) break;
      if (font_index == fonts.size()) fonts.push_back(resource);
      const auto style = GetTextStyle(target.object);
      const uint32_t length = Utf16Length(value);
      const float tracking = static_cast<float>(style.character_spacing.value_or(0));
      const auto color = style.color.value_or(std::array<double, 3>{0, 0, 0});
      request.styles.push_back({{offset, offset + length}, font_index, text->GetFontSize(), tracking,
          {static_cast<float>(color[0]), static_cast<float>(color[1]), static_cast<float>(color[2])}, style.underline.value_or(false)});
      request.utf8 += value; offset += length;
      source_children.push_back(text->Clone());
    }
    // Assign explicit line separators to the preceding style.
    for (size_t i = 1; i < request.styles.size(); ++i)
      request.styles[i - 1].range.end = request.styles[i].range.start;
    request.font_size = first_text->GetFontSize(); request.line_height = 1.2f;
    request.letter_spacing = request.styles.front().letter_spacing;
    request.color = request.styles.front().color;
    old_width = std::max(union_box.Width(), first_local->CalcPositionData(1).x - union_box.left);
    old_height = union_box.Height();
    float ascent = 0, descent = 0;
    const auto font = FPDFFontFromCPDFFont(first_text->GetFont().Get());
    if (!FPDFFont_GetAscent(font, request.font_size, &ascent) ||
        !FPDFFont_GetDescent(font, request.font_size, &descent)) return false;
    const float step = request.line_spacing > 0 ? request.line_spacing : request.font_size * request.line_height;
    const float leading = std::max(0.0f, step - ascent + descent) / 2;
    request.baseline_offset = union_box.top - leading - ascent;
    request.text_inset = -union_box.left;
    matrix = Matrix{1, 0, 0, 1, union_box.left, union_box.bottom}.Then(matrix);
  }
  request.width = static_cast<float>(command.values[2]);
  request.height = static_cast<float>(command.values[3]);
  request.fixed_frame = true;
  const float dy = old_height - static_cast<float>(command.values[1]) - request.height;
  matrix.e += matrix.a * command.values[0] + matrix.c * dy;
  matrix.f += matrix.b * command.values[0] + matrix.d * dy;
  const bool preserve_source = !info && std::abs(request.width - old_width) < 0.02f && command.values[0] == 0;
  pdf_editor::ParagraphResult paragraph;
  if (preserve_source) {
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
    const auto to_form = InverseMatrix(matrix);
    if (!to_form) return false;
    for (auto& source : source_children) {
      const auto source_matrix = MatrixFromCfx(source->GetTextMatrix()).Then(*to_form);
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
        glyph->TransformClipPath(CFX_Matrix(static_cast<float>(to_form->a), static_cast<float>(to_form->b),
            static_cast<float>(to_form->c), static_cast<float>(to_form->d),
            static_cast<float>(to_form->e), static_cast<float>(to_form->f)));
        glyph->SetContentMarks(CPDF_ContentMarks());
        auto values = pdfium::MakeRetain<CPDF_Dictionary>();
        values->SetNewFor<CPDF_String>("ActualText", font->UnicodeFromCharCode(code).AsStringView());
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
