// Logical paragraphs stay real Form XObjects in the same candidate document.

bool CreateParagraphObject(FPDF_DOCUMENT pdf,
    const std::vector<std::shared_ptr<const FontResource>>& fonts,
    const pdf_editor::ParagraphRequest& request,
    pdf_editor::ParagraphResult* result) {
  std::vector<pdf_editor::ParagraphFont> faces;
  for (const auto& font : fonts) faces.push_back({font->id, font->face, font->SfntBytes()});
  std::string error;
  if (!pdf_editor::CreateTextParagraph(pdf, faces, request, result, &error)) {
    SetError("UNSUPPORTED_CAPABILITY", std::move(error));
    return false;
  }
  return true;
}

bool CreateParagraphObject(FPDF_DOCUMENT pdf, const FontResource& font,
                           const pdf_editor::ParagraphRequest& request,
                           pdf_editor::ParagraphResult* result) {
  auto borrowed = std::shared_ptr<const FontResource>(&font, [](const FontResource*) {});
  return CreateParagraphObject(pdf, {borrowed}, request, result);
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

std::shared_ptr<const FontResource> ResolveParagraphFont(
    const CPDF_Dictionary* metadata,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources) {
  const ByteString stored = metadata->GetUnicodeTextFor("RegisteredFontId").ToUTF8();
  const std::string font_id(stored.c_str(), stored.GetLength());
  const auto found = resources.find(font_id);
  if (found != resources.end()) return found->second;
  const auto dictionary = metadata->GetDictFor("Font");
  const auto descendants = dictionary ? dictionary->GetArrayFor("DescendantFonts") : nullptr;
  const auto descendant = descendants ? descendants->GetDictAt(0) : nullptr;
  const auto descriptor = descendant ? descendant->GetDictFor("FontDescriptor") : nullptr;
  auto stream = descriptor ? descriptor->GetStreamFor("FontFile2") : nullptr;
  if (!stream && descriptor) stream = descriptor->GetStreamFor("FontFile3");
  if (!stream) return {};
  auto contents = pdfium::MakeRetain<CPDF_StreamAcc>(stream);
  contents->LoadAllDataFiltered();
  const auto bytes = contents->GetSpan();
  pdf_editor::PreparedFontFace face;
  std::string code, message;
  if (!pdf_editor::PrepareFontFace({bytes.data(), bytes.size()}, 0,
                                   &face, &code, &message) ||
      !face.info.editable_embedding) return {};
  auto embedded = std::make_shared<FontResource>();
  embedded->id = font_id;
  embedded->face = face.info;
  embedded->original_bytes = std::move(face.sfnt);
  return embedded;
}

bool ReadParagraphStyles(
    const CPDF_Dictionary* info, uint32_t length,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources,
    std::vector<std::shared_ptr<const FontResource>>* fonts,
    pdf_editor::ParagraphRequest* request) {
  auto base = ResolveParagraphFont(info, resources);
  if (!base) {
    SetError("UNSUPPORTED_CAPABILITY", "Choose a registered font to edit this saved paragraph.");
    return false;
  }
  fonts->clear();
  fonts->push_back(std::move(base));
  request->width = info->GetFloatFor("Width");
  request->height = info->GetFloatFor("Height");
  request->font_size = info->GetFloatFor("FontSize");
  request->line_height = info->GetFloatFor("LineHeight");
  request->letter_spacing = info->GetFloatFor("LetterSpacing");
  request->underline = info->GetBooleanFor("Underline", false);
  const auto color = info->GetArrayFor("Color");
  if (color && color->size() == 3) request->color =
      {color->GetFloatAt(0), color->GetFloatAt(1), color->GetFloatAt(2)};
  const auto align = info->GetNameFor("Alignment");
  request->alignment = align == "Center" ? pdf_editor::ParagraphAlignment::kCenter :
      align == "Right" ? pdf_editor::ParagraphAlignment::kRight : pdf_editor::ParagraphAlignment::kLeft;
  const auto direction = info->GetNameFor("Direction");
  request->direction = direction == "RTL" ? pdf_editor::TextDirection::kRightToLeft :
      direction == "LTR" ? pdf_editor::TextDirection::kLeftToRight : pdf_editor::TextDirection::kAuto;
  const ByteString language = info->GetUnicodeTextFor("Language").ToUTF8();
  request->language.assign(language.c_str(), language.GetLength());
  request->styles.clear();
  const auto runs = info->GetArrayFor("StyleRuns");
  if (!runs) return true;
  uint32_t next = 0;
  std::vector<uint32_t> font_objects{info->GetDictFor("Font") ?
      info->GetDictFor("Font")->GetObjNum() : 0};
  for (size_t index = 0; index < runs->size(); ++index) {
    const auto run = runs->GetDictAt(index);
    if (!run) break;
    const int start = run->GetIntegerFor("Start"), end = run->GetIntegerFor("End");
    if (start < 0 || end <= start || static_cast<uint32_t>(start) != next ||
        static_cast<uint32_t>(end) > length) break;
    auto font = ResolveParagraphFont(run.Get(), resources);
    if (!font) break;
    const auto font_dict = run->GetDictFor("Font");
    if (!font_dict || !font_dict->GetObjNum()) break;
    size_t font_index = 0;
    for (; font_index < font_objects.size(); ++font_index) {
      if (font_dict->GetObjNum() == font_objects[font_index]) break;
    }
    if (font_index == fonts->size()) {
      fonts->push_back(std::move(font));
      font_objects.push_back(font_dict->GetObjNum());
    }
    pdf_editor::ParagraphStyleRun style;
    style.range = {static_cast<uint32_t>(start), static_cast<uint32_t>(end)};
    style.font_index = static_cast<uint32_t>(font_index);
    style.font_size = run->GetFloatFor("FontSize");
    style.letter_spacing = run->GetFloatFor("LetterSpacing");
    style.underline = run->GetBooleanFor("Underline", false);
    const auto rgb = run->GetArrayFor("Color");
    if (rgb && rgb->size() == 3) style.color =
        {rgb->GetFloatAt(0), rgb->GetFloatAt(1), rgb->GetFloatAt(2)};
    request->styles.push_back(style);
    next = style.range.end;
  }
  if (next != length) {
    SetError("UNSUPPORTED_CAPABILITY", "The saved paragraph has unsupported style ranges or missing fonts.");
    return false;
  }
  return true;
}

void CompactParagraphFonts(
    pdf_editor::ParagraphRequest* request,
    std::vector<std::shared_ptr<const FontResource>>* fonts) {
  if (request->styles.empty()) return;
  std::vector<uint32_t> order;
  for (const auto& run : request->styles) {
    if (std::find(order.begin(), order.end(), run.font_index) == order.end()) {
      order.push_back(run.font_index);
    }
  }
  if (order.empty()) return;
  if (std::find(order.begin(), order.end(), 0U) != order.end()) {
    order.erase(std::find(order.begin(), order.end(), 0U));
    order.insert(order.begin(), 0U);
  } else {
    const auto& first = request->styles.front();
    request->font_size = first.font_size;
    request->letter_spacing = first.letter_spacing;
    request->color = first.color;
    request->underline = first.underline;
  }
  std::vector<std::shared_ptr<const FontResource>> kept;
  for (uint32_t index : order) kept.push_back((*fonts)[index]);
  for (auto& run : request->styles) {
    run.font_index = static_cast<uint32_t>(
        std::find(order.begin(), order.end(), run.font_index) - order.begin());
  }
  *fonts = std::move(kept);
}

void RemapParagraphStyles(pdf_editor::ParagraphRequest* request,
                          uint32_t original_length,
                          uint32_t start, uint32_t end,
                          uint32_t inserted_length) {
  if (request->styles.empty()) return;
  const auto original = std::move(request->styles);
  auto append = [&](pdf_editor::ParagraphStyleRun run) {
    if (run.range.start >= run.range.end) return;
    if (!request->styles.empty()) {
      auto& previous = request->styles.back();
      if (previous.range.end == run.range.start &&
          previous.font_index == run.font_index &&
          previous.font_size == run.font_size &&
          previous.letter_spacing == run.letter_spacing &&
          previous.underline == run.underline &&
          previous.color.red == run.color.red &&
          previous.color.green == run.color.green &&
          previous.color.blue == run.color.blue) {
        previous.range.end = run.range.end;
        return;
      }
    }
    request->styles.push_back(run);
  };
  for (auto run : original) {
    if (run.range.start >= start) break;
    run.range.end = std::min(run.range.end, start);
    append(run);
  }
  if (inserted_length) {
    const uint32_t position = std::min(start, original_length - 1);
    for (auto run : original) {
      if (run.range.start <= position && position < run.range.end) {
        run.range = {start, start + inserted_length};
        append(run);
        break;
      }
    }
  }
  for (auto run : original) {
    if (run.range.end <= end) continue;
    run.range.start = start + inserted_length + std::max(run.range.start, end) - end;
    run.range.end = start + inserted_length + run.range.end - end;
    append(run);
  }
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
  request.underline = (command.flags & kTextUnderlineFlag) != 0;
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

bool ParagraphRangePreservesClusters(FPDF_PAGEOBJECT object,
                                     const std::u16string& text,
                                     uint32_t start, uint32_t end) {
  uint32_t cursor = 0;
  std::u16string previous;
  auto is_break = [](char16_t unit) {
    return unit == u'\r' || unit == u'\n' || unit == u'\v' || unit == u'\f' ||
           unit == 0x0085 || unit == 0x2028 || unit == 0x2029;
  };
  if (FPDFPageObj_CountMarks(object) != 0) return false;
  const int count = FPDFFormObj_CountObjects(object);
  if (count <= 0) return false;
  for (int index = 0; index < count; ++index) {
    FPDF_PAGEOBJECT child = FPDFFormObj_GetObject(object, static_cast<unsigned long>(index));
    if (FPDFPageObj_GetType(child) == FPDF_PAGEOBJ_PATH) {
      if (FPDFPageObj_CountMarks(child) != 1) return false;
      auto* artifact = CPDFContentMarkItemFromFPDFPageObjectMark(FPDFPageObj_GetMark(child, 0));
      if (!artifact || artifact->GetName() != "Artifact") return false;
      continue;
    }
    if (FPDFPageObj_GetType(child) != FPDF_PAGEOBJ_TEXT ||
        FPDFPageObj_CountMarks(child) != 1) return false;
    auto* mark = CPDFContentMarkItemFromFPDFPageObjectMark(FPDFPageObj_GetMark(child, 0));
    if (!mark || mark->GetName() != "Span" ||
        mark->GetParamType() != CPDF_ContentMarkItem::kDirectDict ||
        !mark->GetParam() || mark->GetParam()->size() != 1 ||
        !mark->GetParam()->KeyExist("ActualText")) return false;
    const ByteString utf8 = mark->GetParam()->GetUnicodeTextFor("ActualText").ToUTF8();
    LayoutText cluster;
    if (!DecodeLayoutText(std::string(utf8.c_str(), utf8.GetLength()), &cluster) ||
        cluster.utf16.empty()) return false;
    const std::u16string cluster_text(cluster.utf16.begin(), cluster.utf16.end());
    size_t found = text.find(cluster_text, cursor);
    if (found == std::u16string::npos && cluster_text == previous) continue;
    if (found == std::u16string::npos ||
        !std::all_of(text.begin() + cursor, text.begin() + found, is_break)) return false;
    const auto cluster_start = static_cast<uint32_t>(found);
    const auto cluster_end = cluster_start + static_cast<uint32_t>(cluster.utf16.size());
    if ((cluster_start < start && start < cluster_end) ||
        (cluster_start < end && end < cluster_end)) return false;
    cursor = cluster_end;
    previous = cluster_text;
  }
  return cursor != 0 &&
         std::all_of(text.begin() + cursor, text.end(), is_break);
}

bool ApplyParagraphStyle(const Document& document, FPDF_DOCUMENT pdf,
    FPDF_PAGE page, CandidateMetadata* metadata, size_t page_index,
    const ObjectTarget& target, const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources) {
  const auto info = ParagraphMetadata(target.object);
  if (!info || target.path.size() != 1) {
    SetError("UNSUPPORTED_CAPABILITY", "Only a top-level logical paragraph can be styled.");
    return false;
  }
  const ByteString raw = info->GetUnicodeTextFor("Text").ToUTF8();
  const std::string original(raw.c_str(), raw.GetLength());
  LayoutText decoded;
  std::vector<bool> boundaries;
  if (!DecodeLayoutText(original, &decoded) ||
      !CollectUnicodeBreaks(UBRK_CHARACTER, decoded.utf16, &boundaries)) return false;
  const bool has_range = (command.flags & kTextStyleRangeFlag) != 0;
  const uint32_t start = has_range ? command.start_utf16 : 0;
  const uint32_t end = has_range ? command.end_utf16 :
      static_cast<uint32_t>(decoded.utf16.size());
  if (start >= end || end > decoded.utf16.size() ||
      !boundaries[start] || !boundaries[end]) {
    SetError("INVALID_REQUEST", "Paragraph style ranges must preserve complete graphemes.");
    return false;
  }
  if (!ParagraphRangePreservesClusters(target.object,
      std::u16string(decoded.utf16.begin(), decoded.utf16.end()), start, end)) {
    SetError("UNSUPPORTED_CAPABILITY", "The paragraph range cuts a shaped glyph cluster or has unsupported text marks.");
    return false;
  }
  pdf_editor::ParagraphRequest request;
  std::vector<std::shared_ptr<const FontResource>> fonts;
  if (!ReadParagraphStyles(info.Get(), static_cast<uint32_t>(decoded.utf16.size()),
                           resources, &fonts, &request)) return false;
  request.utf8 = original;
  if (request.styles.empty()) request.styles.push_back(
      {{0, static_cast<uint32_t>(decoded.utf16.size())}, 0,
       request.font_size, request.letter_spacing, request.color, request.underline});
  uint32_t selected_font = 0;
  if (command.flags & 1U) {
    const auto selected = resources.find(command.font_id);
    if (selected == resources.end()) {
      SetError("INVALID_REQUEST", "The requested paragraph font is not registered.");
      return false;
    }
    selected_font = static_cast<uint32_t>(fonts.size());
    for (uint32_t index = 0; index < fonts.size(); ++index) {
      if (fonts[index]->id == command.font_id) { selected_font = index; break; }
    }
    if (selected_font == fonts.size()) fonts.push_back(selected->second);
  }
  std::vector<pdf_editor::ParagraphStyleRun> updated;
  for (const auto& old : request.styles) {
    auto append = [&](pdf_editor::ParagraphStyleRun run) {
      if (run.range.start >= run.range.end) return;
      if (!updated.empty()) {
        auto& back = updated.back();
        if (back.range.end == run.range.start && back.font_index == run.font_index &&
            back.font_size == run.font_size && back.letter_spacing == run.letter_spacing &&
            back.underline == run.underline && back.color.red == run.color.red &&
            back.color.green == run.color.green && back.color.blue == run.color.blue) {
          back.range.end = run.range.end;
          return;
        }
      }
      updated.push_back(run);
    };
    if (old.range.start < start) {
      auto left = old; left.range.end = std::min(old.range.end, start); append(left);
    }
    if (old.range.start < end && old.range.end > start) {
      auto middle = old;
      middle.range.start = std::max(old.range.start, start);
      middle.range.end = std::min(old.range.end, end);
      if (command.flags & 1U) middle.font_index = selected_font;
      if (command.flags & 2U) middle.font_size = static_cast<float>(command.values[0]);
      if (command.flags & 4U) middle.color = {
          static_cast<float>(command.values[1]), static_cast<float>(command.values[2]),
          static_cast<float>(command.values[3])};
      if (command.flags & 8U) middle.letter_spacing = static_cast<float>(command.values[4]);
      if (command.flags & kTextStyleUnderlineFlag) middle.underline = command.values[5] != 0;
      append(middle);
    }
    if (old.range.end > end) {
      auto right = old; right.range.start = std::max(old.range.start, end); append(right);
    }
  }
  request.styles = std::move(updated);
  CompactParagraphFonts(&request, &fonts);
  pdf_editor::ParagraphResult paragraph;
  if (!CreateParagraphObject(pdf, fonts, request, &paragraph)) return false;
  std::unique_ptr<CPDF_PageObject> replacement(CPDFPageObjectFromFPDFPageObject(paragraph.object));
  if (paragraph.overflow) {
    SetError("UNSUPPORTED_CAPABILITY", "The styled paragraph overflows its text box.");
    return false;
  }
  FS_MATRIX matrix{};
  if (!FPDFPageObj_GetMatrix(target.object, &matrix) ||
      !FPDFPageObj_SetMatrix(paragraph.object, &matrix)) {
    SetUnexpectedError(); return false;
  }
  replacement->SetContentStream(CPDFPageObjectFromFPDFPageObject(target.object)->GetContentStream());
  ObjectIdentity identity;
  if (!ParagraphIdentity(document, paragraph.object,
      target.identity->id + ":style:" + command.transaction_id,
      target.identity, &identity)) return false;
  const size_t position = target.path[0];
  auto* native_page = CPDFPageFromFPDFPage(page);
  if (!native_page->ErasePageObjectAtIndex(position) ||
      !native_page->InsertPageObjectAtIndex(position, std::move(replacement))) {
    SetUnexpectedError(); return false;
  }
  metadata->pages[page_index].objects[position] = std::move(identity);
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
  pdf_editor::ParagraphRequest request;
  std::vector<std::shared_ptr<const FontResource>> fonts;
  if (!ReadParagraphStyles(info.Get(), static_cast<uint32_t>(decoded.utf16.size()),
                           resources, &fonts, &request)) return false;
  if (!command.font_id.empty()) {
    const auto selected = resources.find(command.font_id);
    if (selected == resources.end()) {
      SetError("INVALID_REQUEST", "The requested paragraph font is not registered.");
      return false;
    }
    fonts[0] = selected->second;
  }
  LayoutText inserted;
  if (!DecodeLayoutText(command.text, &inserted)) return false;
  RemapParagraphStyles(&request, static_cast<uint32_t>(decoded.utf16.size()),
                       command.start_utf16, command.end_utf16,
                       static_cast<uint32_t>(inserted.utf16.size()));
  request.utf8 = updated;
  CompactParagraphFonts(&request, &fonts);
  pdf_editor::ParagraphResult paragraph;
  if (!CreateParagraphObject(pdf, fonts, request, &paragraph)) return false;
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
