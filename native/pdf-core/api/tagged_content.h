#ifndef PDF_EDITOR_TAGGED_CONTENT_H_
#define PDF_EDITOR_TAGGED_CONTENT_H_

#include <algorithm>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "core/fpdfapi/edit/cpdf_pagecontentgenerator.h"
#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_contentmarks.h"
#include "core/fpdfapi/page/cpdf_textobject.h"
#include "core/fpdfapi/page/cpdf_form.h"
#include "core/fpdfapi/page/cpdf_formobject.h"
#include "core/fpdfapi/page/cpdf_page.h"
#include "core/fpdfapi/page/cpdf_pageobject.h"
#include "core/fpdfapi/page/cpdf_pageobjectholder.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_null.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "page_structure.h"

namespace pdf_editor::tagged {

inline CPDF_Dictionary* StructureRoot(CPDF_Document* doc) {
  auto root = doc ? doc->GetMutableRoot() : nullptr;
  return root ? root->GetMutableDictFor("StructTreeRoot").Get() : nullptr;
}

inline CPDF_Dictionary* HolderDictionary(CPDF_PageObjectHolder* holder) {
  return holder->IsPage() ? static_cast<CPDF_Page*>(holder)->GetMutableDict().Get()
                          : static_cast<CPDF_Form*>(holder)->GetMutableDict().Get();
}

inline int ParentKey(CPDF_PageObjectHolder* holder) {
  return HolderDictionary(holder)->GetIntegerFor("StructParents", -1);
}

inline RetainPtr<CPDF_Array> ParentArray(CPDF_Document* doc, int key) {
  auto root = StructureRoot(doc);
  if (!root || key < 0) return nullptr;
  auto tree = root->GetDictFor("ParentTree");
  std::map<int, RetainPtr<const CPDF_Object>> entries;
  structure::CollectNumberTreeEntries(tree.Get(), &entries);
  auto found = entries.find(key);
  if (found == entries.end() || !found->second) return nullptr;
  const auto* array = found->second->AsArray();
  return array ? pdfium::WrapRetain(const_cast<CPDF_Array*>(array)) : nullptr;
}

inline std::map<int, RetainPtr<CPDF_Object>> ParentEntries(CPDF_Document* doc) {
  std::map<int, RetainPtr<const CPDF_Object>> entries;
  auto root = StructureRoot(doc);
  if (root) structure::CollectNumberTreeEntries(root->GetDictFor("ParentTree").Get(), &entries);
  std::map<int, RetainPtr<CPDF_Object>> result;
  for (const auto& [key, value] : entries)
    result[key] = pdfium::WrapRetain(const_cast<CPDF_Object*>(value.Get()));
  return result;
}

inline int AllocateParentKey(CPDF_Document* doc) {
  auto entries = ParentEntries(doc);
  const auto* root = StructureRoot(doc);
  return std::max(root ? root->GetIntegerFor("ParentTreeNextKey", 0) : 0,
                  entries.empty() ? 0 : entries.rbegin()->first + 1);
}

inline void SetParentEntry(CPDF_Document* doc, int key, RetainPtr<CPDF_Object> entry) {
  // RebuildParentTree clones direct values. Give new parent arrays their own
  // indirect identity so later MCID writes mutate the value actually in /Nums.
  if (!entry->GetObjNum()) doc->AddIndirectObject(entry);
  auto entries = ParentEntries(doc);
  entries[key] = std::move(entry);
  structure::RebuildParentTree(doc, StructureRoot(doc), entries);
}

inline void RemoveParentEntry(CPDF_Document* doc, int key) {
  auto entries = ParentEntries(doc);
  entries.erase(key);
  structure::RebuildParentTree(doc, StructureRoot(doc), entries);
}

// Mutate the parent's direct/indirect array, not a cloned ParentTree value.
inline void SetParentAt(CPDF_Array* array, CPDF_Document* doc, int mcid,
                        CPDF_Dictionary* element) {
  while (array->size() <= static_cast<size_t>(mcid)) array->AppendNew<CPDF_Null>();
  array->SetNewAt<CPDF_Reference>(mcid, doc, element->GetObjNum());
}

inline int NextMcid(CPDF_PageObjectHolder* holder, CPDF_Array* array) {
  int next = array ? static_cast<int>(array->size()) : 0;
  for (const auto& object : *holder) {
    const auto* marks = object->GetContentMarks();
    for (size_t i = 0; i < marks->CountItems(); ++i) {
      const auto param = marks->GetItem(i)->GetParam();
      if (param && param->KeyExist("MCID"))
        next = std::max(next, param->GetIntegerFor("MCID") + 1);
    }
  }
  return next;
}

inline bool RebindMcid(CPDF_PageObject* object, int old_mcid, int new_mcid) {
  const auto* previous = object->GetContentMarks();
  CPDF_ContentMarks rewritten;
  bool found = false;
  for (size_t i = 0; i < previous->CountItems(); ++i) {
    const auto* item = previous->GetItem(i);
    const auto params = item->GetParam();
    if (params && params->KeyExist("MCID") && params->GetIntegerFor("MCID") == old_mcid) {
      auto copy = ToDictionary(params->Clone());
      copy->SetNewFor<CPDF_Number>("MCID", new_mcid);
      rewritten.AddMarkWithDirectDict(item->GetName(), std::move(copy));
      found = true;
    } else if (params && item->GetParamType() == CPDF_ContentMarkItem::kDirectDict) {
      rewritten.AddMarkWithDirectDict(item->GetName(),
                                      pdfium::WrapRetain(const_cast<CPDF_Dictionary*>(params.Get())));
    } else if (!params) {
      rewritten.AddMark(item->GetName());
    } else {
      // Materialize named /Properties as direct dictionaries for this copy.
      rewritten.AddMarkWithDirectDict(item->GetName(), ToDictionary(params->Clone()));
    }
  }
  if (found) { object->SetContentMarks(rewritten); object->SetDirty(true); }
  return found;
}

inline bool ShareReboundMcid(CPDF_PageObject* copy, int old_mcid,
                             CPDF_PageObject* previous) {
  const auto* source = copy->GetContentMarks();
  const auto* old = previous->GetContentMarks();
  CPDF_ContentMarkItem* shared = nullptr;
  for (size_t i = 0; i < old->CountItems(); ++i) {
    const auto param = old->GetItem(i)->GetParam();
    if (param && param->KeyExist("MCID")) { shared = const_cast<CPDF_ContentMarkItem*>(old->GetItem(i)); break; }
  }
  if (!shared) return false;
  CPDF_ContentMarks mapped;
  bool replaced = false;
  for (size_t i = 0; i < source->CountItems(); ++i) {
    const auto* mark = source->GetItem(i);
    const auto param = mark->GetParam();
    if (param && param->KeyExist("MCID") && param->GetIntegerFor("MCID") == old_mcid) {
      mapped.AddExistingMark(pdfium::WrapRetain(shared));
      replaced = true;
    } else mapped.AddExistingMark(pdfium::WrapRetain(const_cast<CPDF_ContentMarkItem*>(mark)));
  }
  if (replaced) { copy->SetContentMarks(mapped); copy->SetDirty(true); }
  return replaced;
}

inline RetainPtr<CPDF_Dictionary> ElementFor(CPDF_Document* doc,
                                             CPDF_PageObjectHolder* holder,
                                             int mcid) {
  auto parents = ParentArray(doc, ParentKey(holder));
  return parents && mcid >= 0 && static_cast<size_t>(mcid) < parents->size()
             ? parents->GetMutableDictAt(mcid) : nullptr;
}

inline void AddMcr(CPDF_Document* doc, CPDF_Page* page, CPDF_Dictionary* element,
                   int mcid, CPDF_Form* form = nullptr) {
  auto mcr = pdfium::MakeRetain<CPDF_Dictionary>();
  mcr->SetNewFor<CPDF_Name>("Type", "MCR");
  mcr->SetNewFor<CPDF_Number>("MCID", mcid);
  mcr->SetNewFor<CPDF_Reference>("Pg", doc, page->GetDict()->GetObjNum());
  if (form) mcr->SetNewFor<CPDF_Reference>("Stm", doc, form->GetStream()->GetObjNum());
  auto previous = element->GetMutableObjectFor("K");
  if (!previous) { element->SetFor("K", mcr); return; }
  auto array = element->GetMutableArrayFor("K");
  if (!array) {
    array = pdfium::MakeRetain<CPDF_Array>();
    array->Append(previous->Clone());
    element->SetFor("K", array);
  }
  array->Append(std::move(mcr));
}

inline bool IsUnderlineDecoration(const CPDF_PageObject* object) {
  const auto* marks = object->GetContentMarks();
  for (size_t index = 0; index < marks->CountItems(); ++index)
    if (marks->GetItem(index)->GetName() == "KomoUnderlinePath") return true;
  return false;
}

inline bool HasOtherMember(CPDF_PageObjectHolder* holder, int mcid,
                           const CPDF_PageObject* excluded) {
  for (const auto& child : *holder)
    if (child.get() != excluded && !IsUnderlineDecoration(child.get()) &&
        child->GetContentMarks()->GetMarkedContentID() == mcid)
      return true;
  return false;
}

// Remove exactly the MCR for this content stream; never remove an unrelated
// marked sequence with the same MCID in another Form.
inline void RemoveMcr(CPDF_Dictionary* element, int mcid, uint32_t stream_num) {
  const auto matches = [=](const CPDF_Object* object) {
    if (!object) return false;
    if (object->IsNumber()) return stream_num == 0 && object->GetInteger() == mcid;
    const auto* dict = object->AsDictionary();
    if (!dict || dict->GetNameFor("Type") != "MCR" || dict->GetIntegerFor("MCID", -1) != mcid)
      return false;
    const auto stm = dict->GetObjectFor("Stm");
    const uint32_t target = stm && stm->IsReference() ? stm->AsReference()->GetRefObjNum() : 0;
    return target == stream_num;
  };
  auto k = element->GetMutableObjectFor("K");
  if (!k) return;
  if (auto array = element->GetMutableArrayFor("K")) {
    for (size_t i = 0; i < array->size(); ++i) {
      if (matches(array->GetDirectObjectAt(i).Get())) { array->RemoveAt(i); break; }
    }
    if (array->IsEmpty()) element->RemoveFor("K");
  } else if (matches(k->GetDirect().Get())) element->RemoveFor("K");
}

inline void MoveFormMcrsBeforeOriginal(CPDF_Dictionary* element, int original_mcid,
                                       uint32_t original_stream, uint32_t form_stream) {
  auto k = element->GetMutableArrayFor("K");
  if (!k) return;
  size_t at = k->size();
  for (size_t i = 0; i < k->size(); ++i) {
    const auto item = k->GetDirectObjectAt(i);
    const auto* dict = item ? item->AsDictionary() : nullptr;
    if ((original_stream == 0 && item && item->IsNumber() && item->GetInteger() == original_mcid) ||
        (dict && dict->GetNameFor("Type") == "MCR" &&
         dict->GetIntegerFor("MCID", -1) == original_mcid &&
         (dict->GetObjectFor("Stm") && dict->GetObjectFor("Stm")->IsReference()
              ? dict->GetObjectFor("Stm")->AsReference()->GetRefObjNum()
              : 0) == original_stream)) {
      at = i; break;
    }
  }
  if (at == k->size()) return;
  for (size_t i = at + 1; i < k->size();) {
    const auto item = k->GetDirectObjectAt(i);
    const auto* dict = item ? item->AsDictionary() : nullptr;
    const auto stm = dict ? dict->GetObjectFor("Stm") : nullptr;
    if (!dict || dict->GetNameFor("Type") != "MCR" || !stm || !stm->IsReference() ||
        stm->AsReference()->GetRefObjNum() != form_stream) { ++i; continue; }
    auto moved = k->GetObjectAt(i)->Clone();
    k->RemoveAt(i);
    k->InsertAt(at++, moved);
    ++i;
  }
}

inline void MoveReplacementMcrBeforeForm(CPDF_Dictionary* element,
                                         int form_mcid, uint32_t form_stream,
                                         int replacement_mcid, uint32_t replacement_stream) {
  auto k = element->GetMutableArrayFor("K");
  if (!k) return;
  size_t old_at = k->size(), new_at = k->size();
  for (size_t i = 0; i < k->size(); ++i) {
    const auto item = k->GetDirectObjectAt(i);
    const auto* dict = item ? item->AsDictionary() : nullptr;
    if (!dict || dict->GetNameFor("Type") != "MCR") continue;
    const auto stm = dict->GetObjectFor("Stm");
    const uint32_t stream = stm && stm->IsReference() ? stm->AsReference()->GetRefObjNum() : 0;
    if (dict->GetIntegerFor("MCID", -1) == form_mcid && stream == form_stream) old_at = i;
    if (dict->GetIntegerFor("MCID", -1) == replacement_mcid && stream == replacement_stream) new_at = i;
  }
  if (old_at >= k->size() || new_at >= k->size() || new_at < old_at) return;
  auto moved = k->GetObjectAt(new_at)->Clone();
  k->RemoveAt(new_at);
  k->InsertAt(old_at, moved);
}

inline void MovePageMcrBeforeOriginal(CPDF_Dictionary* element,
                                      int original_mcid, int inserted_mcid) {
  auto k = element->GetMutableArrayFor("K");
  if (!k) return;
  size_t original = k->size(), inserted = k->size();
  for (size_t i = 0; i < k->size(); ++i) {
    const auto item = k->GetDirectObjectAt(i);
    const auto* dict = item ? item->AsDictionary() : nullptr;
    const int id = item && item->IsNumber() ? item->GetInteger() :
        dict && dict->GetNameFor("Type") == "MCR" && !dict->GetObjectFor("Stm")
            ? dict->GetIntegerFor("MCID", -1) : -1;
    if (id == original_mcid) original = i;
    if (id == inserted_mcid) inserted = i;
  }
  if (original >= k->size() || inserted >= k->size() || inserted < original) return;
  auto moved = k->GetObjectAt(inserted)->Clone();
  k->RemoveAt(inserted);
  k->InsertAt(original, moved);
}

inline void ClearMcid(CPDF_Document* doc, CPDF_PageObjectHolder* holder,
                      int mcid, uint32_t stream_num = 0) {
  auto parents = ParentArray(doc, ParentKey(holder));
  if (!parents || mcid < 0 || static_cast<size_t>(mcid) >= parents->size()) return;
  auto element = parents->GetMutableDictAt(mcid);
  if (element) RemoveMcr(element.Get(), mcid, stream_num);
  parents->SetNewAt<CPDF_Null>(mcid);
}

inline bool DuplicateMcid(CPDF_Document* doc, CPDF_Page* page,
                          CPDF_PageObjectHolder* source_holder,
                          CPDF_PageObjectHolder* target_holder,
                          CPDF_PageObject* source, CPDF_PageObject* copy) {
  const int old_mcid = source->GetContentMarks()->GetMarkedContentID();
  if (old_mcid < 0) return true;
  auto element = ElementFor(doc, source_holder, old_mcid);
  if (!element || !element->GetObjNum() || ParentKey(target_holder) < 0) return false;
  auto parents = ParentArray(doc, ParentKey(target_holder));
  if (!parents) return false;
  const int new_mcid = NextMcid(target_holder, parents.Get());
  if (!RebindMcid(copy, old_mcid, new_mcid)) return false;
  SetParentAt(parents.Get(), doc, new_mcid, element.Get());
  auto* form = target_holder->IsPage() ? nullptr : static_cast<CPDF_Form*>(target_holder);
  AddMcr(doc, page, element.Get(), new_mcid, form);
  return true;
}

inline bool FormStreamUsedElsewhere(CPDF_Document* doc, CPDF_Page* page,
                                   uint32_t stream_num) {
  const auto active = [&](auto self, CPDF_PageObjectHolder* holder, size_t depth) -> bool {
    if (depth > 64) return true;
    for (const auto& object : *holder) {
      auto* form = object->AsForm();
      if (!form) continue;
      if (form->form()->GetStream()->GetObjNum() == stream_num ||
          self(self, form->form(), depth + 1)) return true;
    }
    return false;
  };
  if (active(active, page, 0)) return true;
  const int current = doc->GetPageIndex(page->GetDict()->GetObjNum());
  if (current < 0) return true;
  const auto resources_contain = [&](auto self, const CPDF_Dictionary* resources,
                                     std::set<uint32_t>* visited) -> bool {
    const auto xobjects = resources ? resources->GetDictFor("XObject") : nullptr;
    if (!xobjects) return false;
    CPDF_DictionaryLocker entries(xobjects.Get());
    for (const auto& [name, value] : entries) {
      const auto stream = xobjects->GetStreamFor(name.AsStringView());
      if (!stream || !visited->insert(stream->GetObjNum()).second) continue;
      if (stream->GetObjNum() == stream_num ||
          self(self, stream->GetDict()->GetDictFor("Resources").Get(), visited)) return true;
    }
    return false;
  };
  for (int index = 0; index < doc->GetPageCount(); ++index) {
    if (index == current) continue;
    auto page_dict = doc->GetPageDictionary(index);
    for (auto node = page_dict; node; node = node->GetDictFor("Parent")) {
      const auto resources = node->GetDictFor("Resources");
      if (resources) {
        std::set<uint32_t> visited;
        if (resources_contain(resources_contain, resources.Get(), &visited)) return true;
        break;
      }
    }
  }
  return false;
}

// An isolated Form is a new content stream. Its /StructParents and all /Stm
// MCRs must be rebound before editing the stream; other instances retain the
// original parent key and references.
inline bool IsolateFormParents(CPDF_Document* doc, CPDF_Page* page,
                               CPDF_Form* form, int old_parent_key,
                               uint32_t old_stream_num) {
  if (old_parent_key < 0) return true;
  auto old = ParentArray(doc, old_parent_key);
  if (!old || !form->GetStream()->GetObjNum()) return false;
  const int key = AllocateParentKey(doc);
  std::set<int> present;
  for (const auto& child : *form) {
    const int mcid = child->GetContentMarks()->GetMarkedContentID();
    if (mcid >= 0) present.insert(mcid);
  }
  auto mapped = pdfium::MakeRetain<CPDF_Array>();
  for (size_t i = 0; i < old->size(); ++i) {
    const auto element = old->GetDictAt(i);
    if (element && present.contains(static_cast<int>(i))) {
      mapped->AppendNew<CPDF_Reference>(doc, element->GetObjNum());
      AddMcr(doc, page, const_cast<CPDF_Dictionary*>(element.Get()),
             static_cast<int>(i), form);
    } else mapped->AppendNew<CPDF_Null>();
  }
  form->GetMutableDict()->SetNewFor<CPDF_Number>("StructParents", key);
  SetParentEntry(doc, key, mapped);
  if (old_stream_num && !FormStreamUsedElsewhere(doc, page, old_stream_num)) {
    for (int mcid : present) {
      if (static_cast<size_t>(mcid) < old->size()) {
        auto element = old->GetMutableDictAt(mcid);
        if (element) RemoveMcr(element.Get(), mcid, old_stream_num);
      }
    }
    RemoveParentEntry(doc, old_parent_key);
  }
  return true;
}

inline RetainPtr<CPDF_Array> EnsurePageParents(CPDF_Document* doc, CPDF_Page* page) {
  if (!StructureRoot(doc)) return nullptr;
  int key = ParentKey(page);
  if (key >= 0) return ParentArray(doc, key);
  key = AllocateParentKey(doc);
  page->GetMutableDict()->SetNewFor<CPDF_Number>("StructParents", key);
  auto array = pdfium::MakeRetain<CPDF_Array>();
  SetParentEntry(doc, key, array);
  return array;
}

inline bool TagNewParagraph(CPDF_Document* doc, CPDF_Page* page,
                            CPDF_PageObject* object, std::string_view text,
                            CPDF_Dictionary* existing_element = nullptr) {
  if (!StructureRoot(doc)) return true;
  auto parents = EnsurePageParents(doc, page);
  if (!parents) return false;
  const int mcid = NextMcid(page, parents.Get());
  CPDF_Dictionary* element = existing_element;
  if (!element) {
    auto catalog = doc->GetMutableRoot();
    if (!StructureRoot(doc)->GetObjNum())
      catalog->ConvertToIndirectObjectFor("StructTreeRoot", doc);
    auto root = StructureRoot(doc);
    auto created = doc->NewIndirect<CPDF_Dictionary>();
    created->SetNewFor<CPDF_Name>("Type", "StructElem");
    created->SetNewFor<CPDF_Name>("S", "P");
    created->SetNewFor<CPDF_Reference>("P", doc, root->GetObjNum());
    created->SetNewFor<CPDF_Reference>("Pg", doc, page->GetDict()->GetObjNum());
    auto k = root->GetMutableArrayFor("K");
    if (!k) {
      k = pdfium::MakeRetain<CPDF_Array>();
      if (auto prior = root->GetObjectFor("K")) k->Append(prior->Clone());
      root->SetFor("K", k);
    }
    k->AppendNew<CPDF_Reference>(doc, created->GetObjNum());
    element = created.Get();
  }
  auto params = pdfium::MakeRetain<CPDF_Dictionary>();
  params->SetNewFor<CPDF_Number>("MCID", mcid);
  const auto actual = WideString::FromUTF8(ByteStringView(text.data(), text.size()));
  params->SetNewFor<CPDF_String>("ActualText", actual.AsStringView());
  object->GetContentMarks()->AddMarkWithDirectDict("P", std::move(params));
  object->SetDirty(true);
  SetParentAt(parents.Get(), doc, mcid, element);
  AddMcr(doc, page, element, mcid);
  return true;
}

struct ParagraphLeafMerge {
  RetainPtr<CPDF_Dictionary> parent;
  RetainPtr<CPDF_Dictionary> target;
  std::vector<RetainPtr<CPDF_Dictionary>> removed;
  size_t first_k_index = 0;
  bool target_is_parent = false;
};

// A reflow of adjacent P/Span leaves is a semantic paragraph merge only when
// the source exhausts every leaf and all leaves are adjacent under one parent.
// Mixed table/list roles, attributed leaves and partially selected leaves need
// their own semantic mapping; never flatten them into an arbitrary /P.
inline std::optional<ParagraphLeafMerge> PrepareParagraphLeafMerge(
    CPDF_Document* doc, CPDF_Page* page, const std::vector<size_t>& positions) {
  const std::set<size_t> chosen(positions.begin(), positions.end());
  std::vector<RetainPtr<CPDF_Dictionary>> elements;
  std::map<CPDF_Dictionary*, std::set<int>> mcids;
  for (size_t index : positions) {
    const int mcid = page->GetPageObjectByIndex(index)->GetContentMarks()->GetMarkedContentID();
    if (mcid < 0) continue;
    auto element = ElementFor(doc, page, mcid);
    if (!element) return std::nullopt;
    if (!mcids.contains(element.Get())) elements.push_back(element);
    mcids[element.Get()].insert(mcid);
  }
  if (elements.size() < 2) return std::nullopt;
  auto parent = elements.front()->GetMutableDictFor("P");
  if (!parent || !parent->GetObjNum()) return std::nullopt;
  auto children = parent->GetMutableArrayFor("K");
  if (!children) return std::nullopt;
  std::vector<size_t> child_positions;
  for (const auto& element : elements) {
    if (element->GetDictFor("P").Get() != parent.Get() || !element->GetObjNum()) return std::nullopt;
    const auto role = element->GetNameFor("S");
    if (role != "P" && role != "Span") return std::nullopt;
    for (const auto& key : element->GetKeys())
      if (key != "Type" && key != "S" && key != "P" && key != "Pg" && key != "K")
        return std::nullopt;
    const auto pg = element->GetDictFor("Pg");
    if (pg && pg.Get() != page->GetDict().Get()) return std::nullopt;
    const auto k = element->GetDirectObjectFor("K");
    if (!k) return std::nullopt;
    std::set<int> linked;
    const auto inspect = [&](auto self, const CPDF_Object* source) -> bool {
      if (!source) return false;
      const auto direct = source->GetDirect();
      if (!direct) return false;
      if (const auto* array = direct->AsArray()) {
        for (size_t i = 0; i < array->size(); ++i)
          if (!self(self, array->GetObjectAt(i).Get())) return false;
        return true;
      }
      if (direct->IsNumber()) { linked.insert(direct->GetInteger()); return true; }
      const auto* mcr = direct->AsDictionary();
      if (!mcr || mcr->GetNameFor("Type") != "MCR" || mcr->GetObjectFor("Stm") ||
          (mcr->GetDictFor("Pg") && mcr->GetDictFor("Pg").Get() != page->GetDict().Get()))
        return false;
      linked.insert(mcr->GetIntegerFor("MCID", -1));
      return true;
    };
    if (!inspect(inspect, k.Get()) || linked != mcids[element.Get()]) return std::nullopt;
    for (size_t i = 0; i < page->GetPageObjectCount(); ++i)
      if (!chosen.contains(i) && mcids[element.Get()].contains(
              page->GetPageObjectByIndex(i)->GetContentMarks()->GetMarkedContentID()))
        return std::nullopt;
    size_t found = children->size();
    for (size_t i = 0; i < children->size(); ++i)
      if (children->GetDictAt(i).Get() == element.Get()) { found = i; break; }
    if (found == children->size()) return std::nullopt;
    child_positions.push_back(found);
  }
  for (size_t i = 1; i < child_positions.size(); ++i)
    if (child_positions[i] != child_positions[i - 1] + 1) return std::nullopt;
  ParagraphLeafMerge merge;
  merge.parent = parent;
  merge.target_is_parent = parent->GetNameFor("S") == "P" &&
      std::all_of(elements.begin(), elements.end(), [](const auto& item) {
        return item->GetNameFor("S") == "Span";
      });
  merge.target = merge.target_is_parent ? parent : elements.front();
  merge.first_k_index = child_positions.front();
  const size_t first_removed = merge.target_is_parent ? 0 : 1;
  for (size_t i = first_removed; i < elements.size(); ++i)
    merge.removed.push_back(elements[i]);
  return merge;
}

inline void FinishParagraphLeafMerge(CPDF_Document* doc,
                                     const ParagraphLeafMerge& merge,
                                     int new_mcid) {
  auto kids = merge.parent->GetMutableArrayFor("K");
  for (size_t i = 0; i < kids->size();) {
    const auto item = kids->GetDictAt(i);
    const bool removed = item && std::any_of(merge.removed.begin(), merge.removed.end(),
        [&](const auto& leaf) { return leaf.Get() == item.Get(); });
    if (removed) kids->RemoveAt(i);
    else ++i;
  }
  if (merge.target_is_parent) {
    // The parent already IS the /P; put its new MCR where its old Span kids sat.
    auto k = merge.target->GetMutableArrayFor("K");
    if (k) {
      for (size_t i = 0; i < k->size(); ++i) {
        const auto item = k->GetDictAt(i);
        if (!item || item->GetNameFor("Type") != "MCR" ||
            item->GetIntegerFor("MCID", -1) != new_mcid || item->GetObjectFor("Stm")) continue;
        const auto moved = k->GetObjectAt(i)->Clone();
        k->RemoveAt(i);
        k->InsertAt(std::min(merge.first_k_index, k->size()), moved);
        break;
      }
    }
  } else merge.target->SetNewFor<CPDF_Name>("S", "P");
  for (const auto& leaf : merge.removed) doc->DeleteIndirectObject(leaf->GetObjNum());
}

inline bool DuplicateFormTree(CPDF_Document* doc, CPDF_Page* page,                              CPDF_Form* source, CPDF_Form* copy, size_t depth = 0) {
  if (depth > 64 || source->GetPageObjectCount() != copy->GetPageObjectCount() ||
      source->GetDict()->KeyExist("StructParent")) return false;
  const int old_key = ParentKey(source);
  auto old_array = old_key >= 0 ? ParentArray(doc, old_key) : nullptr;
  if (old_key >= 0 && !old_array) return false;
  // Even a Form without its own MCIDs can contain tagged child Forms.
  copy->DetachStreamForEditing();
  RetainPtr<CPDF_Array> mapped;
  if (old_array) {
    mapped = pdfium::MakeRetain<CPDF_Array>();
    for (size_t i = 0; i < old_array->size(); ++i) mapped->AppendNew<CPDF_Null>();
    const int new_key = AllocateParentKey(doc);
    copy->GetMutableDict()->SetNewFor<CPDF_Number>("StructParents", new_key);
    SetParentEntry(doc, new_key, mapped);
  }
  std::set<int> referenced;
  for (size_t index = 0; index < source->GetPageObjectCount(); ++index) {
    auto* original = source->GetPageObjectByIndex(index);
    auto* cloned = copy->GetPageObjectByIndex(index);
    if (!original || !cloned) return false;
    const int mcid = original->GetContentMarks()->GetMarkedContentID();
    if (mcid >= 0) {
      auto element = ElementFor(doc, source, mcid);
      if (!mapped || !element || static_cast<size_t>(mcid) >= mapped->size()) return false;
      if (referenced.insert(mcid).second) {
        SetParentAt(mapped.Get(), doc, mcid, element.Get());
        AddMcr(doc, page, element.Get(), mcid, copy);
      }
    }
    if (auto* nested = original->AsForm()) {
      if (!cloned->AsForm() || !DuplicateFormTree(doc, page, nested->form(),
                                                    cloned->AsForm()->form(), depth + 1)) return false;
    }
  }
  CPDF_PageContentGenerator(copy).GenerateFormContentForEditing(copy);
  return true;
}

// Only call for a Form whose stream and parent key belong exclusively to the
// instance being removed (e.g. a Form created while grouping/duplicating).
inline void DropOwnedFormTags(CPDF_Document* doc, CPDF_Form* form) {
  for (const auto& child : *form)
    if (child->AsForm()) DropOwnedFormTags(doc, child->AsForm()->form());
  const int key = ParentKey(form);
  if (key < 0) return;
  std::set<int> mcids;
  for (const auto& child : *form) {
    const int id = child->GetContentMarks()->GetMarkedContentID();
    if (id >= 0) mcids.insert(id);
  }
  for (int id : mcids) ClearMcid(doc, form, id, form->GetStream()->GetObjNum());
  RemoveParentEntry(doc, key);
}

inline void SetLocalActualText(CPDF_PageObject* object, std::string_view updated) {
  const auto* source = object->GetContentMarks();
  CPDF_ContentMarks marks;
  const auto wide = WideString::FromUTF8(ByteStringView(updated.data(), updated.size()));
  for (size_t i = 0; i < source->CountItems(); ++i) {
    const auto* mark = source->GetItem(i);
    const auto param = mark->GetParam();
    if (!param) { marks.AddMark(mark->GetName()); continue; }
    auto copy = ToDictionary(param->Clone());
    if (copy->KeyExist("ActualText")) {
      copy->SetNewFor<CPDF_String>("ActualText", wide.AsStringView());
      marks.AddMarkWithDirectDict(mark->GetName(), std::move(copy));
    } else marks.AddMarkWithDirectDict(mark->GetName(), std::move(copy));
  }
  object->SetContentMarks(marks);
  object->SetDirty(true);
}

// A PDF marked-content scope can cover several PDFium text objects. In that
// case /ActualText belongs to the scope, not to any one glyph run.
inline const CPDF_ContentMarkItem* ActualMark(const CPDF_PageObject* object) {
  const auto* marks = object->GetContentMarks();
  for (size_t i = 0; i < marks->CountItems(); ++i) {
    const auto* mark = marks->GetItem(i);
    if (mark->GetParam() && mark->GetParam()->KeyExist("ActualText")) return mark;
  }
  return nullptr;
}

inline std::string GlyphText(const CPDF_TextObject* text) {
  if (!text || !text->GetFont()) return {};
  std::string result;
  for (uint32_t code : text->GetCharCodes()) {
    ByteString mapped = text->GetFont()->UnicodeFromCharCode(code).ToUTF8();
    if (mapped.IsEmpty()) return {};
    result.append(mapped.c_str(), mapped.GetLength());
  }
  return result;
}

inline std::string ScopeGlyphText(CPDF_PageObjectHolder* holder,
                                  const CPDF_ContentMarkItem* mark,
                                  size_t* members) {
  std::string text;
  *members = 0;
  for (const auto& child : *holder) {
    const auto* marks = child->GetContentMarks();
    if (!marks->ContainsItem(mark) || IsUnderlineDecoration(child.get())) continue;
    ++*members;
    const auto* run = child->AsText();
    if (!run) return {};
    const auto mapped = GlyphText(run);
    if (mapped.empty()) return {};
    text += mapped;
  }
  return text;
}

inline bool CanEditTextScope(CPDF_PageObjectHolder* holder,
                             const CPDF_PageObject* object) {
  const auto* marks = object->GetContentMarks();
  for (size_t i = 0; i < marks->CountItems(); ++i) {
    const auto* mark = marks->GetItem(i);
    if (!mark->GetParam() || !mark->GetParam()->KeyExist("ActualText")) continue;
    size_t members = 0;
    const auto glyphs = ScopeGlyphText(holder, mark, &members);
    if (members <= 1) continue;
    const ByteString actual = mark->GetParam()->GetUnicodeTextFor("ActualText").ToUTF8();
    if (glyphs.empty() || glyphs != std::string(actual.c_str(), actual.GetLength())) return false;
  }
  return true;
}

inline bool RefreshTextScope(CPDF_PageObjectHolder* holder,
                             CPDF_PageObject* object,
                             std::string_view new_single_text,
                             const CPDF_ContentMarkItem* mark = nullptr) {
  if (!mark) mark = ActualMark(object);
  if (!mark) return true;
  size_t members = 0;
  const auto glyphs = ScopeGlyphText(holder, mark, &members);
  const std::string_view updated = members > 1 ? std::string_view(glyphs) : new_single_text;
  if (updated.empty()) return false;
  const auto wide = WideString::FromUTF8(ByteStringView(updated.data(), updated.size()));
  auto params = ToDictionary(mark->GetParam()->Clone());
  params->SetNewFor<CPDF_String>("ActualText", wide.AsStringView());
  CPDF_ContentMarks one;
  one.AddMarkWithDirectDict(mark->GetName(), std::move(params));
  auto replacement = pdfium::WrapRetain(one.GetItem(0));
  // Replace the lexical mark on *every* member with one shared direct mark.
  // This also detaches named /Properties and other instances of that resource.
  for (const auto& child : *holder) {
    const auto* source = child->GetContentMarks();
    if (!source->ContainsItem(mark)) continue;
    CPDF_ContentMarks rebuilt;
    for (size_t i = 0; i < source->CountItems(); ++i) {
      auto* current = const_cast<CPDF_ContentMarkItem*>(source->GetItem(i));
      rebuilt.AddExistingMark(current == mark ? replacement : pdfium::WrapRetain(current));
    }
    child->SetContentMarks(rebuilt);
    child->SetDirty(true);
  }
  return true;
}

inline bool RefreshAllTextScopes(CPDF_PageObjectHolder* holder,
                                 CPDF_PageObject* object,
                                 std::string_view new_single_text) {
  for (size_t i = 0; i < object->GetContentMarks()->CountItems(); ++i) {
    const auto* mark = object->GetContentMarks()->GetItem(i);
    if (mark->GetParam() && mark->GetParam()->KeyExist("ActualText") &&
        !RefreshTextScope(holder, object, new_single_text, mark)) return false;
  }
  return true;
}

}  // namespace pdf_editor::tagged
#endif  // PDF_EDITOR_TAGGED_CONTENT_H_
