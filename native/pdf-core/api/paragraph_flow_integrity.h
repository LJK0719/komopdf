// A page/object operation may keep only part of a logical paragraph. Never
// retain a hidden full-text payload when its physical fragments are incomplete.
// Call on disposable import sources BEFORE importing resources, and on edited
// candidates after deletion. Complete, unique flows keep their shared metadata.

bool ReconcileParagraphFlows(FPDF_DOCUMENT pdf, CandidateMetadata* metadata = nullptr,
                             const std::vector<int>* selected_pages = nullptr) {
  struct Fragment {
    int page;
    RetainPtr<CPDF_Dictionary> info;
    int start;
    int end;
    std::string text;
  };
  struct Flow {
    RetainPtr<CPDF_Dictionary> info;
    std::vector<Fragment> fragments;
  };
  std::map<const CPDF_Dictionary*, Flow> flows;
  std::map<int, size_t> occurrences;
  if (selected_pages) for (int page : *selected_pages) ++occurrences[page];
  const auto collect = [&](auto&& self, FPDF_PAGEOBJECT object, int page, size_t depth) -> bool {
    if (depth > kMaxObjectDepth) { SetError("RESOURCE_LIMIT", "Paragraph nesting is too deep."); return false; }
    auto* native = CPDFPageObjectFromFPDFPageObject(object);
    if (!native || !native->IsActive() || !native->AsForm()) return true;
    auto info = native->AsForm()->form()->GetMutableDict()->GetMutableDictFor("KomoParagraph");
    if (info) {
      auto flow = info->GetMutableDictFor("Flow");
      if (!flow) return true;
      const auto text = info->GetUnicodeTextFor("Text").ToUTF8();
      auto& entry = flows[flow.Get()]; entry.info = flow;
      entry.fragments.push_back({page, info, info->GetIntegerFor("FlowStart"), info->GetIntegerFor("FlowEnd"),
                                 std::string(text.c_str(), text.GetLength())});
      return true;
    }
    for (int i = 0; i < FPDFFormObj_CountObjects(object); ++i)
      if (!self(self, FPDFFormObj_GetObject(object, i), page, depth + 1)) return false;
    return true;
  };
  for (int p = 0; p < FPDF_GetPageCount(pdf); ++p) {
    ScopedPage page(FPDF_LoadPage(pdf, p));
    if (!page.get()) { SetUnexpectedError(); return false; }
    for (int i = 0; i < FPDFPage_CountObjects(page.get()); ++i)
      if (!collect(collect, FPDFPage_GetObject(page.get(), i), p, 0)) return false;
  }
  for (auto& [key, flow] : flows) {
    const auto full = flow.info->GetUnicodeTextFor("Text").ToUTF8();
    const std::string text(full.c_str(), full.GetLength());
    LayoutText decoded;
    bool complete = DecodeLayoutText(text, &decoded);
    std::vector<const Fragment*> retained;
    for (const auto& fragment : flow.fragments) {
      const size_t count = selected_pages ? occurrences[fragment.page] : 1;
      if (count > 1) complete = false;
      if (count) retained.push_back(&fragment);
    }
    std::sort(retained.begin(), retained.end(), [](auto* a, auto* b) { return a->start < b->start; });
    size_t cursor = 0;
    for (const auto* fragment : retained) {
      if (!complete || fragment->start < 0 || fragment->end <= fragment->start ||
          static_cast<size_t>(fragment->start) != cursor ||
          static_cast<size_t>(fragment->end) >= decoded.byte_offsets.size() ||
          decoded.byte_offsets[fragment->start] == std::numeric_limits<size_t>::max() ||
          decoded.byte_offsets[fragment->end] == std::numeric_limits<size_t>::max() ||
          text.substr(decoded.byte_offsets[fragment->start],
                      decoded.byte_offsets[fragment->end] - decoded.byte_offsets[fragment->start]) != fragment->text) {
        complete = false; break;
      }
      cursor = static_cast<size_t>(fragment->end);
    }
    complete = complete && cursor == decoded.utf16.size() && !retained.empty();
    if (complete) continue;
    for (auto& fragment : flow.fragments) {
      fragment.info->RemoveFor("Flow");
      fragment.info->RemoveFor("FlowStart"); fragment.info->RemoveFor("FlowEnd");
      if (metadata) metadata->flow_changed_pages.insert(metadata->pages[fragment.page].id);
    }
    // PDF writers may serialize orphan indirect dictionaries. Erase the hidden
    // full-text payload too, not just the fragment's reference to that payload.
    flow.info->RemoveFor("Text"); flow.info->RemoveFor("StyleRuns");
  }
  return true;
}
