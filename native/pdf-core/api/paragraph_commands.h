// Logical paragraphs stay real Form XObjects in the same candidate document.

bool CreateParagraphObject(FPDF_DOCUMENT pdf, const FontResource& font,
                           const pdf_editor::ParagraphRequest& request,
                           pdf_editor::ParagraphResult* result) {
  std::string error;
  if (!pdf_editor::CreateTextParagraph(pdf, font.face, font.SfntBytes(), request, result, &error)) {
    SetError("UNSUPPORTED_CAPABILITY", std::move(error));
    return false;
  }
  auto* form = CPDFPageObjectFromFPDFPageObject(result->object)->AsForm();
  auto metadata = form->form()->GetMutableDict()->GetMutableDictFor("KomoParagraph");
  const WideString id = WideString::FromUTF8(ByteStringView(font.id));
  metadata->SetNewFor<CPDF_String>("RegisteredFontId", id.AsStringView());
  return true;
}

bool ParagraphIdentity(const Document& document, FPDF_PAGEOBJECT object,
                       const std::string& seed, const ObjectIdentity* retained,
                       ObjectIdentity* identity) {
  uint64_t ordinal = 0;
  if (!BuildGeneratedObjectIdentity(document, seed, object, 0, &ordinal, identity)) return false;
  if (retained) {
    identity->id = retained->id;
    identity->text_block_id = retained->text_block_id;
  } else {
    identity->id = seed;
  }
  return true;
}

bool ApplyParagraphInsert(const Document& document, FPDF_DOCUMENT pdf,
    CandidateMetadata* metadata, const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    const std::set<std::string>* batch_new_ids, TextInsertLayoutResult* layout,
    bool allow_overflow) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) return false;
  const auto font = resources.find(command.font_id);
  if (font == resources.end()) { SetError("INVALID_REQUEST", "Select a registered paragraph font."); return false; }
  pdf_editor::ParagraphRequest request;
  request.utf8 = command.text;
  request.width = static_cast<float>(command.values[2]); request.height = static_cast<float>(command.values[3]);
  request.font_size = static_cast<float>(command.values[4]);
  if (command.flags & 4U) request.color = {static_cast<float>(command.values[5]), static_cast<float>(command.values[6]), static_cast<float>(command.values[7])};
  if (command.flags & 8U) request.letter_spacing = static_cast<float>(command.values[8]);
  if (command.flags & 16U) request.line_height = static_cast<float>(command.values[9]);
  request.alignment = (command.flags & 32U) ? pdf_editor::ParagraphAlignment::kCenter :
      (command.flags & 64U) ? pdf_editor::ParagraphAlignment::kRight : pdf_editor::ParagraphAlignment::kLeft;
  pdf_editor::ParagraphResult paragraph;
  if (!CreateParagraphObject(pdf, *font->second, request, &paragraph)) return false;
  std::unique_ptr<CPDF_PageObject> object(CPDFPageObjectFromFPDFPageObject(paragraph.object));
  if (paragraph.overflow && !allow_overflow) {
    SetError("UNSUPPORTED_CAPABILITY", "The paragraph does not fit its text box."); return false;
  }
  if (!SetObjectMatrix(page.get(), paragraph.object,
      Matrix{1, 0, 0, -1, command.values[0], command.values[1] + command.values[3]})) return false;
  ObjectIdentity identity;
  if (!ParagraphIdentity(document, paragraph.object, command.target_id, nullptr, &identity)) return false;
  std::set<std::string> new_ids;
  if (IdentityTreeHasCollision(identity, *metadata, &new_ids)) {
    SetError("INVALID_REQUEST", "A paragraph identity is already in use."); return false;
  }
  for (const auto& id : new_ids) {
    if (id != command.target_id && ((batch_new_ids && batch_new_ids->contains(id)) ||
        (!document.reserved_ids.contains(command.target_id) && document.reserved_ids.contains(id)))) {
      SetError("INVALID_REQUEST", "A paragraph identity collides with a reserved ID."); return false;
    }
  }
  auto* native_page = CPDFPageFromFPDFPage(page.get());
  auto& identities = metadata->pages[page_index].objects;
  size_t insertion = identities.size();
  if (command.type == EditType::kTextReflow) {
    std::vector<size_t> positions;
    for (const auto& block_id : command.ids) {
      ObjectTarget target;
      if (!FindObjectTarget(page.get(), &metadata->pages[page_index], block_id, true, &target)) return false;
      if (target.path.size() != 1 || IsOcrTextObject(target.object) ||
          (!ParagraphMetadata(target.object) &&
           (FPDFPageObj_GetType(target.object) != FPDF_PAGEOBJ_TEXT || !HasSupportedTextMarks(target.object)))) {
        SetError("UNSUPPORTED_CAPABILITY", "Select top-level editable text, not an OCR layer or nested content, for paragraph reflow."); return false;
      }
      positions.push_back(target.path[0]);
    }
    std::sort(positions.begin(), positions.end());
    for (size_t index = 1; index < positions.size(); ++index) {
      if (positions[index] != positions[index - 1] + 1) {
        SetError("UNSUPPORTED_CAPABILITY", "Reflow currently requires adjacent text objects in content order."); return false;
      }
    }
    insertion = positions.front();
    for (auto position = positions.rbegin(); position != positions.rend(); ++position) {
      if (!native_page->RemovePageObject(native_page->GetPageObjectByIndex(*position))) { SetUnexpectedError(); return false; }
      identities.erase(identities.begin() + *position);
    }
  }
  if (!native_page->InsertPageObjectAtIndex(insertion, std::move(object))) { SetUnexpectedError(); return false; }
  identities.insert(identities.begin() + insertion, std::move(identity));
  if (!FPDFPage_GenerateContent(page.get())) { SetError("CORE_UNAVAILABLE", "The paragraph content could not be saved."); return false; }
  if (layout) {
    layout->overflow = paragraph.overflow;
    layout->bounds = {command.values[0], command.values[1], command.values[2], command.values[3]};
    for (const auto& line : paragraph.lines)
      layout->lines.push_back({{command.values[0] + line.bounds.x, command.values[1] + line.bounds.y,
                               line.bounds.width, line.bounds.height}, line.text_range.start, line.text_range.end});
  }
  return true;
}

bool ReplaceParagraphText(const Document& document, FPDF_DOCUMENT pdf, FPDF_PAGE page,
    CandidateMetadata* metadata, size_t page_index, const ObjectTarget& target,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    Rect* layout_bounds, bool* overflow, TextInsertLayoutResult* paragraph_layout) {
  const auto info = ParagraphMetadata(target.object);
  const ByteString raw = info->GetUnicodeTextFor("Text").ToUTF8();
  const std::string original(raw.c_str(), raw.GetLength());
  LayoutText decoded;
  std::vector<bool> boundaries;
  if (!DecodeLayoutText(original, &decoded) || !CollectUnicodeBreaks(UBRK_CHARACTER, decoded.utf16, &boundaries)) return false;
  if (command.end_utf16 > decoded.utf16.size() || command.start_utf16 > command.end_utf16 ||
      !boundaries[command.start_utf16] || !boundaries[command.end_utf16]) {
    SetError("INVALID_REQUEST", "Paragraph replacements must preserve complete graphemes."); return false;
  }
  std::string updated;
  if (!ReplaceUtf16Range(original, command.start_utf16, command.end_utf16, command.text, &updated)) return false;
  auto* native_page = CPDFPageFromFPDFPage(page);
  auto& identities = metadata->pages[page_index].objects;
  const size_t index = target.path[0];
  FS_MATRIX matrix{};
  if (!FPDFPageObj_GetMatrix(target.object, &matrix)) { SetUnexpectedError(); return false; }
  Matrix to_page, to_pdf;
  if (!GetPageMatrices(page, &to_page, &to_pdf)) return false;
  const Matrix paragraph_to_page = MatrixFromFs(matrix).Then(to_page);
  const Rect box = TransformBounds(0, 0, info->GetFloatFor("Width"), info->GetFloatFor("Height"), paragraph_to_page);
  if (updated.empty()) {
    if (!native_page->RemovePageObject(native_page->GetPageObjectByIndex(index))) return false;
    identities.erase(identities.begin() + index);
    if (layout_bounds) *layout_bounds = {box.x, box.y, 0, 0};
    if (overflow) *overflow = false;
    return FPDFPage_GenerateContent(page);
  }
  const ByteString stored_id = info->GetUnicodeTextFor("RegisteredFontId").ToUTF8();
  const std::string font_id = command.font_id.empty() ? std::string(stored_id.c_str(), stored_id.GetLength()) : command.font_id;
  const auto font = resources.find(font_id);
  std::shared_ptr<const FontResource> selected_font;
  if (font != resources.end()) {
    selected_font = font->second;
  } else if (command.font_id.empty()) {
    const auto dictionary = info->GetDictFor("Font");
    const auto descendants = dictionary ? dictionary->GetArrayFor("DescendantFonts") : nullptr;
    const auto descendant = descendants ? descendants->GetDictAt(0) : nullptr;
    const auto descriptor = descendant ? descendant->GetDictFor("FontDescriptor") : nullptr;
    auto stream = descriptor ? descriptor->GetStreamFor("FontFile2") : nullptr;
    if (!stream && descriptor) stream = descriptor->GetStreamFor("FontFile3");
    if (stream) {
      auto contents = pdfium::MakeRetain<CPDF_StreamAcc>(stream);
      contents->LoadAllDataFiltered();
      const auto bytes = contents->GetSpan();
      pdf_editor::PreparedFontFace face;
      std::string error_code, error_message;
      if (pdf_editor::PrepareFontFace({bytes.data(), bytes.size()}, 0, &face, &error_code, &error_message) &&
          face.info.editable_embedding) {
        auto embedded = std::make_shared<FontResource>();
        embedded->id = font_id;
        embedded->face = face.info;
        embedded->original_bytes = std::move(face.sfnt);
        selected_font = std::move(embedded);
      }
    }
  }
  if (!selected_font) {
    SetError("UNSUPPORTED_CAPABILITY", "Choose a registered font to reflow this saved paragraph."); return false;
  }
  pdf_editor::ParagraphRequest request;
  const auto direction = info->GetNameFor("Direction");
  request.direction = direction == "RTL" ? pdf_editor::TextDirection::kRightToLeft :
      direction == "LTR" ? pdf_editor::TextDirection::kLeftToRight : pdf_editor::TextDirection::kAuto;
  const ByteString language = info->GetUnicodeTextFor("Language").ToUTF8();
  request.language.assign(language.c_str(), language.GetLength());
  request.utf8 = updated; request.width = info->GetFloatFor("Width"); request.height = info->GetFloatFor("Height");
  request.font_size = info->GetFloatFor("FontSize"); request.line_height = info->GetFloatFor("LineHeight");
  request.letter_spacing = info->GetFloatFor("LetterSpacing");
  const auto color = info->GetArrayFor("Color");
  if (color && color->size() == 3) request.color = {color->GetFloatAt(0), color->GetFloatAt(1), color->GetFloatAt(2)};
  const auto align = info->GetNameFor("Alignment");
  request.alignment = align == "Center" ? pdf_editor::ParagraphAlignment::kCenter :
      align == "Right" ? pdf_editor::ParagraphAlignment::kRight : pdf_editor::ParagraphAlignment::kLeft;
  pdf_editor::ParagraphResult paragraph;
  if (!CreateParagraphObject(pdf, *selected_font, request, &paragraph)) return false;
  std::unique_ptr<CPDF_PageObject> object(CPDFPageObjectFromFPDFPageObject(paragraph.object));
  if (paragraph.overflow && !overflow) { SetError("UNSUPPORTED_CAPABILITY", "The replacement paragraph overflows its text box."); return false; }
  if (!FPDFPageObj_SetMatrix(paragraph.object, &matrix)) { SetUnexpectedError(); return false; }
  object->SetContentStream(CPDFPageObjectFromFPDFPageObject(target.object)->GetContentStream());
  ObjectIdentity identity;
  const std::string seed = target.identity->id + ":reflow:" + updated;
  if (!ParagraphIdentity(document, paragraph.object, seed, target.identity, &identity)) return false;
  if (!native_page->RemovePageObject(native_page->GetPageObjectByIndex(index)) || !native_page->InsertPageObjectAtIndex(index, std::move(object))) {
    SetUnexpectedError(); return false;
  }
  identities[index] = std::move(identity);
  if (!FPDFPage_GenerateContent(page)) { SetUnexpectedError(); return false; }
  if (layout_bounds) *layout_bounds = box;
  if (overflow) *overflow = paragraph.overflow;
  if (paragraph_layout) {
    paragraph_layout->bounds = box;
    paragraph_layout->overflow = paragraph.overflow;
    for (const auto& line : paragraph.lines) {
      const auto& b = line.bounds;
      const Rect normalized = TransformBounds(b.x, request.height - b.y - b.height,
          b.x + b.width, request.height - b.y, paragraph_to_page);
      paragraph_layout->lines.push_back({normalized, line.text_range.start, line.text_range.end});
    }
  }
  return true;
}
