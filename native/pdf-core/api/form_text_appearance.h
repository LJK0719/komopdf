// Shaped text appearances reuse the paragraph engine and the field's own font.
// PDFium generates the empty widget first, retaining its border, background,
// rotation and appearance matrix; only the text painting is appended.
bool NeedsShapedFieldText(std::string_view value) {
  std::vector<uint32_t> characters;
  if (!DecodeUtf8(value, &characters)) return false;
  return std::any_of(characters.begin(), characters.end(), [](uint32_t character) {
    return character > 0xffff || u_getCombiningClass(static_cast<UChar32>(character)) != 0;
  });
}

bool FillShapedTextField(FPDF_DOCUMENT pdf, CPDF_FormField* field,
                        const std::string& value,
                        const std::map<std::string, std::shared_ptr<const FontResource>>& fonts,
                        std::string* error) {
  auto* native = CPDFDocumentFromFPDFDocument(pdf);
  auto acroform = native->GetMutableRoot()->GetMutableDictFor("AcroForm");
  if (!acroform || field->CountControls() == 0) {
    *error = "The text field has no AcroForm appearance resources.";
    return false;
  }
  // Retain the same validation and read-only checks as ordinary field filling.
  pdf_editor::FormValue blank;
  if (!pdf_editor::FillFormField(pdf, FormUtf8(field->GetFullName()), blank, error)) return false;
  for (int index = 0; index < field->CountControls(); ++index) {
    auto* control = field->GetControl(index);
    auto* widget = const_cast<CPDF_Dictionary*>(control->GetWidgetDict().Get());
    CPDF_DefaultAppearance appearance(widget, acroform.Get());
    const auto font_info = appearance.GetFont();
    auto resources = ToDictionary(CPDF_FormField::GetMutableFieldAttrForDict(widget, "DR"));
    if (!resources) resources = acroform->GetMutableDictFor("DR");
    const auto font_resources = resources ? resources->GetDictFor("Font") : nullptr;
    const auto font_dictionary = font_info && font_resources
        ? font_resources->GetDictFor(font_info->name.AsStringView()) : nullptr;
    if (!font_dictionary) { *error = "The field's default font is unavailable."; return false; }
    auto font_metadata = pdfium::MakeRetain<CPDF_Dictionary>();
    font_metadata->SetFor("Font", font_dictionary->Clone());
    const auto registered_id = field->GetFieldDict()->GetUnicodeTextFor("KomoFontId");
    font_metadata->SetNewFor<CPDF_String>("RegisteredFontId", registered_id.AsStringView());
    auto font = ResolveParagraphFont(font_metadata.Get(), fonts);
    if (!font) {
      *error = "The field's embedded font cannot be shaped; create the field with a suitable registered font.";
      return false;
    }
    auto ap = widget->GetMutableDictFor("AP");
    const auto normal = ap ? ap->GetStreamFor("N") : nullptr;
    if (!normal) { *error = "PDFium could not create the widget background appearance."; return false; }
    const auto box = normal->GetDict()->GetRectFor("BBox");
    const auto border = widget->GetDictFor("BS");
    const float inset = std::max(2.0f, border ? border->GetFloatFor("W") : 1.0f);
    const float width = box.Width() - 2 * inset;
    const float height = box.Height() - 2 * inset;
    if (!(width > 0 && height > 0)) { *error = "The field has no usable text area."; return false; }
    const bool multiline = (field->GetFieldFlags() & (1U << 12)) != 0;
    // Password and comb fields have special display semantics, never paint the raw value.
    if (field->GetFieldFlags() & ((1U << 13) | (1U << 24))) {
      *error = "Shaped password and comb field appearances are not supported.";
      return false;
    }
    pdf_editor::ParagraphRequest request;
    request.utf8 = value;
    request.font_size = font_info->size > 0 ? font_info->size : std::min(12.0f, height / 1.2f);
    request.width = width;
    request.height = height;
    const int alignment = control->GetControlAlignment();
    request.alignment = alignment == 1 ? pdf_editor::ParagraphAlignment::kCenter :
        alignment == 2 ? pdf_editor::ParagraphAlignment::kRight : pdf_editor::ParagraphAlignment::kLeft;
    if (const auto color = appearance.GetColorARGB()) {
      request.color = {((color->argb >> 16) & 255) / 255.0f,
                       ((color->argb >> 8) & 255) / 255.0f, (color->argb & 255) / 255.0f};
    }
    if (!multiline) {
      pdf_editor::TextShapingOptions options;
      options.font_size = request.font_size;
      pdf_editor::ShapedText shaped;
      if (!pdf_editor::ShapeText(font->SfntBytes(), value, options, &shaped, error)) return false;
      float advance = 0;
      for (const auto& glyph : shaped.glyphs) advance += glyph.x_advance;
      if (font_info->size == 0 && advance > width) {
        request.font_size *= width / advance;
        advance = width;
      }
      request.width = std::max(width, advance + 0.1f);
      request.height = std::max(height, request.font_size * 1.4f);
    }
    pdf_editor::ParagraphResult paragraph;
    if (!pdf_editor::CreateTextParagraph(pdf, font->face, font->SfntBytes(), request, &paragraph, error)) return false;
    std::unique_ptr<CPDF_PageObject> content(CPDFPageObjectFromFPDFPageObject(paragraph.object));
    const auto content_stream = content->AsForm()->form()->GetStream();
    auto combined = ToStream(normal->Clone());
    auto dictionary = combined->GetMutableDict();
    auto appearance_resources = dictionary->GetMutableDictFor("Resources");
    if (appearance_resources) {
      appearance_resources = ToDictionary(appearance_resources->Clone());
      dictionary->SetFor("Resources", appearance_resources);
    } else {
      appearance_resources = dictionary->SetNewFor<CPDF_Dictionary>("Resources");
    }
    auto xobjects = appearance_resources->GetOrCreateDictFor("XObject");
    const ByteString name("KomoShapedText");
    xobjects->SetNewFor<CPDF_Reference>(name, native, content_stream->GetObjNum());
    auto decoded = pdfium::MakeRetain<CPDF_StreamAcc>(normal);
    decoded->LoadAllDataFiltered();
    const auto bytes = decoded->GetSpan();
    std::string stream(reinterpret_cast<const char*>(bytes.data()), bytes.size());
    float x = box.left + inset;
    float y = box.bottom + inset;
    if (!multiline) {
      if (alignment == 1) x -= (request.width - width) / 2;
      else if (alignment == 2) x -= request.width - width;
      if (!paragraph.lines.empty()) {
        const auto& line = paragraph.lines.front().bounds;
        const float painted_center = request.height - line.y - line.height / 2;
        y += height / 2 - painted_center;
      }
    }
    stream += "\nq " + std::to_string(box.left + inset) + " " + std::to_string(box.bottom + inset) +
        " " + std::to_string(width) + " " + std::to_string(height) + " re W n 1 0 0 1 " +
        std::to_string(x) + " " + std::to_string(y) + " cm /KomoShapedText Do Q\n";
    combined->SetDataAndRemoveFilter(pdfium::span<const uint8_t>(
        reinterpret_cast<const uint8_t*>(stream.data()), stream.size()));
    native->AddIndirectObject(combined);
    ap->SetNewFor<CPDF_Reference>("N", native, combined->GetObjNum());
  }
  const WideString text = WideString::FromUTF8(ByteStringView(value));
  if (!field->SetValue(text, NotificationOption::kDoNotNotify)) {
    *error = "The shaped field value could not be stored.";
    return false;
  }
  return true;
}
