// Candidate-level document tools. Included after the core object helpers.

std::string FormFieldId(const Document& document, const CPDF_FormField& field) {
  const ByteString stored = field.GetFieldDict()->GetUnicodeTextFor("KomoFieldId").ToUTF8();
  if (!stored.IsEmpty() && stored.GetLength() <= 160)
    return {stored.c_str(), stored.GetLength()};
  const ByteString name = field.GetFullName().ToUTF8();
  return "f:" + std::to_string(document.session_id) + ":" +
      std::to_string(StableIdHash({name.c_str(), name.GetLength()}));
}

std::string FormUtf8(const WideString& text) {
  const ByteString value = text.ToUTF8();
  return {value.c_str(), value.GetLength()};
}

CPDF_FormField* FindFormField(const Document& document,
                             CPDF_InteractiveForm* form,
                             const std::string& id) {
  const size_t count = form->CountFields(WideString());
  for (size_t index = 0; index < count; ++index) {
    CPDF_FormField* field = form->GetField(index, WideString());
    if (field && FormFieldId(document, *field) == id) return field;
  }
  SetError("INVALID_REQUEST", "The requested form field does not exist.");
  return nullptr;
}

std::optional<size_t> FormWidgetPage(FPDF_DOCUMENT pdf,
                                    const CandidateMetadata& metadata,
                                    const CPDF_Dictionary* widget) {
  CPDF_Document* native = CPDFDocumentFromFPDFDocument(pdf);
  for (size_t index = 0; index < metadata.pages.size(); ++index) {
    const auto page = native->GetPageDictionary(static_cast<int>(index));
    const auto annots = page ? page->GetArrayFor("Annots") : nullptr;
    if (!annots) continue;
    for (size_t offset = 0; offset < annots->size(); ++offset) {
      if (annots->GetDictAt(offset).Get() == widget) return index;
    }
  }
  return std::nullopt;
}

std::string SerializeForms(const Document& document) {
  CPDF_InteractiveForm form(CPDFDocumentFromFPDFDocument(document.pdf));
  std::string result = "[";
  bool first = true;
  for (size_t index = 0; index < form.CountFields(WideString()); ++index) {
    CPDF_FormField* field = form.GetField(index, WideString());
    if (!field) continue;
    const auto type = field->GetFieldType();
    const char* kind = type == FormFieldType::kTextField ? "text" :
        type == FormFieldType::kCheckBox ? "checkbox" :
        type == FormFieldType::kRadioButton ? "radio" :
        (type == FormFieldType::kComboBox || type == FormFieldType::kListBox) ? "choice" : nullptr;
    if (!kind) continue;
    if (!first) result += ',';
    first = false;
    result += "{\"id\":"; AppendJsonString(&result, FormFieldId(document, *field));
    result += ",\"name\":"; AppendJsonString(&result, FormUtf8(field->GetFullName()));
    result += ",\"type\":"; AppendJsonString(&result, kind);
    if (type == FormFieldType::kComboBox || type == FormFieldType::kListBox) {
      result += ",\"choiceKind\":";
      AppendJsonString(&result, type == FormFieldType::kComboBox ? "combo" : "list");
    }
    result += ",\"readOnly\":"; result += (field->GetFieldFlags() & 1U) ? "true" : "false";
    result += ",\"required\":"; result += field->IsRequired() ? "true" : "false";
    result += ",\"multiple\":";
    result += (type == FormFieldType::kListBox &&
               (field->GetFieldFlags() & (1U << 21))) ? "true" : "false";
    const WideString tooltip = field->GetAlternateName();
    if (!tooltip.IsEmpty()) {
      result += ",\"tooltip\":"; AppendJsonString(&result, FormUtf8(tooltip));
    }
    const int max_len = field->GetMaxLen();
    if (type == FormFieldType::kTextField && max_len > 0) {
      result += ",\"maxLen\":" + std::to_string(max_len);
    }
    result += ",\"value\":";
    if (type == FormFieldType::kCheckBox) {
      bool checked = false;
      for (int control = 0; control < field->CountControls(); ++control)
        checked |= field->GetControl(control)->IsChecked();
      result += checked ? "true" : "false";
    } else if (type == FormFieldType::kListBox && (field->GetFieldFlags() & (1U << 21))) {
      result += '[';
      for (int selection = 0; selection < field->CountSelectedItems(); ++selection) {
        if (selection) result += ',';
        AppendJsonString(&result, FormUtf8(field->GetOptionValue(field->GetSelectedIndex(selection))));
      }
      result += ']';
    } else {
      AppendJsonString(&result, FormUtf8(field->GetValue()));
    }
    result += ",\"options\":[";
    if (type == FormFieldType::kRadioButton) {
      for (int control = 0; control < field->CountControls(); ++control) {
        if (control) result += ',';
        AppendJsonString(&result, FormUtf8(field->GetControl(control)->GetExportValue()));
      }
    } else if (type == FormFieldType::kComboBox || type == FormFieldType::kListBox) {
      for (int option = 0; option < field->CountOptions(); ++option) {
        if (option) result += ',';
        AppendJsonString(&result, FormUtf8(field->GetOptionValue(option)));
      }
    }
    result += "],\"widgets\":[";
    bool first_widget = true;
    for (int control_index = 0; control_index < field->CountControls(); ++control_index) {
      const CPDF_FormControl* control = field->GetControl(control_index);
      const auto page_index = FormWidgetPage(document.pdf, document.metadata, control->GetWidgetDict().Get());
      if (!page_index) continue;
      ScopedPage page(FPDF_LoadPage(document.pdf, static_cast<int>(*page_index)));
      Matrix to_page, to_pdf;
      if (!page.get() || !GetPageMatrices(page.get(), &to_page, &to_pdf)) continue;
      const auto rect = control->GetRect();
      if (!first_widget) result += ',';
      first_widget = false;
      result += "{\"pageId\":"; AppendJsonString(&result, document.metadata.pages[*page_index].id);
      result += ",\"bounds\":";
      AppendRect(&result, TransformBounds(rect.left, rect.bottom, rect.right, rect.top, to_page));
      result += '}';
    }
    result += "]}";
  }
  result += ']';
  return result;
}

std::string SerializeOutline(const Document& document) {
  std::string result = "[";
  std::set<FPDF_BOOKMARK> visited;
  std::vector<std::pair<FPDF_BOOKMARK, uint32_t>> pending;
  if (FPDF_BOOKMARK first = FPDFBookmark_GetFirstChild(document.pdf, nullptr))
    pending.emplace_back(first, 0);
  while (!pending.empty()) {
    auto [bookmark, level] = pending.back();
    pending.pop_back();
    if (!visited.insert(bookmark).second) continue;
    const unsigned long bytes = FPDFBookmark_GetTitle(bookmark, nullptr, 0);
    std::string title;
    if (bytes >= sizeof(FPDF_WCHAR) && bytes % sizeof(FPDF_WCHAR) == 0) {
      std::vector<FPDF_WCHAR> utf16(bytes / sizeof(FPDF_WCHAR));
      if (FPDFBookmark_GetTitle(bookmark, utf16.data(), bytes) == bytes) {
        if (!utf16.empty() && utf16.back() == 0) utf16.pop_back();
        title = Utf16ToUtf8(utf16, utf16.size());
      }
    }
    if (result.size() > 1) result += ',';
    result += "{\"title\":"; AppendJsonString(&result, title);
    result += ",\"pageId\":";
    FPDF_DEST destination = FPDFBookmark_GetDest(document.pdf, bookmark);
    if (!destination) {
      const FPDF_ACTION action = FPDFBookmark_GetAction(bookmark);
      if (action && FPDFAction_GetType(action) == PDFACTION_GOTO)
        destination = FPDFAction_GetDest(document.pdf, action);
    }
    const int page_index = destination ? FPDFDest_GetDestPageIndex(document.pdf, destination) : -1;
    if (page_index >= 0 && static_cast<size_t>(page_index) < document.metadata.pages.size())
      AppendJsonString(&result, document.metadata.pages[page_index].id);
    else result += "null";
    result += ",\"level\":";
    AppendJsonUnsigned(&result, level);
    result += '}';
    if (FPDF_BOOKMARK sibling = FPDFBookmark_GetNextSibling(document.pdf, bookmark))
      pending.emplace_back(sibling, level);
    if (FPDF_BOOKMARK child = FPDFBookmark_GetFirstChild(document.pdf, bookmark))
      pending.emplace_back(child, level + 1);
  }
  result += ']';
  return result;
}

std::string SerializeAnnotations(const Document& document, size_t page_index) {
  ScopedPage page(FPDF_LoadPage(document.pdf, static_cast<int>(page_index)));
  Matrix to_page, to_pdf;
  if (!page.get() || !GetPageMatrices(page.get(), &to_page, &to_pdf)) return {};
  const auto annots = CPDFPageFromFPDFPage(page.get())->GetDict()->GetArrayFor("Annots");

  std::map<int, FPDF_LINK> enumerated_links;
  int link_pos = 0;
  FPDF_LINK enumerated_link = nullptr;
  while (FPDFLink_Enumerate(page.get(), &link_pos, &enumerated_link)) {
    if (link_pos > 0 && enumerated_link) {
      enumerated_links[link_pos - 1] = enumerated_link;
    }
  }

  std::string result = "[";
  bool first = true;
  if (annots) for (size_t index = 0; index < annots->size(); ++index) {
    const auto annot = annots->GetDictAt(index);
    if (!annot || annot->GetNameFor("Subtype") == "Widget") continue;
    const ByteString subtype = annot->GetNameFor("Subtype");
    const char* kind = subtype == "Highlight" ? "highlight" : subtype == "Text" ? "text" :
        subtype == "Square" ? "rectangle" : subtype == "Ink" ? "ink" :
        subtype == "Link" ? "link" : "other";
    std::string target_page_id;
    std::optional<double> target_top_pt;
    if (subtype == "Link") {
      auto link_it = enumerated_links.find(static_cast<int>(index));
      if (link_it != enumerated_links.end()) {
        FPDF_LINK link = link_it->second;
        FPDF_DEST destination = FPDFLink_GetDest(document.pdf, link);
        if (!destination) {
          const FPDF_ACTION action = FPDFLink_GetAction(link);
          if (action && FPDFAction_GetType(action) == PDFACTION_GOTO) {
            destination = FPDFAction_GetDest(document.pdf, action);
          }
        }
        if (destination) {
          const int target_page_index = FPDFDest_GetDestPageIndex(document.pdf, destination);
          if (target_page_index >= 0 && static_cast<size_t>(target_page_index) < document.metadata.pages.size()) {
            target_page_id = document.metadata.pages[target_page_index].id;
            FPDF_BOOL has_x = 0, has_y = 0, has_zoom = 0;
            FS_FLOAT x = 0, y = 0, zoom = 0;
            if (FPDFDest_GetLocationInPage(destination, &has_x, &has_y, &has_zoom, &x, &y, &zoom) && has_x && has_y) {
              ScopedPage target_page(FPDF_LoadPage(document.pdf, target_page_index));
              Matrix target_to_page, target_to_pdf;
              if (target_page.get() && GetPageMatrices(target_page.get(), &target_to_page, &target_to_pdf)) {
                const auto point = target_to_page.Apply(x, y);
                if (std::isfinite(point[1])) {
                  target_top_pt = point[1];
                }
              }
            }
          }
        }
      }
    }
    const ByteString stored = annot->GetUnicodeTextFor("NM").ToUTF8();
    const std::string id = stored.IsEmpty() ?
        "a:" + std::to_string(document.session_id) + ":" + std::to_string(annot->GetObjNum()) + ":" +
            document.metadata.pages[page_index].id + ":" + std::to_string(index) :
        std::string(stored.c_str(), stored.GetLength());
    if (!first) result += ',';
    first = false;
    result += "{\"id\":"; AppendJsonString(&result, id);
    result += ",\"pageId\":"; AppendJsonString(&result, document.metadata.pages[page_index].id);
    result += ",\"subtype\":"; AppendJsonString(&result, kind);
    const auto rect = annot->GetRectFor("Rect");
    result += ",\"bounds\":";
    AppendRect(&result, TransformBounds(rect.left, rect.bottom, rect.right, rect.top, to_page));
    result += ",\"text\":"; AppendJsonString(&result, FormUtf8(annot->GetUnicodeTextFor("Contents")));
    result += ",\"color\":[";
    const auto color = annot->GetArrayFor("C");
    for (size_t component = 0; component < 3; ++component) {
      if (component) result += ',';
      double value = 0;
      if (color && color->size() == 3) value = color->GetFloatAt(component);
      else if (color && color->size() == 1) value = color->GetFloatAt(0);
      else if (color && color->size() == 4)
        value = 1 - std::min(1.0, static_cast<double>(color->GetFloatAt(component) + color->GetFloatAt(3)));
      AppendJsonNumber(&result, value);
    }
    result += "],\"opacity\":";
    AppendJsonNumber(&result, annot->KeyExist("CA") ? annot->GetFloatFor("CA") : 1);
    if (!target_page_id.empty()) {
      result += ",\"targetPageId\":";
      AppendJsonString(&result, target_page_id);
      if (target_top_pt.has_value()) {
        result += ",\"targetTopPt\":";
        AppendJsonNumber(&result, *target_top_pt);
      }
    }
    result += '}';
  }
  result += ']';
  return result;
}

std::optional<size_t> FindAnnotationIndex(const Document& document,
                                          FPDF_DOCUMENT pdf,
                                          const CandidateMetadata& metadata,
                                          size_t page_index,
                                          const std::string& id) {
  CPDF_Document* native = CPDFDocumentFromFPDFDocument(pdf);
  const auto page = native->GetPageDictionary(static_cast<int>(page_index));
  const auto annots = page ? page->GetArrayFor("Annots") : nullptr;
  std::optional<size_t> match;
  if (annots) for (size_t index = 0; index < annots->size(); ++index) {
    const auto annot = annots->GetDictAt(index);
    if (!annot || annot->GetNameFor("Subtype") == "Widget") continue;
    const ByteString stored = annot->GetUnicodeTextFor("NM").ToUTF8();
    const std::string current = stored.IsEmpty() ?
        "a:" + std::to_string(document.session_id) + ":" +
            std::to_string(annot->GetObjNum()) + ":" +
            metadata.pages[page_index].id + ":" + std::to_string(index) :
        std::string(stored.c_str(), stored.GetLength());
    if (current != id) continue;
    if (match) {
      SetError("INVALID_REQUEST", "The annotation ID is ambiguous on this page.");
      return std::nullopt;
    }
    match = index;
  }
  if (!match) SetError("INVALID_REQUEST", "The annotation does not exist on the requested page.");
  return match;
}

void CollectDocumentToolIds(const Document& document, std::set<std::string>* ids) {
  CPDF_Document* native = CPDFDocumentFromFPDFDocument(document.pdf);
  CPDF_InteractiveForm form(native);
  for (size_t index = 0; index < form.CountFields(WideString()); ++index) {
    const CPDF_FormField* field = form.GetField(index, WideString());
    if (field) ids->insert(FormFieldId(document, *field));
  }
  for (size_t index = 0; index < document.metadata.pages.size(); ++index) {
    const auto page = native->GetPageDictionary(static_cast<int>(index));
    const auto annots = page ? page->GetArrayFor("Annots") : nullptr;
    if (!annots) continue;
    for (size_t offset = 0; offset < annots->size(); ++offset) {
      const auto annotation = annots->GetDictAt(offset);
      if (!annotation) continue;
      const ByteString id = annotation->GetUnicodeTextFor("NM").ToUTF8();
      if (!id.IsEmpty()) ids->insert({id.c_str(), id.GetLength()});
    }
  }
}

bool ApplyDocumentTool(
    const Document& document, FPDF_DOCUMENT pdf, CandidateMetadata* metadata,
    const EditCommand& command,
    const std::map<std::string, std::shared_ptr<const FontResource>>& fonts,
    CandidateFontCache* font_cache) {
  std::string error;
  if (command.type == EditType::kFormFill || command.type == EditType::kFormUpdate) {
    CPDF_InteractiveForm form(CPDFDocumentFromFPDFDocument(pdf));
    CPDF_FormField* field = FindFormField(document, &form, command.target_id);
    if (!field) return false;
    if (command.type == EditType::kFormUpdate) {
      if (command.flags & 8U) {
        if (field->GetType() != CPDF_FormField::kText) {
          SetError("INVALID_REQUEST", "MaxLen is only supported for text fields.");
          return false;
        }
        const int new_max_len = static_cast<int>(command.values[3]);
        if (new_max_len > 0) {
          const WideString current_val = field->GetValue();
          if (static_cast<int>(current_val.GetLength()) > new_max_len) {
            SetError("INVALID_REQUEST", "Text field current value exceeds requested maximum length.");
            return false;
          }
        }
      }

      CPDF_Dictionary* field_dict = const_cast<CPDF_Dictionary*>(field->GetFieldDict().Get());
      if (!field_dict) {
        SetError("CORE_UNAVAILABLE", "Form field dictionary is missing.");
        return false;
      }

      if (command.flags & 8U) {
        const int new_max_len = static_cast<int>(command.values[3]);
        if (new_max_len > 0) {
          field_dict->SetNewFor<CPDF_Number>("MaxLen", new_max_len);
        } else {
          field_dict->RemoveFor("MaxLen");
        }
        for (int i = 0; i < field->CountControls(); ++i) {
          if (CPDF_FormControl* control = field->GetControl(i)) {
            if (CPDF_Dictionary* widget_dict = const_cast<CPDF_Dictionary*>(control->GetWidgetDict().Get())) {
              if (widget_dict != field_dict) {
                if (new_max_len > 0 && widget_dict->KeyExist("MaxLen")) {
                  widget_dict->SetNewFor<CPDF_Number>("MaxLen", new_max_len);
                } else if (new_max_len == 0) {
                  widget_dict->RemoveFor("MaxLen");
                }
              }
            }
          }
        }
      }

      if (command.flags & 16U) {
        if (!command.text.empty()) {
          const WideString wide_tu = WideString::FromUTF8(ByteStringView(command.text));
          field_dict->SetNewFor<CPDF_String>("TU", wide_tu.AsStringView());
        } else {
          field_dict->RemoveFor("TU");
        }
        for (int i = 0; i < field->CountControls(); ++i) {
          if (CPDF_FormControl* control = field->GetControl(i)) {
            if (CPDF_Dictionary* widget_dict = const_cast<CPDF_Dictionary*>(control->GetWidgetDict().Get())) {
              if (widget_dict != field_dict) {
                if (!command.text.empty() && widget_dict->KeyExist("TU")) {
                  const WideString wide_tu = WideString::FromUTF8(ByteStringView(command.text));
                  widget_dict->SetNewFor<CPDF_String>("TU", wide_tu.AsStringView());
                } else if (command.text.empty()) {
                  widget_dict->RemoveFor("TU");
                }
              }
            }
          }
        }
      }

      if (command.flags & 7U) {
        const auto property = [&](uint32_t bit, size_t index) -> std::optional<bool> {
          return command.flags & bit ? std::optional<bool>(command.values[index] != 0)
                                     : std::nullopt;
        };
        if (!pdf_editor::UpdateFormField(pdf, FormUtf8(field->GetFullName()),
                property(1U, 0), property(2U, 1), property(4U, 2), &error)) {
          SetError("UNSUPPORTED_CAPABILITY", std::move(error)); return false;
        }
      }
      return true;
    }

    if (field->GetType() == CPDF_FormField::kText && (command.flags == 0)) {
      const int max_len = field->GetMaxLen();
      if (max_len > 0) {
        const WideString wide_text = WideString::FromUTF8(ByteStringView(command.text));
        if (static_cast<int>(wide_text.GetLength()) > max_len) {
          SetError("INVALID_REQUEST", "Text value exceeds field maximum length.");
          return false;
        }
      }
    }

    pdf_editor::FormValue value;
    if (command.flags & 1U) value.checked = command.values[0] != 0;
    else if (command.flags & 2U) value.selected_values = command.ids;
    else value.text_utf8 = command.text;
    if (!pdf_editor::FillFormField(pdf, FormUtf8(field->GetFullName()), value, &error)) {
      SetError("UNSUPPORTED_CAPABILITY", std::move(error)); return false;
    }
    return true;
  }
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) return false;
  if (command.type == EditType::kAnnotationUpdate ||
      command.type == EditType::kAnnotationDelete) {
    const auto index = FindAnnotationIndex(document, pdf, *metadata,
                                           page_index, command.target_id);
    if (!index) return false;
    if (*index > static_cast<size_t>(std::numeric_limits<int>::max()) ||
        !FPDFPage_RemoveAnnot(page.get(), static_cast<int>(*index))) {
      SetError("CORE_UNAVAILABLE", "The annotation could not be removed from its PDF page.");
      return false;
    }
    if (command.type == EditType::kAnnotationDelete) return true;
    // Rebuild the replacement appearance from a complete annotation spec.
    // The candidate document is discarded if appearance creation fails.
  }
  Matrix to_page, to_pdf;
  if (!GetPageMatrices(page.get(), &to_page, &to_pdf)) return false;
  const Rect rect = TransformBounds(command.values[0], command.values[1],
      command.values[0] + command.values[2], command.values[1] + command.values[3], to_pdf);
  const pdf_editor::PdfRect pdf_rect{rect.x, rect.y, rect.x + rect.width, rect.y + rect.height};
  if (command.type == EditType::kFormCreate) {
    pdf_editor::FormFieldSpec spec;
    spec.type = command.resource_id == "checkbox" ? pdf_editor::FormFieldType::kCheckbox :
        command.resource_id == "combo" ? pdf_editor::FormFieldType::kComboBox :
        command.resource_id == "list" ? pdf_editor::FormFieldType::kListBox :
        command.resource_id == "radio" ? pdf_editor::FormFieldType::kRadioButton :
        pdf_editor::FormFieldType::kText;
    spec.persistent_id = command.target_id;
    spec.name_utf8 = command.text;
    spec.options_utf8 = command.ids;
    spec.read_only = (command.flags & 2U) != 0;
    spec.required = (command.flags & 4U) != 0;
    spec.multiple = (command.flags & 8U) != 0;
    spec.rect = pdf_rect;
    spec.font_size = command.values[4];
    spec.rotation = FPDFPage_GetRotation(page.get()) * 90;
    if (!command.font_id.empty()) {
      const auto font = fonts.find(command.font_id);
      if (font == fonts.end()) { SetError("INVALID_REQUEST", "The form font is not registered."); return false; }
      spec.font = font_cache->LoadHandle(font->second);
      if (!spec.font) return false;
    }
    if (!pdf_editor::CreateFormField(pdf, page.get(), spec, &error)) {
      SetError("UNSUPPORTED_CAPABILITY", std::move(error)); return false;
    }
    return true;
  }
  pdf_editor::AnnotationSpec spec;
  spec.type = command.resource_id == "highlight" ? pdf_editor::AnnotationType::kHighlight :
      command.resource_id == "rectangle" ? pdf_editor::AnnotationType::kRectangle :
      command.resource_id == "ink" ? pdf_editor::AnnotationType::kInk : pdf_editor::AnnotationType::kText;
  spec.persistent_id = command.target_id; spec.contents_utf8 = command.text; spec.rect = pdf_rect;
  spec.color = (command.flags & 1U) ? pdf_editor::RgbColor{command.values[4], command.values[5], command.values[6]} :
      (command.resource_id == "highlight" ? pdf_editor::RgbColor{1, 1, 0} : pdf_editor::RgbColor{0, 0, 0});
  spec.opacity = (command.flags & 2U) ? command.values[7] : 1;
  spec.stroke_width = (command.flags & 4U) ? command.values[8] : 1;
  if (command.resource_id == "highlight") {
    const auto point = [&](double x, double y) {
      const auto position = to_pdf.Apply(x, y);
      return pdf_editor::PdfPoint{position[0], position[1]};
    };
    spec.quad_points.push_back({
      point(command.values[0], command.values[1]), point(command.values[0] + command.values[2], command.values[1]),
      point(command.values[0], command.values[1] + command.values[3]),
      point(command.values[0] + command.values[2], command.values[1] + command.values[3])});
  }
  if (command.resource_id == "ink") {
    std::vector<pdf_editor::PdfPoint> stroke;
    for (size_t index = 0; index < command.ids.size(); index += 2) {
      double x = 0, y = 0;
      std::from_chars(command.ids[index].data(), command.ids[index].data() + command.ids[index].size(), x);
      std::from_chars(command.ids[index + 1].data(), command.ids[index + 1].data() + command.ids[index + 1].size(), y);
      const auto point = to_pdf.Apply(x, y);
      stroke.push_back({point[0], point[1]});
    }
    spec.ink_strokes.push_back(std::move(stroke));
  }
  if (!pdf_editor::AddAnnotation(pdf, page.get(), spec, &error)) {
    SetError("UNSUPPORTED_CAPABILITY", std::move(error)); return false;
  }
  return true;
}
