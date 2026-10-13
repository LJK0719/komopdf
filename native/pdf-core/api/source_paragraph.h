// Shared source-font materialization for text.resize and plain text.reflow.
// Included inside the API adapter's anonymous namespace.

bool MaterializeSourceParagraph(FPDF_PAGE page, const std::vector<ObjectTarget>& targets,
    const Matrix& matrix, pdf_editor::ParagraphRequest* request,
    std::vector<std::shared_ptr<const FontResource>>* fonts,
    float* old_width, float* old_height,
    std::vector<std::unique_ptr<CPDF_TextObject>>* source_children,
    bool infer_spaces = false) {
  auto* native_page = CPDFPageFromFPDFPage(page);
  auto* first_text = CPDFPageObjectFromFPDFPageObject(targets.front().object)->AsText();
  if (!first_text) { SetError("INVALID_REQUEST", "The target is not text."); return false; }
  auto first_local = first_text->Clone(); first_local->SetTextMatrix(CFX_Matrix());
  const auto first_box = first_local->GetRect();
  const auto inverse = InverseMatrix(matrix);
  if (!inverse) { SetError("UNSUPPORTED_CAPABILITY", "The text frame transform is singular."); return false; }
  Matrix to_page, to_pdf;
  if (!GetPageMatrices(page, &to_page, &to_pdf)) return false;
  ScopedTextPage text_page(infer_spaces ? FPDFText_LoadPage(page) : nullptr);
  const auto geometry = text_page.get() ? BuildTextGeometryIndex(text_page.get(), to_page) : TextGeometryIndex{};
  CFX_FloatRect union_box = first_box;
  float prior_y = first_box.top, prior_right = first_box.left, prior_baseline = 0;
  float line_baseline = 0;
  uint32_t offset = 0;
  for (const auto& target : targets) {
    auto* text = CPDFPageObjectFromFPDFPageObject(target.object)->AsText();
    if (!text || !HasSupportedTextMarks(target.object) || IsOcrTextObject(target.object) ||
        !pdf_editor::tagged::CanEditTextScope(native_page, text)) {
      SetError("UNSUPPORTED_CAPABILITY", "This source cannot be made into an editable text frame."); return false;
    }
    std::string value;
    if (!GetObjectText(page, target.object, &value, native_page)) return false;
    const Matrix local = MatrixFromCfx(text->GetTextMatrix()).Then(*inverse);
    auto clone = text->Clone(); clone->SetTextMatrix(CFX_Matrix());
    const auto box = clone->GetRect();
    const auto bounds = TransformBounds(box.left, box.bottom, box.right, box.top, local);
    const float top = static_cast<float>(bounds.y + bounds.height);
    const auto baseline = local.Apply(0, 0);
    const auto advance_end = local.Apply(clone->CalcPositionData(1).x, 0);
    if (offset && std::abs(top - prior_y) > text->GetFontSize() * 0.5f) {
      request->utf8 += '\n'; ++offset;
      line_baseline = static_cast<float>(baseline[1]);
      if (request->line_spacing == 0) request->line_spacing = static_cast<float>(std::abs(baseline[1] - prior_baseline));
    } else if (offset && bounds.x - prior_right > text->GetFontSize() * 0.18f &&
               !request->utf8.empty() && request->utf8.back() != ' ' && !value.empty() && value.front() != ' ') {
      if (!request->source_glyphs.empty()) request->source_glyphs.back().advance += static_cast<float>(baseline[0]) - prior_right;
      request->source_glyphs.push_back({{offset, offset + 1}, nullptr, 0, 0});
      request->utf8 += ' '; ++offset;
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
    for (; font_index < fonts->size(); ++font_index)
      if ((*fonts)[font_index]->source_font == resource->source_font) break;
    if (font_index == fonts->size()) fonts->push_back(resource);
    const auto style = GetTextStyle(target.object);
    const float tracking = static_cast<float>(style.character_spacing.value_or(0));
    const auto color = style.color.value_or(std::array<double, 3>{0, 0, 0});
    const uint32_t run_start = offset;
    LayoutText logical;
    if (!DecodeLayoutText(value, &logical)) return false;
    uint32_t cursor = 0;
    const auto found = geometry.find(target.object);
    const auto* gaps = found == geometry.end() ? nullptr : &found->second.inferred_spaces;
    const auto& positions = clone->GetCharPositions();
    const float endpoint = clone->CalcPositionData(1).x;
    for (size_t index = 0; index < clone->CharCount(); ++index) {
      if (gaps && std::find(gaps->begin(), gaps->end(), cursor) != gaps->end()) {
        request->source_glyphs.push_back({{offset, offset + 1}, nullptr, 0, 0});
        request->utf8 += ' '; ++offset;
      }
      const uint32_t code = clone->GetCharCode(index);
      const auto unicode = text->GetFont()->UnicodeFromCharCode(code).ToUTF8();
      const std::string mapped(unicode.c_str(), unicode.GetLength());
      LayoutText cluster;
      if (!DecodeLayoutText(mapped, &cluster) || cluster.utf16.empty() ||
          cursor + cluster.utf16.size() > logical.utf16.size() ||
          !std::equal(cluster.utf16.begin(), cluster.utf16.end(), logical.utf16.begin() + cursor)) {
        SetError("UNSUPPORTED_CAPABILITY", "The source glyphs do not match their editable Unicode text."); return false;
      }
      auto glyph = clone->Clone();
      ByteString encoded; text->GetFont()->AppendChar(&encoded, code); glyph->SetText(encoded);
      glyph->SetTextMatrix(CFX_Matrix(static_cast<float>(local.a), static_cast<float>(local.b),
          static_cast<float>(local.c), static_cast<float>(local.d), 0, 0));
      glyph->SetContentMarks(CPDF_ContentMarks());
      const float next = index + 1 < positions.size() ? positions[index + 1] : endpoint;
      const uint32_t length = static_cast<uint32_t>(cluster.utf16.size());
      request->source_glyphs.push_back({{offset, offset + length},
          std::shared_ptr<const CPDF_TextObject>(std::move(glyph)),
          static_cast<float>(local.a) * (next - positions[index]),
          static_cast<float>(baseline[1]) - line_baseline});
      request->utf8 += mapped; offset += length; cursor += length;
    }
    request->styles.push_back({{run_start, offset}, font_index, text->GetFontSize(), tracking,
        {static_cast<float>(color[0]), static_cast<float>(color[1]), static_cast<float>(color[2])}, style.underline.value_or(false)});
    if (source_children) source_children->push_back(text->Clone());
  }
  for (size_t i = 1; i < request->styles.size(); ++i)
    request->styles[i - 1].range.end = request->styles[i].range.start;
  request->font_size = first_text->GetFontSize(); request->line_height = 1.2f;
  request->letter_spacing = request->styles.front().letter_spacing;
  request->color = request->styles.front().color;
  *old_width = std::max(union_box.Width(), first_local->CalcPositionData(1).x - union_box.left);
  *old_height = union_box.Height();
  float ascent = 0, descent = 0;
  const auto font = FPDFFontFromCPDFFont(first_text->GetFont().Get());
  if (!FPDFFont_GetAscent(font, request->font_size, &ascent) ||
      !FPDFFont_GetDescent(font, request->font_size, &descent)) return false;
  const float step = request->line_spacing > 0 ? request->line_spacing : request->font_size * request->line_height;
  const float leading = std::max(0.0f, step - ascent + descent) / 2;
  request->baseline_offset = union_box.top - leading - ascent;
  request->source_baseline = union_box.top;
  request->text_inset = -union_box.left;
  return true;
}

bool SourceParagraphChange(const LayoutText& before, const LayoutText& after,
                           uint32_t* start, uint32_t* old_end, uint32_t* new_end) {
  *start = 0; *old_end = static_cast<uint32_t>(before.utf16.size()); *new_end = static_cast<uint32_t>(after.utf16.size());
  while (*start < *old_end && *start < *new_end && before.utf16[*start] == after.utf16[*start]) ++*start;
  while (*old_end > *start && *new_end > *start && before.utf16[*old_end - 1] == after.utf16[*new_end - 1]) { --*old_end; --*new_end; }
  std::vector<bool> before_boundaries, after_boundaries;
  if (!CollectUnicodeBreaks(UBRK_CHARACTER, before.utf16, &before_boundaries) ||
      !CollectUnicodeBreaks(UBRK_CHARACTER, after.utf16, &after_boundaries)) return false;
  while (*start && (!before_boundaries[*start] || !after_boundaries[*start])) --*start;
  while (*old_end < before.utf16.size() && (!before_boundaries[*old_end] || !after_boundaries[*new_end])) { ++*old_end; ++*new_end; }
  return true;
}

void RemapSourceGlyphs(pdf_editor::ParagraphRequest* request,
                      uint32_t start, uint32_t end, uint32_t inserted_length) {
  std::vector<pdf_editor::ParagraphSourceGlyph> kept;
  for (auto glyph : request->source_glyphs) {
    if (glyph.range.end <= start) kept.push_back(std::move(glyph));
    else if (glyph.range.start >= end) {
      glyph.range.start = start + inserted_length + glyph.range.start - end;
      glyph.range.end = start + inserted_length + glyph.range.end - end;
      kept.push_back(std::move(glyph));
    }
  }
  request->source_glyphs = std::move(kept);
}

bool CompleteSourceParagraphFonts(pdf_editor::ParagraphRequest* request,
    std::vector<std::shared_ptr<const FontResource>>* fonts,
    uint32_t start, uint32_t end, const std::string& font_id,
    const std::map<std::string, std::shared_ptr<const FontResource>>& resources) {
  if (start == end) return true;
  LayoutText text;
  if (!DecodeLayoutText(request->utf8, &text)) return false;
  const auto selected = resources.find(font_id);
  if (!font_id.empty() && selected == resources.end()) {
    SetError("INVALID_REQUEST", "The requested paragraph font is not registered."); return false;
  }
  if (request->styles.empty()) request->styles.push_back({{0, static_cast<uint32_t>(text.utf16.size())}, 0,
      request->font_size, request->letter_spacing, request->color, request->underline});
  std::vector<pdf_editor::ParagraphStyleRun> updated;
  std::optional<uint32_t> completion;
  auto normalize = [](std::string value) {
    if (value.size() > 7 && value[6] == '+') value.erase(0, 7);
    std::string result;
    for (unsigned char c : value) if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))
      result += static_cast<char>(c >= 'A' && c <= 'Z' ? c + 'a' - 'A' : c);
    return result;
  };
  for (const auto& run : request->styles) {
    auto* source = (*fonts)[run.font_index]->source_font;
    if (!source || run.range.end <= start || run.range.start >= end) { updated.push_back(run); continue; }
    uint32_t cursor = run.range.start;
    while (cursor < run.range.end) {
      uint32_t next = cursor + 1;
      if (text.utf16[cursor] >= 0xd800 && text.utf16[cursor] <= 0xdbff) ++next;
      auto piece = run; piece.range = {cursor, next};
      const auto value = request->utf8.substr(text.byte_offsets[cursor], text.byte_offsets[next] - text.byte_offsets[cursor]);
      if (cursor >= start && next <= end && text.utf16[cursor] != u'\n' && text.utf16[cursor] != u'\r' && !FontCanEncode(source, value)) {
        if (selected == resources.end()) {
          SetError("UNSUPPORTED_CAPABILITY", "The original PDF font cannot encode this character; choose the matching font for the added text."); return false;
        }
        const auto family = source->GetFont()->GetFamilyName();
        const auto& face = selected->second->face;
        if (normalize(std::string(family.c_str(), family.GetLength())) != normalize(face.family) ||
            source->GetFont()->IsItalic() != face.italic || source->GetFont()->IsBold() != (face.weight >= 600)) {
          SetError("UNSUPPORTED_CAPABILITY", "Source-preserving text edits require the exact matching font family and style."); return false;
        }
        if (!completion) {
          completion = static_cast<uint32_t>(fonts->size()); fonts->push_back(selected->second);
        }
        piece.font_index = *completion;
      }
      if (!updated.empty() && updated.back().range.end == piece.range.start && updated.back().font_index == piece.font_index &&
          updated.back().font_size == piece.font_size && updated.back().letter_spacing == piece.letter_spacing &&
          updated.back().underline == piece.underline && updated.back().color.red == piece.color.red &&
          updated.back().color.green == piece.color.green && updated.back().color.blue == piece.color.blue)
        updated.back().range.end = next;
      else updated.push_back(piece);
      cursor = next;
    }
  }
  request->styles = std::move(updated);
  return true;
}

// Saved source Forms already expose one ActualText cluster per text object.
// Reuse those exact glyphs rather than round-tripping their PDF character codes.
bool ReadSourceParagraphGlyphs(FPDF_PAGEOBJECT object, const std::string& original,
                              pdf_editor::ParagraphRequest* request,
                              uint32_t fragment_start = 0) {
  LayoutText logical;
  if (!DecodeLayoutText(original, &logical)) return false;
  auto* native = CPDFPageObjectFromFPDFPageObject(object);
  auto* form = native->AsForm() ? native->AsForm()->form() : nullptr;
  if (!form) return false;
  uint32_t cursor = fragment_start;
  const auto stored = form->GetDict()->GetDictFor("KomoParagraph");
  for (size_t index = 0; index < form->GetPageObjectCount(); ++index) {
    auto* text = form->GetPageObjectByIndex(index)->AsText();
    if (!text) continue;
    const auto* mark = pdf_editor::tagged::ActualMark(text);
    if (!mark || !mark->GetParam()) continue;
    const auto raw = mark->GetParam()->GetUnicodeTextFor("ActualText").ToUTF8();
    LayoutText cluster;
    if (!DecodeLayoutText(std::string(raw.c_str(), raw.GetLength()), &cluster) || cluster.utf16.empty()) continue;
    while (cursor < logical.utf16.size() &&
           (logical.utf16[cursor] == u'\n' || logical.utf16[cursor] == u'\r' || logical.utf16[cursor] == u' ' || logical.utf16[cursor] == u'\t') &&
           logical.utf16[cursor] != cluster.utf16.front()) {
      if (logical.utf16[cursor] == u' ' || logical.utf16[cursor] == u'\t')
        request->source_glyphs.push_back({{cursor, cursor + 1}, nullptr, 0, 0});
      ++cursor;
    }
    if (cursor + cluster.utf16.size() > logical.utf16.size() ||
        !std::equal(cluster.utf16.begin(), cluster.utf16.end(), logical.utf16.begin() + cursor)) {
      SetError("UNSUPPORTED_CAPABILITY", "The source paragraph has unsupported glyph clusters."); return false;
    }
    auto glyph = text->Clone();
    const auto matrix = glyph->GetTextMatrix();
    if (fragment_start == 0 && !request->source_baseline && stored)
      request->source_baseline = stored->GetFloatFor("Height") - matrix.f;
    float advance = glyph->CalcPositionData(1).x * matrix.a;
    // Stored advances retain TJ adjustments even when there is a line break
    // between this glyph and its next neighbour in the saved frame.
    if (mark->GetParam()->KeyExist("KomoAdvance")) advance = mark->GetParam()->GetFloatFor("KomoAdvance");
    else {
      auto* next = index + 1 < form->GetPageObjectCount() ? form->GetPageObjectByIndex(index + 1)->AsText() : nullptr;
      if (next) {
        const auto next_matrix = next->GetTextMatrix();
        if (std::abs(next_matrix.f - matrix.f) < 0.01f) advance = next_matrix.e - matrix.e;
      }
    }
    glyph->SetTextMatrix(CFX_Matrix(matrix.a, matrix.b, matrix.c, matrix.d, 0, 0));
    glyph->SetContentMarks(CPDF_ContentMarks());
    const uint32_t length = static_cast<uint32_t>(cluster.utf16.size());
    const float baseline_offset = mark->GetParam()->GetFloatFor("KomoBaseline");
    request->source_glyphs.push_back({{cursor, cursor + length},
        std::shared_ptr<const CPDF_TextObject>(std::move(glyph)), advance, baseline_offset});
    cursor += length;
  }
  return true;
}
