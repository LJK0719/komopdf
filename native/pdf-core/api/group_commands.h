// Persistent object groups use real Form XObjects; members retain PDF objects.
// Included after the shared object cloning and candidate identity helpers.

bool ApplyObjectsGroup(const Document& document,
                       FPDF_DOCUMENT pdf,
                       CandidateMetadata* metadata,
                       const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page))
    return false;
  if (MetadataContainsId(*metadata, command.target_id)) {
    SetError("INVALID_REQUEST", "The new group ID already exists.");
    return false;
  }
  CPDF_Page* native_page = CPDFPageFromFPDFPage(page.get());
  CPDF_Document* native_document = CPDFDocumentFromFPDFDocument(pdf);
  if (!native_page || !native_document) { SetUnexpectedError(); return false; }

  std::vector<size_t> indices;
  indices.reserve(command.ids.size());
  for (const auto& id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], id,
                          false, &target)) return false;
    if (target.path.size() != 1 ||
        FPDFPageObj_GetType(target.object) == FPDF_PAGEOBJ_FORM ||
        FPDFPageObj_CountMarks(target.object) != 0) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Only unmarked top-level non-Form objects can be grouped safely.");
      return false;
    }
    indices.push_back(target.path[0]);
  }
  std::sort(indices.begin(), indices.end());
  for (size_t index = 1; index < indices.size(); ++index) {
    if (indices[index] != indices[index - 1] + 1) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Group members must be adjacent in PDF drawing order.");
      return false;
    }
  }

  std::vector<ObjectIdentity> children;
  std::vector<std::unique_ptr<CPDF_PageObject>> objects;
  children.reserve(indices.size());
  objects.reserve(indices.size());
  int32_t content_stream = CPDF_PageObject::kNoContentStream;
  float left = std::numeric_limits<float>::max();
  float bottom = std::numeric_limits<float>::max();
  float right = -std::numeric_limits<float>::max();
  float top = -std::numeric_limits<float>::max();
  for (size_t index : indices) {
    FPDF_PAGEOBJECT original = FPDFPage_GetObject(page.get(), static_cast<int>(index));
    auto* source = original ? CPDFPageObjectFromFPDFPageObject(original) : nullptr;
    if (!source) { SetUnexpectedError(); return false; }
    if (objects.empty()) content_stream = source->GetContentStream();
    else if (content_stream != source->GetContentStream()) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Grouping objects from separate PDF content streams is not supported.");
      return false;
    }
    float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    if (!FPDFPageObj_GetBounds(original, &x0, &y0, &x1, &y1)) {
      SetUnexpectedError(); return false;
    }
    left = std::min(left, x0); bottom = std::min(bottom, y0);
    right = std::max(right, x1); top = std::max(top, y1);
    auto clone = CloneTopLevelObject(source);
    if (!clone) return false;
    objects.push_back(std::move(clone));
    children.push_back(metadata->pages[page_index].objects[index]);
  }
  if (!(left < right && bottom < top)) {
    SetError("UNSUPPORTED_CAPABILITY", "Group members have no usable bounds.");
    return false;
  }

  auto stream = native_document->NewIndirect<CPDF_Stream>(pdfium::span<const uint8_t>());
  auto dict = stream->GetMutableDict();
  dict->SetNewFor<CPDF_Name>("Type", "XObject");
  dict->SetNewFor<CPDF_Name>("Subtype", "Form");
  dict->SetNewFor<CPDF_Number>("FormType", 1);
  dict->SetRectFor("BBox", CFX_FloatRect(left, bottom, right, top));
  if (auto resources = native_page->GetResources())
    dict->SetFor("Resources", resources->Clone());
  else
    dict->SetNewFor<CPDF_Dictionary>("Resources");
  auto group = dict->SetNewFor<CPDF_Dictionary>("KomoGroup");
  group->SetNewFor<CPDF_Number>("Version", 1);
  const WideString group_id = WideString::FromUTF8(ByteStringView(command.target_id));
  group->SetNewFor<CPDF_String>("Id", group_id.AsStringView());
  auto ids = group->SetNewFor<CPDF_Array>("Ids");
  auto text_ids = group->SetNewFor<CPDF_Array>("TextIds");
  for (const auto& child : children) {
    const WideString id = WideString::FromUTF8(ByteStringView(child.id));
    const WideString text_id = WideString::FromUTF8(ByteStringView(child.text_block_id));
    ids->AppendNew<CPDF_String>(id.AsStringView());
    text_ids->AppendNew<CPDF_String>(text_id.AsStringView());
  }

  auto form = std::make_unique<CPDF_Form>(native_document,
                                           native_page->GetMutablePageResources(),
                                           std::move(stream));
  form->ParseContent();
  for (auto& object : objects) form->AppendPageObject(std::move(object));
  CPDF_PageContentGenerator(form.get()).GenerateFormContentForEditing(form.get());
  auto grouped = std::make_unique<CPDF_FormObject>(
      CPDF_PageObject::kNoContentStream, std::move(form), CFX_Matrix());
  grouped->CalcBoundingBox();
  grouped->SetDirty(true);

  for (auto it = indices.rbegin(); it != indices.rend(); ++it) {
    auto* original = native_page->GetPageObjectByIndex(*it);
    if (!native_page->RemovePageObject(original)) {
      SetUnexpectedError(); return false;
    }
    metadata->pages[page_index].objects.erase(
        metadata->pages[page_index].objects.begin() + static_cast<std::ptrdiff_t>(*it));
  }
  ObjectIdentity identity;
  identity.id = command.target_id;
  identity.children = std::move(children);
  if (!native_page->InsertPageObjectAtIndex(indices.front(), std::move(grouped))) {
    SetUnexpectedError(); return false;
  }
  metadata->pages[page_index].objects.insert(
      metadata->pages[page_index].objects.begin() + static_cast<std::ptrdiff_t>(indices.front()),
      std::move(identity));
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE", "The group Form could not be written to the PDF page.");
    return false;
  }
  return true;
}

bool ApplyObjectsUngroup(FPDF_DOCUMENT pdf,
                         CandidateMetadata* metadata,
                         const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page))
    return false;
  ObjectTarget target;
  if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                        command.target_id, false, &target)) return false;
  if (target.path.size() != 1 || !GroupMetadata(target.object)) {
    SetError("INVALID_REQUEST", "The selected object is not a persistent PDF group.");
    return false;
  }
  auto* native_page = CPDFPageFromFPDFPage(page.get());
  auto* group = CPDFPageObjectFromFPDFPageObject(target.object)->AsForm();
  const std::vector<ObjectIdentity> saved = metadata->pages[page_index].objects[target.path[0]].children;
  if (!native_page || !group || saved.size() != group->form()->GetPageObjectCount()) {
    SetUnexpectedError(); return false;
  }
  const CFX_Matrix placement = group->form_matrix();
  std::vector<std::unique_ptr<CPDF_PageObject>> objects;
  for (const auto& child : *group->form()) {
    auto clone = CloneTopLevelObject(child.get());
    if (!clone) return false;
    clone->Transform(placement);
    clone->TransformClipPath(placement);
    clone->SetContentStream(CPDF_PageObject::kNoContentStream);
    clone->SetDirty(true);
    objects.push_back(std::move(clone));
  }
  const size_t group_index = target.path[0];
  if (!native_page->RemovePageObject(group)) { SetUnexpectedError(); return false; }
  metadata->pages[page_index].objects.erase(
      metadata->pages[page_index].objects.begin() + static_cast<std::ptrdiff_t>(group_index));
  for (size_t index = 0; index < objects.size(); ++index) {
    if (!native_page->InsertPageObjectAtIndex(group_index + index, std::move(objects[index]))) {
      SetUnexpectedError(); return false;
    }
    metadata->pages[page_index].objects.insert(
        metadata->pages[page_index].objects.begin() + static_cast<std::ptrdiff_t>(group_index + index),
        saved[index]);
  }
  if (!FPDFPage_GenerateContent(page.get())) {
    SetError("CORE_UNAVAILABLE", "Ungrouped objects could not be generated.");
    return false;
  }
  return true;
}
