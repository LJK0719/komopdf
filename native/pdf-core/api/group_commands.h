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
    if (!member_path.empty() &&
        (target.path.size() != member_path.size() ||
         !std::equal(target.path.begin(), target.path.end() - 1, member_path.begin()))) {
      SetError("UNSUPPORTED_CAPABILITY",
               "Group members must be siblings in the same drawing container.");
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
  bool tagged_members = false;
  std::set<int> whole_nonlocal_scopes;
  const std::set<size_t> selected(indices.begin(), indices.end());
  for (size_t index : indices) {
    auto* source = source_holder->GetPageObjectByIndex(index);
    const int mcid = source->GetContentMarks()->GetMarkedContentID();
    if (mcid >= 0) {
      tagged_members = true;
      if (!pdf_editor::tagged::ElementFor(native_document, source_holder, mcid)) {
        SetError("UNSUPPORTED_CAPABILITY", "The selected tagged scope has no ParentTree entry.");
        return false;
      }
      if (!pdf_editor::tagged::CanEditTextScope(source_holder, source)) {
        bool complete = true;
        for (size_t sibling = 0; sibling < source_holder->GetPageObjectCount(); ++sibling)
          if (source_holder->GetPageObjectByIndex(sibling)->GetContentMarks()->GetMarkedContentID() == mcid &&
              !selected.contains(sibling)) complete = false;
        if (!complete) {
          SetError("UNSUPPORTED_CAPABILITY", "Non-local ActualText cannot be partitioned across a group boundary.");
          return false;
        }
        whole_nonlocal_scopes.insert(mcid);
      }
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
    const int mcid = source->GetContentMarks()->GetMarkedContentID();
    if (whole_nonlocal_scopes.contains(mcid)) {
      clone->SetContentMarks(*source->GetContentMarks());
    } else if (mcid >= 0 && source->AsText() &&
               pdf_editor::tagged::ActualMark(source) &&
               pdf_editor::tagged::HasOtherMember(holder, mcid, source)) {
      pdf_editor::tagged::SetLocalActualText(clone.get(),
                                             pdf_editor::tagged::GlyphText(source->AsText()));
    }
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
  if (tagged_members) {
    const int key = pdf_editor::tagged::AllocateParentKey(native_document);
    form->GetMutableDict()->SetNewFor<CPDF_Number>("StructParents", key);
    pdf_editor::tagged::SetParentEntry(native_document, key, pdfium::MakeRetain<CPDF_Array>());
  }
  std::set<int> copied_whole_scopes;
  std::set<int> source_mcids;
  for (size_t index = 0; index < objects.size(); ++index) {
    auto* original = holder->GetPageObjectByIndex(indices[index]);
    auto* copy = objects[index].get();
    if (original->AsForm() && !pdf_editor::tagged::DuplicateFormTree(
            native_document, native_page, original->AsForm()->form(), copy->AsForm()->form())) {
      SetError("UNSUPPORTED_CAPABILITY", "A nested tagged Form could not be grouped.");
      return false;
    }
    const int mcid = original->GetContentMarks()->GetMarkedContentID();
    if (mcid >= 0) {
      source_mcids.insert(mcid);
      if (whole_nonlocal_scopes.contains(mcid)) {
        if (copied_whole_scopes.insert(mcid).second) {
          auto element = pdf_editor::tagged::ElementFor(native_document, holder, mcid);
          auto array = pdf_editor::tagged::ParentArray(native_document,
                                                        pdf_editor::tagged::ParentKey(form.get()));
          pdf_editor::tagged::SetParentAt(array.Get(), native_document, mcid, element.Get());
          pdf_editor::tagged::AddMcr(native_document, native_page, element.Get(), mcid, form.get());
        }
      } else if (!pdf_editor::tagged::DuplicateMcid(native_document, native_page,
                                                      holder, form.get(), original, copy)) {
        SetError("UNSUPPORTED_CAPABILITY", "A group's marked content could not be rebound.");
        return false;
      }
    }
    form->AppendPageObject(std::move(objects[index]));
  }
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
  if (tagged_members) {
    for (int mcid : source_mcids) {
      CPDF_PageObject* before = nullptr;
      CPDF_PageObject* after = nullptr;
      std::vector<CPDF_PageObject*> trailing;
      for (size_t index = 0; index < holder->GetPageObjectCount(); ++index) {
        auto* other = holder->GetPageObjectByIndex(index);
        if (other->GetContentMarks()->GetMarkedContentID() != mcid) continue;
        if (index < indices.front()) before = before ? before : other;
        else if (index > indices.front()) {
          after = after ? after : other;
          trailing.push_back(other);
        }
      }
      if (!before && !after) {
        pdf_editor::tagged::ClearMcid(native_document, holder, mcid,
            holder->IsPage() ? 0 : static_cast<CPDF_Form*>(holder)->GetStream()->GetObjNum());
        continue;
      }
      if (before && after) {
        CPDF_PageObject* first = nullptr;
        for (auto* trailing_object : trailing) {
          const bool rebound = first
              ? pdf_editor::tagged::ShareReboundMcid(trailing_object, mcid, first)
              : pdf_editor::tagged::DuplicateMcid(native_document, native_page,
                  holder, holder, trailing_object, trailing_object);
          if (!rebound) {
            SetError("UNSUPPORTED_CAPABILITY", "The remaining marked scope could not be split.");
            return false;
          }
          if (!first) first = trailing_object;
        }
      }
      if (!before) {
        auto element = pdf_editor::tagged::ElementFor(native_document, holder, mcid);
        auto* grouped_form = holder->GetPageObjectByIndex(indices.front())->AsForm()->form();
        pdf_editor::tagged::MoveFormMcrsBeforeOriginal(element.Get(), mcid,
            holder->IsPage() ? 0 : static_cast<CPDF_Form*>(holder)->GetStream()->GetObjNum(),
            grouped_form->GetStream()->GetObjNum());
      }
      for (auto* survivor : {before, after}) {
        if (survivor && survivor->AsText() && pdf_editor::tagged::ActualMark(survivor) &&
            !pdf_editor::tagged::RefreshAllTextScopes(holder, survivor,
                pdf_editor::tagged::GlyphText(survivor->AsText()))) {
          SetError("UNSUPPORTED_CAPABILITY", "The remaining ActualText could not be updated.");
          return false;
        }
      }
    }
  }
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
  auto* native_doc = CPDFDocumentFromFPDFDocument(pdf);
  auto* native_page = CPDFPageFromFPDFPage(page.get());
  auto* source_form = group->form();
  const int group_parent = pdf_editor::tagged::ParentKey(source_form);
  std::map<int, CPDF_PageObject*> first_member;
  std::map<int, int> moved_mcids;
  std::set<int> relocated;
  std::vector<std::unique_ptr<CPDF_PageObject>> objects;
  for (const auto& child : *source_form) {
    auto clone = CloneTopLevelObject(child.get());
    if (!clone) return false;
    if (child->AsForm() && !pdf_editor::tagged::DuplicateFormTree(native_doc, native_page,
        child->AsForm()->form(), clone->AsForm()->form())) {
      SetError("UNSUPPORTED_CAPABILITY", "A nested Form's structure cannot be ungrouped.");
      return false;
    }
    const int mcid = child->GetContentMarks()->GetMarkedContentID();
    if (mcid >= 0) {
      if (group_parent < 0) {
        SetError("UNSUPPORTED_CAPABILITY", "The tagged group's ParentTree entry is missing.");
        return false;
      }
      if (first_member.contains(mcid)) {
        if (!pdf_editor::tagged::ShareReboundMcid(clone.get(), mcid, first_member.at(mcid))) {
          SetError("UNSUPPORTED_CAPABILITY", "The tagged group's shared scope cannot be restored.");
          return false;
        }
      } else {
        if (!pdf_editor::tagged::DuplicateMcid(native_doc, native_page,
              source_form, holder, child.get(), clone.get())) {
          SetError("UNSUPPORTED_CAPABILITY", "The group's structure cannot be returned to its page.");
          return false;
        }
        first_member[mcid] = clone.get();
      }
      relocated.insert(mcid);
      moved_mcids[mcid] = clone->GetContentMarks()->GetMarkedContentID();
    }
    clone->Transform(placement);
    clone->TransformClipPath(placement);
    clone->SetContentStream(CPDF_PageObject::kNoContentStream);
    clone->SetDirty(true);
    objects.push_back(std::move(clone));
  }
  const size_t group_index = target.path.back();
  for (const auto& child : *source_form)
    if (child->AsForm()) pdf_editor::tagged::DropOwnedFormTags(native_doc, child->AsForm()->form());
  for (int mcid : relocated) {
    auto element = pdf_editor::tagged::ElementFor(native_doc, source_form, mcid);
    pdf_editor::tagged::MoveReplacementMcrBeforeForm(element.Get(), mcid,
        source_form->GetStream()->GetObjNum(), moved_mcids.at(mcid),
        holder->IsPage() ? 0 : static_cast<CPDF_Form*>(holder)->GetStream()->GetObjNum());
    pdf_editor::tagged::ClearMcid(native_doc, source_form, mcid,
                                   source_form->GetStream()->GetObjNum());
  }
  if (group_parent >= 0) pdf_editor::tagged::RemoveParentEntry(native_doc, group_parent);
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
