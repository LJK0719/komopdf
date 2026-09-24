// Persistent object groups use real Form XObjects; members retain PDF objects.
// Included after the shared object cloning and candidate identity helpers.

std::vector<ObjectIdentity>* GroupSiblingIdentities(
    PageIdentity* page, const std::vector<size_t>& path) {
  auto* siblings = &page->objects;
  for (size_t depth = 0; depth + 1 < path.size(); ++depth)
    siblings = &(*siblings)[path[depth]].children;
  return siblings;
}

bool GenerateGroupChange(FPDF_PAGE page, PageIdentity* identity,
                         const std::vector<size_t>& path,
                         const std::optional<pdf_editor::PreparedFormPath>& prepared) {
  if (prepared && !RewriteGroupMetadata(
          FPDFPage_GetObject(page, static_cast<int>(path.front())),
          identity->objects[path.front()])) return false;
  return GenerateEditedObjectHolder(page, prepared,
                                    "The persistent group content could not be generated.");
}

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
  std::vector<size_t> member_path;
  indices.reserve(command.ids.size());
  for (const auto& id : command.ids) {
    ObjectTarget target;
    if (!FindObjectTarget(page.get(), &metadata->pages[page_index], id,
                          false, &target)) return false;
    if ((FPDFPageObj_CountMarks(target.object) != 0 &&
         !(FPDFPageObj_GetType(target.object) == FPDF_PAGEOBJ_TEXT && HasSupportedTextMarks(target.object))) ||
        (!member_path.empty() &&
         (target.path.size() != member_path.size() ||
          !std::equal(target.path.begin(), target.path.end() - 1, member_path.begin())))) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Group members must be unmarked siblings in the same drawing container.");
      return false;
    }
    member_path = target.path;
    indices.push_back(target.path.back());
  }
  CPDF_PageObjectHolder* source_holder = native_page;
  for (size_t depth = 0; depth + 1 < member_path.size(); ++depth)
    source_holder = source_holder->GetPageObjectByIndex(member_path[depth])->AsForm()->form();
  const auto selected_indices = indices;
  for (size_t index : selected_indices) {
    if (index + 1 < source_holder->GetPageObjectCount() &&
        HasObjectMark(FPDFPageObjectFromCPDFPageObject(source_holder->GetPageObjectByIndex(index + 1)),
                      "KomoUnderlinePath")) indices.push_back(index + 1);
  }
  std::sort(indices.begin(), indices.end());
  indices.erase(std::unique(indices.begin(), indices.end()), indices.end());
  for (size_t index = 1; index < indices.size(); ++index) {
    if (indices[index] != indices[index - 1] + 1) {
      SetError("UNSUPPORTED_CAPABILITY", "Group members must be adjacent in PDF drawing order.");
      return false;
    }
  }
  CPDF_PageObjectHolder* holder = nullptr;
  std::optional<pdf_editor::PreparedFormPath> prepared;
  if (!PrepareObjectHolder(page.get(), member_path, &holder, &prepared)) return false;
  auto* siblings = GroupSiblingIdentities(&metadata->pages[page_index], member_path);
  std::vector<ObjectIdentity> children;
  std::vector<std::unique_ptr<CPDF_PageObject>> objects;
  children.reserve(indices.size());
  objects.reserve(indices.size());
  float left = std::numeric_limits<float>::max();
  float bottom = std::numeric_limits<float>::max();
  float right = -std::numeric_limits<float>::max();
  float top = -std::numeric_limits<float>::max();
  for (size_t index : indices) {
    auto* source = holder->GetPageObjectByIndex(index);
    if (!source) { SetUnexpectedError(); return false; }
    float x0 = 0, y0 = 0, x1 = 0, y1 = 0;
    if (!FPDFPageObj_GetBounds(FPDFPageObjectFromCPDFPageObject(source), &x0, &y0, &x1, &y1)) {
      SetUnexpectedError(); return false;
    }
    left = std::min(left, x0); bottom = std::min(bottom, y0);
    right = std::max(right, x1); top = std::max(top, y1);
    auto clone = CloneTopLevelObject(source);
    if (!clone) return false;
    objects.push_back(std::move(clone));
    children.push_back((*siblings)[index]);
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
  if (auto resources = holder->GetResources())
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
                                         holder->GetMutablePageResources(), std::move(stream));
  form->ParseContent();
  for (auto& object : objects) form->AppendPageObject(std::move(object));
  CPDF_PageContentGenerator(form.get()).GenerateFormContentForEditing(form.get());
  auto grouped = std::make_unique<CPDF_FormObject>(
      CPDF_PageObject::kNoContentStream, std::move(form), CFX_Matrix());
  grouped->CalcBoundingBox();
  grouped->SetDirty(true);
  for (auto it = indices.rbegin(); it != indices.rend(); ++it) {
    if (!holder->RemovePageObject(holder->GetPageObjectByIndex(*it))) {
      SetUnexpectedError(); return false;
    }
    siblings->erase(siblings->begin() + static_cast<std::ptrdiff_t>(*it));
  }
  ObjectIdentity identity;
  identity.id = command.target_id;
  identity.children = std::move(children);
  if (!holder->InsertPageObjectAtIndex(indices.front(), std::move(grouped))) {
    SetUnexpectedError(); return false;
  }
  siblings->insert(siblings->begin() + static_cast<std::ptrdiff_t>(indices.front()), std::move(identity));
  return GenerateGroupChange(page.get(), &metadata->pages[page_index], member_path, prepared);
}

bool ApplyObjectsUngroup(FPDF_DOCUMENT pdf,
                         CandidateMetadata* metadata,
                         const EditCommand& command) {
  size_t page_index = 0;
  ScopedPage page(nullptr);
  if (!LoadCommandPage(pdf, metadata, command.page_id, &page_index, &page)) return false;
  ObjectTarget target;
  if (!FindObjectTarget(page.get(), &metadata->pages[page_index],
                        command.target_id, false, &target)) return false;
  if (!GroupMetadata(target.object)) {
    SetError("INVALID_REQUEST", "The selected object is not a persistent PDF group.");
    return false;
  }
  CPDF_PageObjectHolder* holder = nullptr;
  std::optional<pdf_editor::PreparedFormPath> prepared;
  if (!PrepareObjectHolder(page.get(), target.path, &holder, &prepared)) return false;
  auto* group = CPDFPageObjectFromFPDFPageObject(target.object)->AsForm();
  auto* siblings = GroupSiblingIdentities(&metadata->pages[page_index], target.path);
  const std::vector<ObjectIdentity> saved = target.identity->children;
  if (!group || saved.size() != group->form()->GetPageObjectCount()) {
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
  const size_t group_index = target.path.back();
  if (!holder->RemovePageObject(group)) { SetUnexpectedError(); return false; }
  siblings->erase(siblings->begin() + static_cast<std::ptrdiff_t>(group_index));
  for (size_t index = 0; index < objects.size(); ++index) {
    if (!holder->InsertPageObjectAtIndex(group_index + index, std::move(objects[index]))) {
      SetUnexpectedError(); return false;
    }
    siblings->insert(siblings->begin() + static_cast<std::ptrdiff_t>(group_index + index), saved[index]);
  }
  return GenerateGroupChange(page.get(), &metadata->pages[page_index], target.path, prepared);
}
