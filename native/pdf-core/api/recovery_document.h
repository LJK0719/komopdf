// Included inside the core's anonymous namespace after transaction helpers.
// Snapshots contain the existing immutable source/log, never the open password.

void WriteRecoveryIdentity(pdf_editor::RecoveryWriter& out,
                           const ObjectIdentity& identity) {
  out.String(identity.id);
  out.String(identity.text_block_id);
  out.Integer(identity.children.size());
  for (const auto& child : identity.children) WriteRecoveryIdentity(out, child);
}

ObjectIdentity ReadRecoveryIdentity(pdf_editor::RecoveryReader& in, size_t depth) {
  if (depth > kMaxObjectDepth) pdf_editor::RecoveryReader::Invalid();
  ObjectIdentity result;
  result.id = in.String();
  result.text_block_id = in.String();
  if (!ValidateId(result.id.c_str(), "Recovered object ID") ||
      (!result.text_block_id.empty() &&
       !ValidateId(result.text_block_id.c_str(), "Recovered block ID"))) {
    pdf_editor::RecoveryReader::Invalid();
  }
  const size_t count = in.Count();
  for (size_t index = 0; index < count; ++index)
    result.children.push_back(ReadRecoveryIdentity(in, depth + 1));
  return result;
}

void WriteRecoveryTransactions(pdf_editor::RecoveryWriter& out,
                                const std::vector<EditTransaction>& transactions) {
  out.Integer(transactions.size());
  for (const auto& transaction : transactions) {
    out.String(transaction.id);
    out.Integer(transaction.commands.size());
    for (const auto& command : transaction.commands) {
      out.Integer(static_cast<uint32_t>(command.type));
      out.String(command.page_id); out.String(command.target_id);
      out.String(command.resource_id); out.String(command.text);
      out.String(command.font_id);
      out.Integer(command.ids.size());
      for (const auto& id : command.ids) out.String(id);
      out.Integer(command.start_utf16); out.Integer(command.end_utf16);
      out.Integer(command.flags); out.Integer(command.resource_page_index);
      for (double value : command.values) out.Number(value);
    }
  }
}

std::vector<EditTransaction> ReadRecoveryTransactions(pdf_editor::RecoveryReader& in) {
  std::vector<EditTransaction> transactions;
  const size_t count = in.Count();
  for (size_t index = 0; index < count; ++index) {
    EditTransaction transaction;
    transaction.id = in.String();
    if (!ValidateId(transaction.id.c_str(), "Recovered transaction ID"))
      pdf_editor::RecoveryReader::Invalid();
    const size_t commands = in.Count();
    if (commands == 0 || commands > kMaxEditCount) pdf_editor::RecoveryReader::Invalid();
    for (size_t command_index = 0; command_index < commands; ++command_index) {
      EditCommand stored;
      PdeEditCommand raw{};
      raw.type = in.Uint32();
      stored.page_id = in.String(); stored.target_id = in.String();
      stored.resource_id = in.String(); stored.text = in.String();
      stored.font_id = in.String();
      const size_t ids = in.Count();
      if (ids > std::numeric_limits<uint32_t>::max()) pdf_editor::RecoveryReader::Invalid();
      for (size_t id = 0; id < ids; ++id) stored.ids.push_back(in.String());
      raw.start_utf16 = in.Uint32(); raw.end_utf16 = in.Uint32();
      raw.flags = in.Uint32(); raw.resource_page_index = in.Uint32();
      for (double& value : raw.values) value = in.Number();
      raw.page_id = stored.page_id.c_str(); raw.target_id = stored.target_id.c_str();
      raw.resource_id = stored.resource_id.c_str(); raw.text_utf8 = stored.text.c_str();
      raw.font_id = stored.font_id.c_str();
      std::vector<const char*> pointers;
      for (const auto& id : stored.ids) pointers.push_back(id.c_str());
      raw.ids = pointers.data(); raw.id_count = static_cast<uint32_t>(pointers.size());
      EditCommand command;
      if (!CopyEditCommand(raw, &command)) pdf_editor::RecoveryReader::Invalid();
      command.transaction_id = transaction.id;
      command.transaction_index = static_cast<uint32_t>(command_index);
      transaction.commands.push_back(std::move(command));
    }
    transactions.push_back(std::move(transaction));
  }
  return transactions;
}

void WriteRecoveryStrings(pdf_editor::RecoveryWriter& out,
                          const std::set<std::string>& values) {
  out.Integer(values.size());
  for (const auto& value : values) out.String(value);
}

std::set<std::string> ReadRecoveryStrings(pdf_editor::RecoveryReader& in) {
  std::set<std::string> values;
  const size_t count = in.Count();
  for (size_t index = 0; index < count; ++index) {
    std::string value = in.String();
    if (!ValidateId(value.c_str(), "Recovered ID") || !values.insert(value).second)
      pdf_editor::RecoveryReader::Invalid();
  }
  return values;
}

bool BuildRecoverySnapshot(Document* document, std::vector<uint8_t>* output) {
  if (!EnsureImmutableSourceBytes(document)) return false;
  pdf_editor::RecoveryWriter out;
  out.String("KOMOPDF-RECOVERY"); out.Integer(1); out.Integer(kAbiVersion);
  out.String(document->document_id); out.String(document->source_id);
  out.Integer(document->session_id);
  out.Integer(document->revision); out.Integer(document->saved_revision);
  out.Integer(document->undoable_count);
  out.Blob(document->memory_source);
  out.Integer(document->source_metadata.pages.size());
  for (const auto& page : document->source_metadata.pages) {
    out.String(page.id); out.Integer(page.objects.size());
    for (const auto& object : page.objects) WriteRecoveryIdentity(out, object);
  }
  WriteRecoveryTransactions(out, document->transactions);
  WriteRecoveryTransactions(out, document->redo_transactions);
  WriteRecoveryStrings(out, document->transaction_ids);
  WriteRecoveryStrings(out, document->reserved_ids);
  out.Integer(document->font_resources.size());
  for (const auto& [id, font] : document->font_resources) {
    out.String(id); out.Integer(font->face.index); out.Blob(font->original_bytes);
  }
  out.Integer(document->image_resources.size());
  for (const auto& [id, image] : document->image_resources) {
    out.String(id); out.Integer(image->width); out.Integer(image->height);
    out.Blob(image->rgba);
  }
  out.Integer(document->pdf_resources.size());
  for (const auto& [id, pdf] : document->pdf_resources) {
    out.String(id); out.Blob(pdf->bytes);
  }
  *output = std::move(out.bytes);
  return true;
}

std::string RecoverySnapshotInfo(const Document& document, const char* kind) {
  std::string result = "{\"docId\":";
  AppendJsonString(&result, document.document_id);
  result += ",\"revision\":" + std::to_string(document.revision);
  result += ",\"savedRevision\":" + std::to_string(document.saved_revision);
  result += ",\"kind\":";
  AppendJsonString(&result, kind);
  result += '}';
  return result;
}

uint32_t RestoreRecoverySnapshot(std::span<const uint8_t> bytes, const char* password) {
  try {
    pdf_editor::RecoveryReader in(bytes);
    if (in.String() != "KOMOPDF-RECOVERY" || in.Integer() != 1 ||
        in.Integer() != kAbiVersion) pdf_editor::RecoveryReader::Invalid();
    auto document = std::make_unique<Document>();
    document->document_id = in.String(); document->source_id = in.String();
    if (!ValidateId(document->document_id.c_str(), "Recovered document ID") ||
        !ValidateId(document->source_id.c_str(), "Recovered source ID")) return 0;
    if (DocumentIdIsOpen(document->document_id)) {
      SetError("INVALID_REQUEST", "This recovered document is already open.");
      return 0;
    }
    document->session_id = in.Integer();
    if (document->session_id == 0 || document->session_id == std::numeric_limits<uint64_t>::max())
      pdf_editor::RecoveryReader::Invalid();
    for (const auto& [handle, open] : g_documents) {
      if (open->session_id == document->session_id) {
        SetError("INVALID_REQUEST", "This recovery session conflicts with an open document.");
        return 0;
      }
    }
    document->revision = in.Uint32(); document->saved_revision = in.Uint32();
    document->undoable_count = static_cast<size_t>(in.Integer());
    if (document->saved_revision > document->revision || document->undoable_count > kUndoLimit)
      pdf_editor::RecoveryReader::Invalid();
    const auto source = in.Blob();
    if (source.empty()) pdf_editor::RecoveryReader::Invalid();
    document->memory_source.assign(source.begin(), source.end());
    document->source_size = static_cast<int64_t>(source.size());
    document->source_password = password ? password : "";
    document->pdf = FPDF_LoadMemDocument64(document->memory_source.data(),
        document->memory_source.size(), document->source_password.empty() ? nullptr : document->source_password.c_str());
    if (!document->pdf) { SetPdfOpenError(); return 0; }
    document->editing_allowed = EditingIsAllowed(document->pdf);
    const size_t pages = in.Count();
    if (pages != static_cast<size_t>(FPDF_GetPageCount(document->pdf)))
      pdf_editor::RecoveryReader::Invalid();
    for (size_t page_index = 0; page_index < pages; ++page_index) {
      PageIdentity page;
      page.id = in.String();
      if (!ValidateId(page.id.c_str(), "Recovered page ID")) pdf_editor::RecoveryReader::Invalid();
      const size_t objects = in.Count();
      for (size_t index = 0; index < objects; ++index)
        page.objects.push_back(ReadRecoveryIdentity(in, 0));
      document->source_metadata.pages.push_back(std::move(page));
    }
    document->transactions = ReadRecoveryTransactions(in);
    document->redo_transactions = ReadRecoveryTransactions(in);
    if (document->undoable_count > document->transactions.size())
      pdf_editor::RecoveryReader::Invalid();
    for (const auto* transactions : {&document->transactions, &document->redo_transactions}) {
      for (const auto& transaction : *transactions)
        if (!RequireTransactionAllowed(*document, transaction)) return 0;
    }
    document->transaction_ids = ReadRecoveryStrings(in);
    document->reserved_ids = ReadRecoveryStrings(in);
    for (const auto* transactions : {&document->transactions, &document->redo_transactions}) {
      for (const auto& transaction : *transactions) {
        if (!document->transaction_ids.contains(transaction.id)) pdf_editor::RecoveryReader::Invalid();
      }
    }
    const size_t fonts = in.Count();
    for (size_t index = 0; index < fonts; ++index) {
      auto font = std::make_shared<FontResource>();
      font->id = in.String();
      const uint32_t face_index = in.Uint32();
      const auto original = in.Blob();
      if (!ValidateId(font->id.c_str(), "Recovered font ID") || original.size() > kMaxFontBytes)
        pdf_editor::RecoveryReader::Invalid();
      pdf_editor::PreparedFontFace prepared;
      std::string error_code, error_message;
      if (!pdf_editor::PrepareFontFace(original, face_index, &prepared, &error_code, &error_message)) {
        SetError("INVALID_REQUEST", "A recovered font is invalid.");
        return 0;
      }
      font->face = prepared.info;
      font->original_bytes.assign(original.begin(), original.end());
      if (prepared.sfnt != font->original_bytes) font->extracted_sfnt = std::move(prepared.sfnt);
      const auto existing = g_fonts.find(font->id);
      if (existing != g_fonts.end() &&
          (existing->second->original_bytes != font->original_bytes || existing->second->face.index != face_index)) {
        SetError("INVALID_REQUEST", "A recovered font ID is already registered with different data.");
        return 0;
      }
      if (!document->font_resources.emplace(font->id, std::move(font)).second)
        pdf_editor::RecoveryReader::Invalid();
    }
    const size_t images = in.Count();
    for (size_t index = 0; index < images; ++index) {
      auto image = std::make_shared<ImageResource>();
      image->id = in.String(); image->width = in.Uint32(); image->height = in.Uint32();
      const auto rgba = in.Blob();
      if (!ValidateId(image->id.c_str(), "Recovered image ID") || !image->width || !image->height ||
          static_cast<uint64_t>(image->width) * image->height > rgba.size() / 4 ||
          static_cast<uint64_t>(image->width) * image->height * 4 != rgba.size())
        pdf_editor::RecoveryReader::Invalid();
      image->rgba.assign(rgba.begin(), rgba.end());
      if (!document->image_resources.emplace(image->id, std::move(image)).second)
        pdf_editor::RecoveryReader::Invalid();
    }
    const size_t pdfs = in.Count();
    for (size_t index = 0; index < pdfs; ++index) {
      auto resource = std::make_shared<PdfResource>();
      resource->id = in.String();
      const auto data = in.Blob();
      if (!ValidateId(resource->id.c_str(), "Recovered PDF resource ID")) pdf_editor::RecoveryReader::Invalid();
      resource->bytes.assign(data.begin(), data.end());
      ScopedDocument pdf(FPDF_LoadMemDocument64(resource->bytes.data(), resource->bytes.size(), nullptr));
      if (!pdf.get() || FPDF_GetPageCount(pdf.get()) <= 0) pdf_editor::RecoveryReader::Invalid();
      resource->page_count = static_cast<uint32_t>(FPDF_GetPageCount(pdf.get()));
      if (!document->pdf_resources.emplace(resource->id, std::move(resource)).second)
        pdf_editor::RecoveryReader::Invalid();
    }
    if (!in.Done()) pdf_editor::RecoveryReader::Invalid();
    FPDF_DOCUMENT rebuilt = nullptr;
    CandidateMetadata metadata;
    if (!RebuildCandidate(document.get(), document->transactions, document->font_resources,
                          &rebuilt, &metadata)) return 0;
    InstallCandidate(document.get(), rebuilt, std::move(metadata));
    const uint32_t handle = AllocateHandle();
    if (!handle) { SetError("RESOURCE_LIMIT", "No document handles are available."); return 0; }
    document->handle = handle;
    g_next_session_id = std::max(g_next_session_id, document->session_id + 1);
    for (const auto& [id, font] : document->font_resources) g_fonts.emplace(id, font);
    g_documents.emplace(handle, std::move(document));
    return handle;
  } catch (const std::runtime_error&) {
    SetError("INVALID_REQUEST", "Invalid or incompatible recovery snapshot.");
    return 0;
  }
}
