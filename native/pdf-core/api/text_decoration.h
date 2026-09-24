// Rebuild derived vector underlines from the current text objects. This keeps
// replace, split, transform, copy and delete on the same candidate transaction.
bool HolderHasUnderlines(CPDF_PageObjectHolder* holder, size_t depth = 0) {
  if (depth > kMaxObjectDepth) return false;
  for (const auto& object : *holder) {
    const auto handle = FPDFPageObjectFromCPDFPageObject(object.get());
    if (HasObjectMark(handle, "KomoUnderline") || HasObjectMark(handle, "KomoUnderlinePath"))
      return true;
    if (object->AsForm() && HolderHasUnderlines(object->AsForm()->form(), depth + 1)) return true;
  }
  return false;
}

bool RefreshUnderlineHolder(const Document& document, CPDF_PageObjectHolder* holder,
                            std::vector<ObjectIdentity>* identities) {
  if (holder->GetPageObjectCount() != identities->size()) { SetUnexpectedError(); return false; }
  for (size_t index = holder->GetPageObjectCount(); index > 0; --index) {
    auto* object = holder->GetPageObjectByIndex(index - 1);
    if (HasObjectMark(FPDFPageObjectFromCPDFPageObject(object), "KomoUnderlinePath")) {
      if (!holder->RemovePageObject(object)) { SetUnexpectedError(); return false; }
      identities->erase(identities->begin() + static_cast<std::ptrdiff_t>(index - 1));
    }
  }
  for (size_t index = holder->GetPageObjectCount(); index > 0; --index) {
    auto* object = holder->GetPageObjectByIndex(index - 1);
    auto* form = object->AsForm();
    if (form && HolderHasUnderlines(form->form())) {
      form->form()->DetachStreamForEditing();
      if (!RefreshUnderlineHolder(document, form->form(), &(*identities)[index - 1].children) ||
          !RewriteGroupMetadata(FPDFPageObjectFromCPDFPageObject(form), (*identities)[index - 1])) return false;
      CPDF_PageContentGenerator(form->form()).GenerateFormContentForEditing(form->form());
      form->CalcBoundingBox();
      form->SetDirty(true);
    }
    auto* text = object->AsText();
    const auto handle = FPDFPageObjectFromCPDFPageObject(object);
    if (!text || !HasObjectMark(handle, "KomoUnderline") ||
        FPDFTextObj_GetTextRenderMode(handle) == FPDF_TEXTRENDERMODE_INVISIBLE || text->CharCount() == 0) continue;
    const CFX_PointF advance = text->CalcPositionData(1);
    if (advance.y != 0) {
      SetError("UNSUPPORTED_CAPABILITY", "Vertical text underlining requires vertical decoration layout.");
      return false;
    }
    const float offset = -0.15f * text->GetFontSize();
    auto path_handle = FPDFPageObj_CreateNewPath(0, offset);
    if (!path_handle) { SetAllocationError(); return false; }
    std::unique_ptr<CPDF_PageObject> path(CPDFPageObjectFromFPDFPageObject(path_handle));
    CopyCommonObjectState(*text, path.get());
    // The decoration owns no ActualText or tagged-content identity.
    while (FPDFPageObj_CountMarks(path_handle) > 0)
      if (!FPDFPageObj_RemoveMark(path_handle, FPDFPageObj_GetMark(path_handle, 0))) return false;
    unsigned int red = 0, green = 0, blue = 0, alpha = 255;
    if (!FPDFPageObj_GetFillColor(handle, &red, &green, &blue, &alpha) ||
        !FPDFPath_LineTo(path_handle, advance.x, offset) ||
        !FPDFPageObj_SetStrokeColor(path_handle, red, green, blue, alpha) ||
        !FPDFPageObj_SetStrokeWidth(path_handle, std::max(0.5f, text->GetFontSize() * 0.05f)) ||
        !FPDFPath_SetDrawMode(path_handle, 0, 1) ||
        !FPDFPageObj_AddMark(path_handle, "KomoUnderlinePath")) {
      SetError("CORE_UNAVAILABLE", "The vector text underline could not be created.");
      return false;
    }
    path->AsPath()->SetPathMatrix(text->GetTextMatrix());
    path->SetContentStream(text->GetContentStream());
    path->SetDirty(true);
    ObjectIdentity identity;
    identity.id = GeneratedObjectId(document, (*identities)[index - 1].id + ":underline", 0);
    if (!holder->InsertPageObjectAtIndex(index, std::move(path))) { SetUnexpectedError(); return false; }
    identities->insert(identities->begin() + static_cast<std::ptrdiff_t>(index), std::move(identity));
  }
  return true;
}

bool RefreshPageUnderlines(const Document& document, FPDF_DOCUMENT pdf,
                           CandidateMetadata* metadata, const std::string& page_id) {
  const auto index = FindPageIndex(*metadata, page_id);
  if (!index) return true;
  ScopedPage page(FPDF_LoadPage(pdf, static_cast<int>(*index)));
  auto* native = CPDFPageFromFPDFPage(page.get());
  if (!native) { SetUnexpectedError(); return false; }
  if (!HolderHasUnderlines(native)) return true;
  if (!RefreshUnderlineHolder(document, native, &metadata->pages[*index].objects) ||
      !FPDFPage_GenerateContent(page.get())) {
    if (g_error_code.empty()) SetError("CORE_UNAVAILABLE", "Text decoration content could not be generated.");
    return false;
  }
  return true;
}
