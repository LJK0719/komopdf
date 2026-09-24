#ifndef PDF_EDITOR_PAGE_STRUCTURE_H_
#define PDF_EDITOR_PAGE_STRUCTURE_H_

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_boolean.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_null.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_object.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_stream_acc.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfdoc/cpdf_dest.h"
#include "core/fpdfdoc/cpdf_formfield.h"
#include "core/fpdfdoc/cpdf_nametree.h"
#include "core/fpdfdoc/cpdf_numbertree.h"
#include "core/fxcrt/retain_ptr.h"
#include "core/fxcrt/span.h"
#include "public/fpdf_doc.h"
#include "public/fpdfview.h"

namespace pdf_editor::structure {

// -----------------------------------------------------------------------------
// NumberTree Utilities
// -----------------------------------------------------------------------------

inline void CollectNumberTreeEntries(
    const CPDF_Dictionary* node,
    std::map<int, RetainPtr<const CPDF_Object>>* entries) {
  if (!node || !entries) return;
  RetainPtr<const CPDF_Array> nums = node->GetArrayFor("Nums");
  if (nums) {
    for (size_t i = 0; i + 1 < nums->size(); i += 2) {
      int k = nums->GetIntegerAt(i);
      RetainPtr<const CPDF_Object> v = nums->GetDirectObjectAt(i + 1);
      if (v) (*entries)[k] = std::move(v);
    }
    return;
  }
  RetainPtr<const CPDF_Array> kids = node->GetArrayFor("Kids");
  if (kids) {
    for (size_t i = 0; i < kids->size(); ++i) {
      RetainPtr<const CPDF_Dictionary> kid_dict = kids->GetDictAt(i);
      if (kid_dict) CollectNumberTreeEntries(kid_dict.Get(), entries);
    }
  }
}

inline void RebuildParentTree(
    CPDF_Document* doc,
    CPDF_Dictionary* struct_tree_root,
    const std::map<int, RetainPtr<CPDF_Object>>& entries) {
  if (!doc || !struct_tree_root) return;
  if (entries.empty()) {
    struct_tree_root->RemoveFor("ParentTree");
    return;
  }
  auto parent_tree_dict = doc->NewIndirect<CPDF_Dictionary>();
  auto nums_array = doc->NewIndirect<CPDF_Array>();
  for (const auto& [k, v] : entries) {
    if (!v) continue;
    nums_array->AppendNew<CPDF_Number>(k);
    if (v->IsReference()) {
      nums_array->Append(v->Clone());
    } else if (v->GetObjNum() != 0) {
      nums_array->AppendNew<CPDF_Reference>(doc, v->GetObjNum());
    } else {
      nums_array->Append(v->Clone());
    }
  }
  parent_tree_dict->SetNewFor<CPDF_Reference>("Nums", doc, nums_array->GetObjNum());
  auto limits = parent_tree_dict->SetNewFor<CPDF_Array>("Limits");
  limits->AppendNew<CPDF_Number>(entries.begin()->first);
  limits->AppendNew<CPDF_Number>(entries.rbegin()->first);
  struct_tree_root->SetNewFor<CPDF_Reference>("ParentTree", doc, parent_tree_dict->GetObjNum());
  struct_tree_root->SetNewFor<CPDF_Number>("ParentTreeNextKey", entries.rbegin()->first + 1);
  doc->GetMutableRoot()->GetOrCreateDictFor("MarkInfo")->SetNewFor<CPDF_Boolean>("Marked", true);
}

// -----------------------------------------------------------------------------
// Unified Cross-Document Object Mapping
// -----------------------------------------------------------------------------

class CrossDocObjectMapping {
 public:
  CrossDocObjectMapping(CPDF_Document* dest_doc, CPDF_Document* src_doc)
      : dest_doc_(dest_doc), src_doc_(src_doc) {}

  void MapPage(uint32_t src_page_obj_num, uint32_t dest_page_obj_num) {
    if (src_page_obj_num != 0 && dest_page_obj_num != 0) {
      obj_map_[src_page_obj_num] = dest_page_obj_num;
    }
  }

  void MarkUnselectedSrcPage(uint32_t src_page_obj_num) {
    if (src_page_obj_num != 0) {
      unselected_src_pages_.insert(src_page_obj_num);
    }
  }

  void MarkUnselectedSourcePages(const std::vector<int>& selected_src_indices) {
    std::set<int> selected(selected_src_indices.begin(), selected_src_indices.end());
    const int total = src_doc_->GetPageCount();
    for (int p = 0; p < total; ++p) {
      if (!selected.contains(p)) {
        auto page = src_doc_->GetPageDictionary(p);
        if (page && page->GetObjNum() != 0) {
          unselected_src_pages_.insert(page->GetObjNum());
        }
      }
    }
  }

  bool HasMapping(uint32_t src_obj_num) const {
    return obj_map_.contains(src_obj_num);
  }

  uint32_t GetMappedObjNum(uint32_t src_obj_num) const {
    auto it = obj_map_.find(src_obj_num);
    return it != obj_map_.end() ? it->second : 0;
  }

  void AddMapping(uint32_t src_obj_num, uint32_t dest_obj_num) {
    if (src_obj_num != 0 && dest_obj_num != 0) {
      obj_map_[src_obj_num] = dest_obj_num;
    }
  }

  RetainPtr<CPDF_Object> CloneAndMapObject(RetainPtr<const CPDF_Object> src_obj) {
    if (!src_obj) return nullptr;

    // 1. CPDF_Reference handling
    if (src_obj->IsReference()) {
      uint32_t ref_target = src_obj->AsReference()->GetRefObjNum();
      if (ref_target == 0) return nullptr;
      if (unselected_src_pages_.contains(ref_target)) return nullptr;

      auto it = obj_map_.find(ref_target);
      if (it != obj_map_.end()) {
        return pdfium::MakeRetain<CPDF_Reference>(dest_doc_, it->second);
      }

      RetainPtr<const CPDF_Object> direct = src_obj->AsReference()->GetDirect();
      if (!direct) return nullptr;
      if (direct->IsDictionary() && direct->AsDictionary()->GetNameFor("Type") == "Page") {
        unselected_src_pages_.insert(ref_target);
        return nullptr;
      }
      return CloneAndMapObject(direct);
    }

    uint32_t src_num = src_obj->GetObjNum();

    // 2. Indirect CPDF_Object handling (GetObjNum() != 0)
    if (src_num != 0) {
      if (unselected_src_pages_.contains(src_num)) return nullptr;

      auto it = obj_map_.find(src_num);
      if (it != obj_map_.end()) {
        return pdfium::MakeRetain<CPDF_Reference>(dest_doc_, it->second);
      }

      if (src_obj->IsDictionary()) {
        const auto* src_dict = src_obj->AsDictionary();
        if (src_dict->GetNameFor("Type") == "Page") {
          unselected_src_pages_.insert(src_num);
          return nullptr;
        }
        auto new_dict = dest_doc_->NewIndirect<CPDF_Dictionary>();
        uint32_t new_num = new_dict->GetObjNum();
        obj_map_[src_num] = new_num;
        CopyDictionaryEntries(src_dict, new_dict.Get());
        return pdfium::MakeRetain<CPDF_Reference>(dest_doc_, new_num);
      }
      if (src_obj->IsArray()) {
        auto new_arr = dest_doc_->NewIndirect<CPDF_Array>();
        uint32_t new_num = new_arr->GetObjNum();
        obj_map_[src_num] = new_num;
        CopyArrayElements(src_obj->AsArray(), new_arr.Get());
        return pdfium::MakeRetain<CPDF_Reference>(dest_doc_, new_num);
      }
      if (src_obj->IsStream()) {
        const CPDF_Stream* src_stream = src_obj->AsStream();
        auto acc = pdfium::MakeRetain<CPDF_StreamAcc>(pdfium::WrapRetain(src_stream));
        acc->LoadAllDataRaw();
        pdfium::span<const uint8_t> span = acc->GetSpan();
        auto new_stream = pdfium::MakeRetain<CPDF_Stream>(span);
        uint32_t new_num = dest_doc_->AddIndirectObject(new_stream);
        obj_map_[src_num] = new_num;
        if (src_stream->GetDict()) {
          CopyDictionaryEntries(src_stream->GetDict(), new_stream->GetMutableDict().Get());
        }
        return pdfium::MakeRetain<CPDF_Reference>(dest_doc_, new_num);
      }

      auto cloned = src_obj->Clone();
      uint32_t new_num = dest_doc_->AddIndirectObject(cloned);
      obj_map_[src_num] = new_num;
      return pdfium::MakeRetain<CPDF_Reference>(dest_doc_, new_num);
    }

    // 3. Inline direct object handling (src_num == 0)
    if (src_obj->IsDictionary()) {
      auto new_dict = pdfium::MakeRetain<CPDF_Dictionary>();
      CopyDictionaryEntries(src_obj->AsDictionary(), new_dict.Get());
      return new_dict;
    }
    if (src_obj->IsArray()) {
      auto new_arr = pdfium::MakeRetain<CPDF_Array>();
      CopyArrayElements(src_obj->AsArray(), new_arr.Get());
      return new_arr;
    }
    if (src_obj->IsStream()) {
      const CPDF_Stream* src_stream = src_obj->AsStream();
      auto acc = pdfium::MakeRetain<CPDF_StreamAcc>(pdfium::WrapRetain(src_stream));
      acc->LoadAllDataRaw();
      pdfium::span<const uint8_t> span = acc->GetSpan();
      auto new_stream = pdfium::MakeRetain<CPDF_Stream>(span);
      if (src_stream->GetDict()) {
        CopyDictionaryEntries(src_stream->GetDict(), new_stream->GetMutableDict().Get());
      }
      return new_stream;
    }

    return src_obj->Clone();
  }

  void CopyDictionaryEntries(const CPDF_Dictionary* src_dict, CPDF_Dictionary* dest_dict) {
    if (!src_dict || !dest_dict) return;
    CPDF_DictionaryLocker locker(src_dict);
    for (const auto& it : locker) {
      const ByteString& key = it.first;
      RetainPtr<const CPDF_Object> val = it.second;
      RetainPtr<CPDF_Object> mapped_val = CloneAndMapObject(val);
      if (mapped_val) {
        dest_dict->SetFor(key, mapped_val);
      }
    }
  }

  void CopyArrayElements(const CPDF_Array* src_arr, CPDF_Array* dest_arr) {
    if (!src_arr || !dest_arr) return;
    for (size_t i = 0; i < src_arr->size(); ++i) {
      RetainPtr<const CPDF_Object> elem = src_arr->GetObjectAt(i);
      RetainPtr<CPDF_Object> mapped_elem = CloneAndMapObject(elem);
      if (mapped_elem) {
        dest_arr->Append(mapped_elem);
      }
    }
  }

  CPDF_Document* dest_doc() const { return dest_doc_; }
  CPDF_Document* src_doc() const { return src_doc_; }

 private:
  CPDF_Document* dest_doc_ = nullptr;
  CPDF_Document* src_doc_ = nullptr;
  std::map<uint32_t, uint32_t> obj_map_;
  std::set<uint32_t> unselected_src_pages_;
};

// Pair objects already copied by PDFium's page exporter (Annots, Resources, Streams)
inline void PairImportedObjects(
    const CPDF_Object* src_obj,
    const CPDF_Object* dest_obj,
    CrossDocObjectMapping* mapper,
    std::set<std::pair<const CPDF_Object*, const CPDF_Object*>>* visited) {
  if (!src_obj || !dest_obj || !mapper || !visited) return;
  if (!visited->insert({src_obj, dest_obj}).second) return;

  uint32_t s_num = src_obj->GetObjNum();
  uint32_t d_num = dest_obj->GetObjNum();
  if (s_num != 0 && d_num != 0) {
    mapper->AddMapping(s_num, d_num);
  }

  if (src_obj->IsReference() && dest_obj->IsReference()) {
    uint32_t ref_s = src_obj->AsReference()->GetRefObjNum();
    uint32_t ref_d = dest_obj->AsReference()->GetRefObjNum();
    if (ref_s != 0 && ref_d != 0) {
      mapper->AddMapping(ref_s, ref_d);
    }
    PairImportedObjects(src_obj->AsReference()->GetDirect().Get(),
                        dest_obj->AsReference()->GetDirect().Get(),
                        mapper, visited);
    return;
  }

  if (src_obj->IsDictionary() && dest_obj->IsDictionary()) {
    const auto* s_dict = src_obj->AsDictionary();
    const auto* d_dict = dest_obj->AsDictionary();
    CPDF_DictionaryLocker locker(s_dict);
    for (const auto& it : locker) {
      const ByteString& key = it.first;
      if (key == "Parent" || key == "P" || key == "Dest" || key == "A") continue;
      RetainPtr<const CPDF_Object> s_val = it.second;
      RetainPtr<const CPDF_Object> d_val = d_dict->GetObjectFor(key.AsStringView());
      if (s_val && d_val) {
        PairImportedObjects(s_val.Get(), d_val.Get(), mapper, visited);
      }
    }
    return;
  }

  if (src_obj->IsStream() && dest_obj->IsStream()) {
    PairImportedObjects(src_obj->AsStream()->GetDict(), dest_obj->AsStream()->GetDict(), mapper, visited);
    return;
  }

  if (src_obj->IsArray() && dest_obj->IsArray()) {
    const auto* s_arr = src_obj->AsArray();
    const auto* d_arr = dest_obj->AsArray();
    size_t count = std::min(s_arr->size(), d_arr->size());
    for (size_t i = 0; i < count; ++i) {
      PairImportedObjects(s_arr->GetObjectAt(i).Get(),
                          d_arr->GetObjectAt(i).Get(),
                          mapper, visited);
    }
    return;
  }
}

// -----------------------------------------------------------------------------
// Destination Resolution Helpers (Preserves full /XYZ /Fit* parameters)
// -----------------------------------------------------------------------------

inline RetainPtr<const CPDF_Array> ResolveDestArray(CPDF_Document* doc, const CPDF_Object* dest_obj) {
  if (!doc || !dest_obj) return nullptr;
  if (dest_obj->IsReference()) {
    dest_obj = dest_obj->GetDirect();
    if (!dest_obj) return nullptr;
  }
  if (dest_obj->IsArray()) return ToArray(pdfium::WrapRetain(dest_obj));
  if (dest_obj->IsString() || dest_obj->IsName()) {
    ByteString name = dest_obj->GetString();
    RetainPtr<const CPDF_Array> named = CPDF_NameTree::LookupNamedDest(const_cast<CPDF_Document*>(doc), name);
    if (named) return named;
    const auto* root = doc->GetRoot();
    if (root) {
      RetainPtr<const CPDF_Dictionary> dests_dict = root->GetDictFor("Dests");
      if (dests_dict) {
        RetainPtr<const CPDF_Object> entry = dests_dict->GetObjectFor(name.AsStringView());
        if (entry) {
          if (entry->IsArray()) return ToArray(entry);
          if (entry->IsDictionary()) return entry->AsDictionary()->GetArrayFor("D");
        }
      }
    }
  }
  if (dest_obj->IsDictionary()) {
    return dest_obj->AsDictionary()->GetArrayFor("D");
  }
  return nullptr;
}

inline int ResolveDestTargetPageIndex(CPDF_Document* doc, const CPDF_Object* dest_obj) {
  RetainPtr<const CPDF_Array> arr = ResolveDestArray(doc, dest_obj);
  if (!arr || arr->IsEmpty()) return -1;
  RetainPtr<const CPDF_Object> first = arr->GetDirectObjectAt(0);
  if (!first) return -1;
  if (first->IsNumber()) return first->GetInteger();
  if (first->IsDictionary()) return doc->GetPageIndex(first->GetObjNum());
  return -1;
}

inline int ResolveAnnotDestTargetPageIndex(CPDF_Document* doc, const CPDF_Dictionary* annot) {
  if (!doc || !annot) return -1;
  RetainPtr<const CPDF_Object> dest = annot->GetObjectFor("Dest");
  if (dest) {
    int idx = ResolveDestTargetPageIndex(doc, dest.Get());
    if (idx >= 0) return idx;
  }
  RetainPtr<const CPDF_Dictionary> action = annot->GetDictFor("A");
  if (action && action->GetNameFor("S") == "GoTo") {
    RetainPtr<const CPDF_Object> d = action->GetObjectFor("D");
    if (d) return ResolveDestTargetPageIndex(doc, d.Get());
  }
  return -1;
}

inline int ResolveBookmarkDestTargetPageIndex(CPDF_Document* doc, const CPDF_Dictionary* bookmark) {
  if (!doc || !bookmark) return -1;
  RetainPtr<const CPDF_Object> dest = bookmark->GetObjectFor("Dest");
  if (dest) {
    int idx = ResolveDestTargetPageIndex(doc, dest.Get());
    if (idx >= 0) return idx;
  }
  RetainPtr<const CPDF_Dictionary> action = bookmark->GetDictFor("A");
  if (action && action->GetNameFor("S") == "GoTo") {
    RetainPtr<const CPDF_Object> d = action->GetObjectFor("D");
    if (d) return ResolveDestTargetPageIndex(doc, d.Get());
  }
  return -1;
}

inline RetainPtr<CPDF_Array> CloneDestinationArrayWithRemappedPage(
    CPDF_Document* dest_doc,
    const CPDF_Array* src_dest_arr,
    uint32_t dest_page_obj_num) {
  if (!dest_doc || !src_dest_arr || src_dest_arr->IsEmpty()) return nullptr;
  auto new_dest_arr = pdfium::MakeRetain<CPDF_Array>();
  new_dest_arr->AppendNew<CPDF_Reference>(dest_doc, dest_page_obj_num);
  for (size_t i = 1; i < src_dest_arr->size(); ++i) {
    RetainPtr<const CPDF_Object> param = src_dest_arr->GetObjectAt(i);
    if (param) new_dest_arr->Append(param->Clone());
  }
  return new_dest_arr;
}

inline bool RemapDestArrayFirstElement(CPDF_Document* target_doc, CPDF_Array* dest_array, uint32_t target_page_obj_num) {
  if (!target_doc || !dest_array || dest_array->IsEmpty()) return false;
  dest_array->SetNewAt<CPDF_Reference>(0, target_doc, target_page_obj_num);
  return true;
}

inline bool RemapAnnotDest(CPDF_Document* target_doc, CPDF_Dictionary* annot, uint32_t target_page_obj_num) {
  if (!target_doc || !annot) return false;
  RetainPtr<CPDF_Array> dest_array = annot->GetMutableArrayFor("Dest");
  if (dest_array) {
    return RemapDestArrayFirstElement(target_doc, dest_array.Get(), target_page_obj_num);
  }
  RetainPtr<CPDF_Dictionary> action = annot->GetMutableDictFor("A");
  if (action && action->GetNameFor("S") == "GoTo") {
    RetainPtr<CPDF_Array> d_arr = action->GetMutableArrayFor("D");
    if (d_arr) {
      return RemapDestArrayFirstElement(target_doc, d_arr.Get(), target_page_obj_num);
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Deletion Helpers (Links, Outlines, Widgets, Tagged StructTree)
// -----------------------------------------------------------------------------

inline void PruneSurvivingLinksTargetingDeletedPages(
    CPDF_Document* doc,
    size_t total_page_count,
    const std::set<size_t>& deleted_indices) {
  if (!doc) return;
  for (size_t p = 0; p < total_page_count; ++p) {
    if (deleted_indices.contains(p)) continue;
    auto page = doc->GetMutablePageDictionary(static_cast<int>(p));
    if (!page) continue;
    auto annots = page->GetMutableArrayFor("Annots");
    if (!annots) continue;
    for (size_t i = 0; i < annots->size(); ) {
      auto annot = annots->GetMutableDictAt(i);
      if (!annot || annot->GetNameFor("Subtype") != "Link") {
        ++i;
        continue;
      }
      int target_idx = ResolveAnnotDestTargetPageIndex(doc, annot.Get());
      if (target_idx >= 0 && deleted_indices.contains(static_cast<size_t>(target_idx))) {
        annot->RemoveFor("Dest");
        annot->RemoveFor("A");
        annots->RemoveAt(i);
      } else {
        ++i;
      }
    }
  }
}

inline bool PruneBookmarkNode(
    CPDF_Document* doc,
    CPDF_Dictionary* bookmark,
    const std::set<size_t>& deleted_indices) {
  if (!doc || !bookmark) return false;
  int target_idx = ResolveBookmarkDestTargetPageIndex(doc, bookmark);
  bool targets_deleted = (target_idx >= 0 && deleted_indices.contains(static_cast<size_t>(target_idx)));

  RetainPtr<CPDF_Dictionary> cur_child = bookmark->GetMutableDictFor("First");
  std::vector<RetainPtr<CPDF_Dictionary>> surviving_children;
  while (cur_child) {
    RetainPtr<CPDF_Dictionary> next = cur_child->GetMutableDictFor("Next");
    if (PruneBookmarkNode(doc, cur_child.Get(), deleted_indices)) {
      surviving_children.push_back(cur_child);
    }
    cur_child = next;
  }

  if (surviving_children.empty()) {
    bookmark->RemoveFor("First");
    bookmark->RemoveFor("Last");
    bookmark->RemoveFor("Count");
  } else {
    bookmark->SetNewFor<CPDF_Reference>("First", doc, surviving_children.front()->GetObjNum());
    bookmark->SetNewFor<CPDF_Reference>("Last", doc, surviving_children.back()->GetObjNum());
    for (size_t i = 0; i < surviving_children.size(); ++i) {
      if (i > 0) {
        surviving_children[i]->SetNewFor<CPDF_Reference>("Prev", doc, surviving_children[i - 1]->GetObjNum());
      } else {
        surviving_children[i]->RemoveFor("Prev");
      }
      if (i + 1 < surviving_children.size()) {
        surviving_children[i]->SetNewFor<CPDF_Reference>("Next", doc, surviving_children[i + 1]->GetObjNum());
      } else {
        surviving_children[i]->RemoveFor("Next");
      }
      surviving_children[i]->SetNewFor<CPDF_Reference>("Parent", doc, bookmark->GetObjNum());
    }
    bookmark->SetNewFor<CPDF_Number>("Count", static_cast<int>(surviving_children.size()));
  }

  if (targets_deleted) {
    if (!surviving_children.empty()) {
      RetainPtr<const CPDF_Object> child_dest = surviving_children.front()->GetObjectFor("Dest");
      if (child_dest) {
        bookmark->SetFor("Dest", child_dest->Clone());
        bookmark->RemoveFor("A");
        return true;
      }
      RetainPtr<const CPDF_Dictionary> child_action = surviving_children.front()->GetDictFor("A");
      if (child_action) {
        bookmark->SetFor("A", child_action->Clone());
        bookmark->RemoveFor("Dest");
        return true;
      }
    }
    return false;
  }
  return true;
}

inline void PruneOutlinesTargetingDeletedPages(
    CPDF_Document* doc,
    const std::set<size_t>& deleted_indices) {
  if (!doc) return;
  auto root = doc->GetMutableRoot();
  if (!root) return;
  auto outlines = root->GetMutableDictFor("Outlines");
  if (!outlines) return;

  RetainPtr<CPDF_Dictionary> cur = outlines->GetMutableDictFor("First");
  std::vector<RetainPtr<CPDF_Dictionary>> surviving_top;
  while (cur) {
    RetainPtr<CPDF_Dictionary> next = cur->GetMutableDictFor("Next");
    if (PruneBookmarkNode(doc, cur.Get(), deleted_indices)) {
      surviving_top.push_back(cur);
    }
    cur = next;
  }

  if (surviving_top.empty()) {
    root->RemoveFor("Outlines");
  } else {
    outlines->SetNewFor<CPDF_Reference>("First", doc, surviving_top.front()->GetObjNum());
    outlines->SetNewFor<CPDF_Reference>("Last", doc, surviving_top.back()->GetObjNum());
    for (size_t i = 0; i < surviving_top.size(); ++i) {
      if (i > 0) {
        surviving_top[i]->SetNewFor<CPDF_Reference>("Prev", doc, surviving_top[i - 1]->GetObjNum());
      } else {
        surviving_top[i]->RemoveFor("Prev");
      }
      if (i + 1 < surviving_top.size()) {
        surviving_top[i]->SetNewFor<CPDF_Reference>("Next", doc, surviving_top[i + 1]->GetObjNum());
      } else {
        surviving_top[i]->RemoveFor("Next");
      }
      surviving_top[i]->SetNewFor<CPDF_Reference>("Parent", doc, outlines->GetObjNum());
    }
    outlines->SetNewFor<CPDF_Number>("Count", static_cast<int>(surviving_top.size()));
  }
}

inline void PruneWidgetsOnDeletedPages(
    CPDF_Document* doc,
    const std::set<size_t>& deleted_indices) {
  if (!doc) return;
  auto root = doc->GetMutableRoot();
  if (!root) return;
  auto acroform = root->GetMutableDictFor("AcroForm");
  if (!acroform) return;
  auto fields = acroform->GetMutableArrayFor("Fields");
  if (!fields) return;

  std::set<uint32_t> deleted_widget_objs;
  for (size_t p : deleted_indices) {
    auto page = doc->GetPageDictionary(static_cast<int>(p));
    if (!page) continue;
    auto annots = page->GetArrayFor("Annots");
    if (!annots) continue;
    for (size_t i = 0; i < annots->size(); ++i) {
      auto annot = annots->GetDictAt(i);
      if (annot && annot->GetNameFor("Subtype") == "Widget" && annot->GetObjNum() != 0) {
        deleted_widget_objs.insert(annot->GetObjNum());
      }
    }
  }
  if (deleted_widget_objs.empty()) return;

  auto prune_fields = [&](auto self, CPDF_Array* arr) -> void {
    if (!arr) return;
    for (size_t i = 0; i < arr->size(); ) {
      auto direct = arr->GetMutableDictAt(i);
      uint32_t obj_num = 0;
      auto obj = arr->GetObjectAt(i);
      if (obj && obj->IsReference()) obj_num = obj->AsReference()->GetRefObjNum();
      else if (direct) obj_num = direct->GetObjNum();

      if (deleted_widget_objs.contains(obj_num)) {
        arr->RemoveAt(i);
        continue;
      }
      if (direct) {
        auto kids = direct->GetMutableArrayFor("Kids");
        if (kids) {
          self(self, kids.Get());
          if (kids->IsEmpty()) {
            arr->RemoveAt(i);
            continue;
          }
        }
      }
      ++i;
    }
  };

  prune_fields(prune_fields, fields.Get());
}

inline void PruneTaggedStructureForDeletedPages(
    CPDF_Document* doc,
    const std::set<size_t>& deleted_indices) {
  if (!doc) return;
  auto root = doc->GetMutableRoot();
  if (!root) return;
  auto struct_tree_root = root->GetMutableDictFor("StructTreeRoot");
  if (!struct_tree_root) return;

  std::set<int> deleted_sp_keys;
  std::set<uint32_t> deleted_page_objs;
  for (size_t p : deleted_indices) {
    auto page = doc->GetPageDictionary(static_cast<int>(p));
    if (!page) continue;
    deleted_page_objs.insert(page->GetObjNum());
    int sp = page->GetIntegerFor("StructParents", -1);
    if (sp >= 0) deleted_sp_keys.insert(sp);
    auto annots = page->GetArrayFor("Annots");
    if (annots) {
      for (size_t a = 0; a < annots->size(); ++a) {
        auto annot = annots->GetDictAt(a);
        if (annot) {
          int ap = annot->GetIntegerFor("StructParent", -1);
          if (ap >= 0) deleted_sp_keys.insert(ap);
        }
      }
    }
  }

  auto parent_tree_dict = struct_tree_root->GetDictFor("ParentTree");
  if (parent_tree_dict) {
    std::map<int, RetainPtr<const CPDF_Object>> const_entries;
    CollectNumberTreeEntries(parent_tree_dict.Get(), &const_entries);
    std::map<int, RetainPtr<CPDF_Object>> entries;
    for (const auto& [k, v] : const_entries) {
      if (!deleted_sp_keys.contains(k) && v) {
        entries[k] = pdfium::WrapRetain(const_cast<CPDF_Object*>(v.Get()));
      }
    }
    RebuildParentTree(doc, struct_tree_root.Get(), entries);
  }

  auto prune_struct_elem = [&](auto self, CPDF_Dictionary* elem) -> bool {
    if (!elem) return false;
    uint32_t pg_num = 0;
    auto pg = elem->GetObjectFor("Pg");
    if (pg && pg->IsReference()) pg_num = pg->AsReference()->GetRefObjNum();
    else if (pg && pg->IsDictionary()) pg_num = pg->AsDictionary()->GetObjNum();

    bool on_deleted_page = (pg_num != 0 && deleted_page_objs.contains(pg_num));

    auto k_obj = elem->GetMutableObjectFor("K");
    if (!k_obj) return !on_deleted_page;

    if (k_obj->IsNumber()) {
      if (on_deleted_page) {
        elem->RemoveFor("K");
        elem->RemoveFor("Pg");
        return false;
      }
      return true;
    }

    if (k_obj->IsDictionary()) {
      auto child_dict = k_obj->AsMutableDictionary();
      ByteString type = child_dict->GetNameFor("Type");
      if (type == "MCR" || type == "OBJR") {
        uint32_t mcr_pg = 0;
        auto m_pg = child_dict->GetObjectFor("Pg");
        if (m_pg && m_pg->IsReference()) mcr_pg = m_pg->AsReference()->GetRefObjNum();
        else if (m_pg && m_pg->IsDictionary()) mcr_pg = m_pg->AsDictionary()->GetObjNum();
        if (mcr_pg != 0 && deleted_page_objs.contains(mcr_pg)) {
          elem->RemoveFor("K");
          return false;
        }
        return true;
      } else {
        if (!self(self, child_dict)) {
          elem->RemoveFor("K");
          return false;
        }
        return true;
      }
    }

    if (k_obj->IsArray()) {
      auto k_arr = k_obj->AsMutableArray();
      for (size_t i = 0; i < k_arr->size(); ) {
        auto direct = k_arr->GetMutableDirectObjectAt(i);
        if (!direct) {
          k_arr->RemoveAt(i);
          continue;
        }
        if (direct->IsNumber()) {
          if (on_deleted_page) {
            k_arr->RemoveAt(i);
            continue;
          }
        } else if (direct->IsDictionary()) {
          auto d = direct->AsMutableDictionary();
          ByteString type = d->GetNameFor("Type");
          if (type == "MCR" || type == "OBJR") {
            uint32_t mcr_pg = 0;
            auto m_pg = d->GetObjectFor("Pg");
            if (m_pg && m_pg->IsReference()) mcr_pg = m_pg->AsReference()->GetRefObjNum();
            else if (m_pg && m_pg->IsDictionary()) mcr_pg = m_pg->AsDictionary()->GetObjNum();
            if (mcr_pg != 0 && deleted_page_objs.contains(mcr_pg)) {
              k_arr->RemoveAt(i);
              continue;
            }
          } else {
            if (!self(self, d)) {
              k_arr->RemoveAt(i);
              continue;
            }
          }
        }
        ++i;
      }
      if (k_arr->IsEmpty()) {
        elem->RemoveFor("K");
        elem->RemoveFor("Pg");
        return false;
      }
      return true;
    }
    return true;
  };

  auto top_k = struct_tree_root->GetMutableObjectFor("K");
  if (top_k && top_k->IsArray()) {
    auto top_arr = top_k->AsMutableArray();
    for (size_t i = 0; i < top_arr->size(); ) {
      auto child = top_arr->GetMutableDictAt(i);
      if (!child || !prune_struct_elem(prune_struct_elem, child.Get())) {
        top_arr->RemoveAt(i);
      } else {
        ++i;
      }
    }
    if (top_arr->IsEmpty()) {
      struct_tree_root->RemoveFor("K");
    }
  } else if (top_k && top_k->IsDictionary()) {
    if (!prune_struct_elem(prune_struct_elem, top_k->AsMutableDictionary())) {
      struct_tree_root->RemoveFor("K");
    }
  }
}

// -----------------------------------------------------------------------------
// MCID Cleanup for Object Deletion
// -----------------------------------------------------------------------------

inline void CleanupDeletedObjectMcid(CPDF_Document* doc, CPDF_Page* page, int mcid) {
  if (!doc || !page || mcid < 0) return;
  auto root = doc->GetMutableRoot();
  if (!root) return;
  auto struct_tree_root = root->GetMutableDictFor("StructTreeRoot");
  if (!struct_tree_root) return;
  int sp = page->GetDict()->GetIntegerFor("StructParents", -1);
  if (sp < 0) return;
  auto parent_tree_dict = struct_tree_root->GetDictFor("ParentTree");
  if (!parent_tree_dict) return;
  CPDF_NumberTree number_tree(parent_tree_dict);
  RetainPtr<const CPDF_Object> val = number_tree.LookupValue(sp);
  if (!val || !val->IsArray()) return;
  auto arr = ToArray(pdfium::WrapRetain(const_cast<CPDF_Object*>(val.Get())));
  if (static_cast<size_t>(mcid) < arr->size()) {
    auto elem = arr->GetMutableDictAt(static_cast<size_t>(mcid));
    if (elem) {
      auto k_obj = elem->GetMutableObjectFor("K");
      if (k_obj && k_obj->IsArray()) {
        auto k_arr = k_obj->AsMutableArray();
        for (size_t i = 0; i < k_arr->size(); ++i) {
          if (k_arr->GetIntegerAt(i) == mcid) {
            k_arr->RemoveAt(i);
            break;
          }
        }
      } else if (k_obj && k_obj->IsNumber() && k_obj->GetInteger() == mcid) {
        elem->RemoveFor("K");
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Cross-Document & Intra-Document Remapping Helpers
// -----------------------------------------------------------------------------

inline void RemapImportedPageLinks(
    CPDF_Document* dest_doc,
    CPDF_Document* src_doc,
    const std::map<int, int>& src_to_dest_page_map,
    size_t insertion_index,
    const std::vector<int>& source_indices) {
  if (!dest_doc || !src_doc) return;
  for (size_t offset = 0; offset < source_indices.size(); ++offset) {
    auto page = dest_doc->GetMutablePageDictionary(static_cast<int>(insertion_index + offset));
    const auto source_page = src_doc->GetPageDictionary(source_indices[offset]);
    if (!page || !source_page) continue;
    auto annots = page->GetMutableArrayFor("Annots");
    const auto source_annots = source_page->GetArrayFor("Annots");
    if (!annots || !source_annots) continue;
    size_t source_index = 0;
    for (size_t i = 0; i < annots->size() && source_index < source_annots->size(); ++source_index) {
      auto annot = annots->GetMutableDictAt(i);
      const auto original = source_annots->GetDictAt(source_index);
      if (!annot || annot->GetNameFor("Subtype") != "Link") {
        ++i;
        continue;
      }
      int src_target = ResolveAnnotDestTargetPageIndex(src_doc, original.Get());
      if (src_target >= 0) {
        auto it = src_to_dest_page_map.find(src_target);
        if (it != src_to_dest_page_map.end()) {
          auto target_page = dest_doc->GetPageDictionary(it->second);
          if (target_page && target_page->GetObjNum() != 0) {
            RetainPtr<const CPDF_Array> orig_dest_arr = ResolveDestArray(src_doc, original->GetObjectFor("Dest").Get());
            if (!orig_dest_arr) {
              auto act = original->GetDictFor("A");
              if (act) orig_dest_arr = ResolveDestArray(src_doc, act->GetObjectFor("D").Get());
            }
            if (orig_dest_arr && orig_dest_arr->size() > 1) {
              auto new_arr = CloneDestinationArrayWithRemappedPage(dest_doc, orig_dest_arr.Get(), target_page->GetObjNum());
              if (original->KeyExist("Dest")) {
                annot->SetFor("Dest", new_arr);
              } else {
                auto act = annot->GetOrCreateDictFor("A");
                act->SetNewFor<CPDF_Name>("S", "GoTo");
                act->SetFor("D", new_arr);
              }
            } else {
              RemapAnnotDest(dest_doc, annot.Get(), target_page->GetObjNum());
            }
            ++i;
            continue;
          }
        }
        // Dangling link targeting unselected page: prune
        annot->RemoveFor("Dest");
        annot->RemoveFor("A");
        annots->RemoveAt(i);
      } else {
        ++i;
      }
    }
  }
}

inline void RemapImportedOutlines(
    CPDF_Document* dest_doc,
    CPDF_Document* src_doc,
    CrossDocObjectMapping* mapper,
    const std::map<int, int>& src_to_dest_page_map) {
  if (!dest_doc || !src_doc || !mapper) return;
  const auto* src_root = src_doc->GetRoot();
  if (!src_root) return;
  RetainPtr<const CPDF_Dictionary> src_outlines = src_root->GetDictFor("Outlines");
  if (!src_outlines) return;

  auto clone_outline_subtree = [&](auto self, const CPDF_Dictionary* src_item) -> RetainPtr<CPDF_Dictionary> {
    if (!src_item) return nullptr;
    int src_target = ResolveBookmarkDestTargetPageIndex(src_doc, src_item);
    bool targets_imported = (src_target >= 0 && src_to_dest_page_map.count(src_target));

    std::vector<RetainPtr<CPDF_Dictionary>> cloned_kids;
    RetainPtr<const CPDF_Dictionary> cur_child = src_item->GetDictFor("First");
    while (cur_child) {
      auto cloned_child = self(self, cur_child.Get());
      if (cloned_child) cloned_kids.push_back(cloned_child);
      cur_child = cur_child->GetDictFor("Next");
    }

    if (!targets_imported && cloned_kids.empty()) return nullptr;

    auto dest_item = dest_doc->NewIndirect<CPDF_Dictionary>();
    RetainPtr<const CPDF_Object> title = src_item->GetObjectFor("Title");
    if (title) {
      dest_item->SetFor("Title", mapper->CloneAndMapObject(title));
    } else {
      dest_item->SetNewFor<CPDF_String>("Title", ByteString());
    }

    if (targets_imported) {
      int dest_page_idx = src_to_dest_page_map.at(src_target);
      auto dest_page = dest_doc->GetPageDictionary(dest_page_idx);
      if (dest_page) {
        RetainPtr<const CPDF_Array> orig_dest_arr = ResolveDestArray(src_doc, src_item->GetObjectFor("Dest").Get());
        if (!orig_dest_arr) {
          auto act = src_item->GetDictFor("A");
          if (act) orig_dest_arr = ResolveDestArray(src_doc, act->GetObjectFor("D").Get());
        }
        if (orig_dest_arr && orig_dest_arr->size() > 1) {
          auto new_dest_arr = CloneDestinationArrayWithRemappedPage(dest_doc, orig_dest_arr.Get(), dest_page->GetObjNum());
          dest_doc->AddIndirectObject(new_dest_arr);
          dest_item->SetNewFor<CPDF_Reference>("Dest", dest_doc, new_dest_arr->GetObjNum());
        } else {
          auto dest_arr = dest_doc->NewIndirect<CPDF_Array>();
          dest_arr->AppendNew<CPDF_Reference>(dest_doc, dest_page->GetObjNum());
          dest_arr->AppendNew<CPDF_Name>("Fit");
          dest_item->SetNewFor<CPDF_Reference>("Dest", dest_doc, dest_arr->GetObjNum());
        }
      }
    } else if (!cloned_kids.empty()) {
      auto kid_dest = cloned_kids.front()->GetObjectFor("Dest");
      if (kid_dest) dest_item->SetFor("Dest", kid_dest->Clone());
    }

    if (!cloned_kids.empty()) {
      dest_item->SetNewFor<CPDF_Reference>("First", dest_doc, cloned_kids.front()->GetObjNum());
      dest_item->SetNewFor<CPDF_Reference>("Last", dest_doc, cloned_kids.back()->GetObjNum());
      for (size_t idx = 0; idx < cloned_kids.size(); ++idx) {
        cloned_kids[idx]->SetNewFor<CPDF_Reference>("Parent", dest_doc, dest_item->GetObjNum());
        if (idx > 0) cloned_kids[idx]->SetNewFor<CPDF_Reference>("Prev", dest_doc, cloned_kids[idx - 1]->GetObjNum());
        if (idx + 1 < cloned_kids.size()) cloned_kids[idx]->SetNewFor<CPDF_Reference>("Next", dest_doc, cloned_kids[idx + 1]->GetObjNum());
      }
      dest_item->SetNewFor<CPDF_Number>("Count", static_cast<int>(cloned_kids.size()));
    }
    return dest_item;
  };

  std::vector<RetainPtr<CPDF_Dictionary>> cloned_top_items;
  RetainPtr<const CPDF_Dictionary> cur = src_outlines->GetDictFor("First");
  while (cur) {
    auto cloned = clone_outline_subtree(clone_outline_subtree, cur.Get());
    if (cloned) cloned_top_items.push_back(cloned);
    cur = cur->GetDictFor("Next");
  }

  if (cloned_top_items.empty()) return;

  auto dest_root = dest_doc->GetMutableRoot();
  auto dest_outlines = dest_root->GetMutableDictFor("Outlines");
  if (!dest_outlines) {
    dest_outlines = dest_doc->NewIndirect<CPDF_Dictionary>();
    dest_outlines->SetNewFor<CPDF_Name>("Type", "Outlines");
    dest_root->SetNewFor<CPDF_Reference>("Outlines", dest_doc, dest_outlines->GetObjNum());
  }

  RetainPtr<CPDF_Dictionary> last_existing = dest_outlines->GetMutableDictFor("Last");
  if (!last_existing) {
    dest_outlines->SetNewFor<CPDF_Reference>("First", dest_doc, cloned_top_items.front()->GetObjNum());
  } else {
    last_existing->SetNewFor<CPDF_Reference>("Next", dest_doc, cloned_top_items.front()->GetObjNum());
    cloned_top_items.front()->SetNewFor<CPDF_Reference>("Prev", dest_doc, last_existing->GetObjNum());
  }
  dest_outlines->SetNewFor<CPDF_Reference>("Last", dest_doc, cloned_top_items.back()->GetObjNum());
  for (size_t i = 0; i < cloned_top_items.size(); ++i) {
    cloned_top_items[i]->SetNewFor<CPDF_Reference>("Parent", dest_doc, dest_outlines->GetObjNum());
    if (i > 0) cloned_top_items[i]->SetNewFor<CPDF_Reference>("Prev", dest_doc, cloned_top_items[i - 1]->GetObjNum());
    if (i + 1 < cloned_top_items.size()) cloned_top_items[i]->SetNewFor<CPDF_Reference>("Next", dest_doc, cloned_top_items[i + 1]->GetObjNum());
  }
  int prev_count = dest_outlines->GetIntegerFor("Count", 0);
  dest_outlines->SetNewFor<CPDF_Number>("Count", prev_count + static_cast<int>(cloned_top_items.size()));
}

inline void RemapImportedWidgets(
    CPDF_Document* dest_doc,
    CPDF_Document* src_doc,
    CrossDocObjectMapping* mapper,
    const std::vector<int>& source_indices,
    size_t insertion_index) {
  if (!dest_doc || !src_doc || !mapper) return;
  auto dest_root = dest_doc->GetMutableRoot();
  if (!dest_root) return;

  const auto* src_root = src_doc->GetRoot();
  RetainPtr<const CPDF_Dictionary> src_acro = src_root ? src_root->GetDictFor("AcroForm") : nullptr;

  std::map<ByteString, ByteString> font_alias_map;

  auto dest_acro = dest_root->GetMutableDictFor("AcroForm");
  if (!dest_acro) {
    dest_acro = dest_doc->NewIndirect<CPDF_Dictionary>();
    dest_root->SetNewFor<CPDF_Reference>("AcroForm", dest_doc, dest_acro->GetObjNum());
    if (src_acro) {
      if (src_acro->KeyExist("DA")) {
        dest_acro->SetFor("DA", src_acro->GetObjectFor("DA")->Clone());
      }
      RetainPtr<const CPDF_Object> dr = src_acro->GetObjectFor("DR");
      if (dr) dest_acro->SetFor("DR", mapper->CloneAndMapObject(dr));
    }
  } else if (src_acro) {
    // Merge /DR Font dictionaries, avoiding font alias collision
    RetainPtr<const CPDF_Dictionary> src_dr = src_acro->GetDictFor("DR");
    RetainPtr<const CPDF_Dictionary> src_fonts = src_dr ? src_dr->GetDictFor("Font") : nullptr;
    if (src_fonts) {
      auto dest_dr = dest_acro->GetMutableDictFor("DR");
      if (!dest_dr) {
        dest_dr = dest_doc->NewIndirect<CPDF_Dictionary>();
        dest_acro->SetNewFor<CPDF_Reference>("DR", dest_doc, dest_dr->GetObjNum());
      }
      auto dest_fonts = dest_dr->GetMutableDictFor("Font");
      if (!dest_fonts) {
        dest_fonts = dest_doc->NewIndirect<CPDF_Dictionary>();
        dest_dr->SetNewFor<CPDF_Reference>("Font", dest_doc, dest_fonts->GetObjNum());
      }
      CPDF_DictionaryLocker font_locker(src_fonts);
      for (const auto& it : font_locker) {
        const ByteString& font_name = it.first;
        ByteString target_alias = font_name;
        int disambig = 1;
        while (dest_fonts->KeyExist(target_alias.AsStringView())) {
          target_alias = font_name + "_imp" + ByteString::FormatInteger(disambig++);
        }
        if (target_alias != font_name) {
          font_alias_map[font_name] = target_alias;
        }
        dest_fonts->SetFor(target_alias, mapper->CloneAndMapObject(it.second));
      }
    }
  }

  auto fields = dest_acro->GetMutableArrayFor("Fields");
  if (!fields) {
    auto new_fields = dest_doc->NewIndirect<CPDF_Array>();
    dest_acro->SetNewFor<CPDF_Reference>("Fields", dest_doc, new_fields->GetObjNum());
    fields = new_fields;
  }

  std::set<std::string> existing_root_names;
  for (size_t i = 0; i < fields->size(); ++i) {
    auto f = fields->GetDictAt(i);
    if (f) {
      ByteString utf8_name = f->GetUnicodeTextFor("T").ToUTF8();
      if (!utf8_name.IsEmpty()) existing_root_names.insert(std::string(utf8_name.c_str(), utf8_name.GetLength()));
    }
  }

  // Find all root fields in src_doc that contain widgets on the imported pages
  std::set<uint32_t> imported_widget_nums;
  for (size_t offset = 0; offset < source_indices.size(); ++offset) {
    auto page = dest_doc->GetPageDictionary(static_cast<int>(insertion_index + offset));
    if (!page) continue;
    auto annots = page->GetArrayFor("Annots");
    if (!annots) continue;
    for (size_t i = 0; i < annots->size(); ++i) {
      auto annot = annots->GetDictAt(i);
      if (annot && annot->GetNameFor("Subtype") == "Widget" && annot->GetObjNum() != 0) {
        imported_widget_nums.insert(annot->GetObjNum());
      }
    }
  }

  // Helper to synchronize /DA font alias and clear/disambiguate KomoFieldId
  auto sanitize_field_node = [&](auto self, CPDF_Dictionary* node, int copy_index) -> void {
    if (!node) return;
    if (node->KeyExist("KomoFieldId")) {
      ByteString orig_fid = node->GetUnicodeTextFor("KomoFieldId").ToUTF8();
      if (!orig_fid.IsEmpty()) {
        std::string new_fid = std::string(orig_fid.c_str(), orig_fid.GetLength()) + "_copy" + std::to_string(copy_index);
        WideString wide_fid = WideString::FromUTF8(ByteStringView(new_fid.data(), new_fid.size()));
        node->SetNewFor<CPDF_String>("KomoFieldId", wide_fid.AsStringView());
      } else {
        node->RemoveFor("KomoFieldId");
      }
    }
    if (!font_alias_map.empty() && node->KeyExist("DA") &&
        !CPDF_FormField::GetFieldAttrForDict(node, "DR")) {
      ByteString da = node->GetByteStringFor("DA");
      for (const auto& [orig_font, new_font] : font_alias_map) {
        ByteString target_prefix = "/" + orig_font + " ";
        const auto pos = da.Find(target_prefix.AsStringView());
        if (pos) {
          ByteString updated = da.Substr(0, *pos) + "/" + new_font + " " +
                               da.Substr(*pos + target_prefix.GetLength());
          node->SetNewFor<CPDF_String>("DA", updated);
          break;
        }
      }
    }
    auto kids = node->GetMutableArrayFor("Kids");
    if (kids) {
      for (size_t k = 0; k < kids->size(); ++k) {
        self(self, kids->GetMutableDictAt(k).Get(), copy_index);
      }
    }
  };

  RetainPtr<const CPDF_Array> src_fields = src_acro ? src_acro->GetArrayFor("Fields") : nullptr;
  if (!src_fields) return;

  auto field_has_imported_widget = [&](auto self, const CPDF_Dictionary* field_dict) -> bool {
    if (!field_dict) return false;
    uint32_t mapped_num = mapper->GetMappedObjNum(field_dict->GetObjNum());
    if (mapped_num != 0 && imported_widget_nums.contains(mapped_num)) return true;
    RetainPtr<const CPDF_Array> kids = field_dict->GetArrayFor("Kids");
    if (kids) {
      for (size_t k = 0; k < kids->size(); ++k) {
        if (self(self, kids->GetDictAt(k).Get())) return true;
      }
    }
    return false;
  };

  for (size_t i = 0; i < src_fields->size(); ++i) {
    RetainPtr<const CPDF_Dictionary> root_field = src_fields->GetDictAt(i);
    if (!root_field || !field_has_imported_widget(field_has_imported_widget, root_field.Get())) {
      continue;
    }

    RetainPtr<CPDF_Object> mapped_field_ref = mapper->CloneAndMapObject(root_field);
    if (!mapped_field_ref) continue;

    auto mapped_field_dict = ToDictionary(mapped_field_ref->GetMutableDirect());
    if (!mapped_field_dict) continue;
    // Only attach widgets on imported pages, and repair their parent links to
    // the same field dictionaries attached to /AcroForm /Fields.
    const auto rebuild_kids = [&](auto self, const CPDF_Dictionary* source,
                                   CPDF_Dictionary* target) -> void {
      const auto source_kids = source->GetArrayFor("Kids");
      if (!source_kids) return;
      auto target_kids = pdfium::MakeRetain<CPDF_Array>();
      for (size_t child_index = 0; child_index < source_kids->size(); ++child_index) {
        const auto source_child = source_kids->GetDictAt(child_index);
        if (!source_child || !field_has_imported_widget(field_has_imported_widget, source_child.Get())) continue;
        auto mapped_child = mapper->CloneAndMapObject(source_child);
        auto target_child = mapped_child ? ToDictionary(mapped_child->GetMutableDirect()) : nullptr;
        if (!target_child) continue;
        target_child->SetNewFor<CPDF_Reference>("Parent", dest_doc, target->GetObjNum());
        self(self, source_child.Get(), target_child.Get());
        target_kids->Append(std::move(mapped_child));
      }
      target->SetFor("Kids", std::move(target_kids));
    };
    rebuild_kids(rebuild_kids, root_field.Get(), mapped_field_dict.Get());
    mapped_field_dict->RemoveFor("Parent");
    if (!mapped_field_dict->KeyExist("DA") && src_acro && src_acro->KeyExist("DA"))
      mapped_field_dict->SetFor("DA", src_acro->GetObjectFor("DA")->Clone());
    if (!mapped_field_dict->KeyExist("Q"))
      mapped_field_dict->SetNewFor<CPDF_Number>("Q", src_acro ? src_acro->GetIntegerFor("Q") : 0);

    ByteString utf8_name = mapped_field_dict->GetUnicodeTextFor("T").ToUTF8();
    std::string base_name = utf8_name.IsEmpty() ? "field" : std::string(utf8_name.c_str(), utf8_name.GetLength());
    std::string unique_name = base_name;
    int disambig = 1;
    while (existing_root_names.contains(unique_name)) {
      unique_name = base_name + "_copy" + std::to_string(disambig++);
    }
    existing_root_names.insert(unique_name);
    WideString wide = WideString::FromUTF8(ByteStringView(unique_name.data(), unique_name.size()));
    mapped_field_dict->SetNewFor<CPDF_String>("T", wide.AsStringView());

    sanitize_field_node(sanitize_field_node, mapped_field_dict.Get(), disambig);

    fields->Append(mapped_field_ref);
  }
}

inline void RemapImportedTaggedStructure(
    CPDF_Document* dest_doc,
    CPDF_Document* src_doc,
    CrossDocObjectMapping* mapper,
    const std::vector<int>& source_indices,
    size_t insertion_index) {
  if (!dest_doc || !src_doc || !mapper) return;
  const auto* src_root = src_doc->GetRoot();
  if (!src_root) return;
  RetainPtr<const CPDF_Dictionary> src_struct_root = src_root->GetDictFor("StructTreeRoot");
  if (!src_struct_root) return;
  RetainPtr<const CPDF_Dictionary> src_parent_tree = src_struct_root->GetDictFor("ParentTree");
  if (!src_parent_tree) return;

  std::map<int, RetainPtr<const CPDF_Object>> src_entries;
  CollectNumberTreeEntries(src_parent_tree.Get(), &src_entries);

  auto dest_root = dest_doc->GetMutableRoot();
  auto dest_struct_root = dest_root->GetMutableDictFor("StructTreeRoot");
  if (!dest_struct_root) {
    dest_struct_root = dest_doc->NewIndirect<CPDF_Dictionary>();
    dest_struct_root->SetNewFor<CPDF_Name>("Type", "StructTreeRoot");
    dest_root->SetNewFor<CPDF_Reference>("StructTreeRoot", dest_doc, dest_struct_root->GetObjNum());
  }

  // Pre-map source StructTreeRoot to destination StructTreeRoot so /P points to dest_struct_root
  mapper->AddMapping(src_struct_root->GetObjNum(), dest_struct_root->GetObjNum());

  // Imported custom roles/classes must not silently acquire the target's
  // different definition when names collide.
  const auto merge_named_map = [&](const char* key) {
    std::map<ByteString, ByteString> aliases;
    const auto source = src_struct_root->GetDictFor(key);
    if (!source) return aliases;
    auto target = dest_struct_root->GetOrCreateDictFor(key);
    CPDF_DictionaryLocker entries(source.Get());
    for (const auto& [name, value] : entries) {
      ByteString alias = name;
      int suffix = 1;
      while (target->KeyExist(alias.AsStringView()))
        alias = name + ByteString::Format("_import%d", suffix++);
      aliases[name] = alias;
      target->SetFor(alias, mapper->CloneAndMapObject(value));
    }
    if (std::string_view(key) == "RoleMap") {
      for (const auto& [name, alias] : aliases) {
        const ByteString role = source->GetNameFor(name.AsStringView());
        if (aliases.contains(role)) target->SetNewFor<CPDF_Name>(alias, aliases.at(role));
      }
    }
    return aliases;
  };
  const auto role_aliases = merge_named_map("RoleMap");
  const auto class_aliases = merge_named_map("ClassMap");

  // Identify source elements in pages, annotations and nested tagged Forms.
  std::set<uint32_t> selected_elem_nums;
  std::set<const CPDF_Dictionary*> seen_forms;
  const auto collect_form_elements = [&](auto self, const CPDF_Dictionary* resources) -> void {
    const auto objects = resources ? resources->GetDictFor("XObject") : nullptr;
    if (!objects) return;
    CPDF_DictionaryLocker entries(objects.Get());
    for (const auto& [name, value] : entries) {
      const auto form = objects->GetDictFor(name.AsStringView());
      if (!form || form->GetNameFor("Subtype") != "Form" || !seen_forms.insert(form.Get()).second) continue;
      for (const char* key : {"StructParent", "StructParents"}) {
        const int parent = form->GetIntegerFor(key, -1);
        if (parent < 0 || !src_entries.contains(parent)) continue;
        const auto entry = src_entries.at(parent);
        if (entry && entry->IsArray()) {
          const auto* elements = entry->AsArray();
          for (size_t index = 0; index < elements->size(); ++index) {
            const auto element = elements->GetDictAt(index);
            if (element) selected_elem_nums.insert(element->GetObjNum());
          }
        } else if (entry && entry->IsDictionary()) {
          selected_elem_nums.insert(entry->GetObjNum());
        }
      }
      self(self, form->GetDictFor("Resources").Get());
    }
  };
  for (int s_idx : source_indices) {
    auto page = src_doc->GetPageDictionary(s_idx);
    if (!page) continue;
    collect_form_elements(collect_form_elements, page->GetDictFor("Resources").Get());
    int sp = page->GetIntegerFor("StructParents", -1);
    if (sp >= 0 && src_entries.count(sp)) {
      auto val = src_entries[sp];
      if (val && val->IsArray()) {
        const auto* arr = val->AsArray();
        for (size_t a = 0; a < arr->size(); ++a) {
          auto ref = arr->GetObjectAt(a);
          if (ref && ref->IsReference()) selected_elem_nums.insert(ref->AsReference()->GetRefObjNum());
          else if (ref && ref->GetObjNum() != 0) selected_elem_nums.insert(ref->GetObjNum());
        }
      }
    }
    auto annots = page->GetArrayFor("Annots");
    if (annots) {
      for (size_t a = 0; a < annots->size(); ++a) {
        auto annot = annots->GetDictAt(a);
        if (annot) {
          int ap = annot->GetIntegerFor("StructParent", -1);
          if (ap >= 0 && src_entries.count(ap)) {
            auto val = src_entries[ap];
            if (val && val->IsReference()) selected_elem_nums.insert(val->AsReference()->GetRefObjNum());
            else if (val && val->GetObjNum() != 0) selected_elem_nums.insert(val->GetObjNum());
          }
        }
      }
    }
  }

  // Collect all ancestors up to StructTreeRoot
  std::set<uint32_t> active_elem_and_ancestor_nums = selected_elem_nums;
  for (uint32_t num : selected_elem_nums) {
    RetainPtr<const CPDF_Dictionary> cur = ToDictionary(src_doc->GetIndirectObject(num));
    while (cur) {
      RetainPtr<const CPDF_Dictionary> parent = cur->GetDictFor("P");
      if (!parent || parent.Get() == src_struct_root.Get()) break;
      uint32_t p_num = parent->GetObjNum();
      if (p_num != 0) active_elem_and_ancestor_nums.insert(p_num);
      cur = parent;
    }
  }

  // Prune at every depth, not just root children. K may itself be indirect.
  std::set<uint32_t> selected_page_nums;
  for (int index : source_indices) selected_page_nums.insert(src_doc->GetPageDictionary(index)->GetObjNum());
  std::set<const CPDF_Object*> filtering;
  auto filter_and_clone_k = [&](auto self, RetainPtr<const CPDF_Object> source,
                               const CPDF_Dictionary* inherited_page,
                               bool keep_content) -> RetainPtr<CPDF_Object> {
    if (!source) return nullptr;
    auto direct = source->GetDirect();
    if (!direct || !filtering.insert(direct.Get()).second) return nullptr;
    RetainPtr<CPDF_Object> result;
    if (const auto* array = direct->AsArray()) {
      auto children = pdfium::MakeRetain<CPDF_Array>();
      for (size_t index = 0; index < array->size(); ++index) {
        auto child = self(self, array->GetObjectAt(index), inherited_page, keep_content);
        if (child) children->Append(std::move(child));
      }
      if (!children->IsEmpty()) result = children;
    } else if (const auto* element = direct->AsDictionary()) {
      const auto own_page = element->GetDictFor("Pg");
      const auto* page = own_page ? own_page.Get() : inherited_page;
      const bool page_selected = !page || selected_page_nums.contains(page->GetObjNum());
      const bool structure_element = element->GetNameFor("Type") == "StructElem" || element->KeyExist("S");
      if (structure_element) {
        const uint32_t number = element->GetObjNum();
        if (!number || active_elem_and_ancestor_nums.contains(number)) {
          result = mapper->CloneAndMapObject(source);
          auto copied = result ? ToDictionary(result->GetMutableDirect()) : nullptr;
          if (copied) {
            const ByteString role = element->GetNameFor("S");
            if (role_aliases.contains(role)) copied->SetNewFor<CPDF_Name>("S", role_aliases.at(role));
            const auto classes = element->GetDirectObjectFor("C");
            if (classes && classes->IsName()) {
              const ByteString name = classes->GetString();
              if (class_aliases.contains(name)) copied->SetNewFor<CPDF_Name>("C", class_aliases.at(name));
            } else if (classes && classes->IsArray()) {
              auto names = pdfium::MakeRetain<CPDF_Array>();
              const auto* source_names = classes->AsArray();
              for (size_t index = 0; index < source_names->size(); ++index) {
                const auto entry = source_names->GetDirectObjectAt(index);
                if (entry && entry->IsName() && class_aliases.contains(entry->GetString()))
                  names->AppendNew<CPDF_Name>(class_aliases.at(entry->GetString()));
                else if (entry) names->Append(entry->Clone());
              }
              copied->SetFor("C", std::move(names));
            }
            auto children = self(self, element->GetObjectFor("K"), page,
                                 page_selected && selected_elem_nums.contains(number));
            if (children) copied->SetFor("K", std::move(children));
            else copied->RemoveFor("K");
          }
        }
      } else if (page_selected && (keep_content || own_page)) {
        result = mapper->CloneAndMapObject(source);
      }
    } else if (keep_content) {
      result = mapper->CloneAndMapObject(source);
    }
    filtering.erase(direct.Get());
    return result;
  };

  RetainPtr<const CPDF_Object> src_k = src_struct_root->GetObjectFor("K");
  if (src_k) {
    RetainPtr<CPDF_Object> filtered_k = filter_and_clone_k(filter_and_clone_k, src_k, nullptr, false);
    if (filtered_k) {
      auto dest_k = dest_struct_root->GetMutableArrayFor("K");
      if (!dest_k) {
        if (filtered_k->IsArray()) {
          dest_struct_root->SetFor("K", filtered_k);
        } else {
          auto new_k = dest_doc->NewIndirect<CPDF_Array>();
          new_k->Append(filtered_k);
          dest_struct_root->SetNewFor<CPDF_Reference>("K", dest_doc, new_k->GetObjNum());
        }
      } else {
        if (filtered_k->IsArray()) {
          for (size_t idx = 0; idx < filtered_k->AsArray()->size(); ++idx) {
            dest_k->Append(filtered_k->AsArray()->GetObjectAt(idx)->Clone());
          }
        } else {
          dest_k->Append(filtered_k);
        }
      }
    }
  }

  std::map<int, RetainPtr<CPDF_Object>> dest_entries;
  RetainPtr<CPDF_Dictionary> dest_parent_tree = dest_struct_root->GetMutableDictFor("ParentTree");
  if (dest_parent_tree) {
    std::map<int, RetainPtr<const CPDF_Object>> existing_entries;
    CollectNumberTreeEntries(dest_parent_tree.Get(), &existing_entries);
    for (const auto& [k, v] : existing_entries) {
      if (v) dest_entries[k] = pdfium::WrapRetain(const_cast<CPDF_Object*>(v.Get()));
    }
  }
  int next_key = dest_entries.empty() ? 0 : dest_entries.rbegin()->first + 1;
  std::set<const CPDF_Dictionary*> remapped_forms;
  const auto remap_forms = [&](auto self, const CPDF_Dictionary* source,
                               CPDF_Dictionary* target) -> void {
    const auto source_objects = source ? source->GetDictFor("XObject") : nullptr;
    const auto target_objects = target ? target->GetMutableDictFor("XObject") : nullptr;
    if (!source_objects || !target_objects) return;
    CPDF_DictionaryLocker entries(source_objects.Get());
    for (const auto& [name, value] : entries) {
      const auto source_form = source_objects->GetDictFor(name.AsStringView());
      const auto target_form = target_objects->GetMutableDictFor(name.AsStringView());
      if (!source_form || !target_form || source_form->GetNameFor("Subtype") != "Form" ||
          !remapped_forms.insert(target_form.Get()).second) continue;
      for (const char* key : {"StructParent", "StructParents"}) {
        const int parent = source_form->GetIntegerFor(key, -1);
        if (parent < 0 || !src_entries.contains(parent)) continue;
        const int mapped_parent = next_key++;
        target_form->SetNewFor<CPDF_Number>(key, mapped_parent);
        dest_entries[mapped_parent] = mapper->CloneAndMapObject(src_entries.at(parent));
      }
      self(self, source_form->GetDictFor("Resources").Get(), target_form->GetMutableDictFor("Resources").Get());
    }
  };

  for (size_t i = 0; i < source_indices.size(); ++i) {
    auto src_page = src_doc->GetPageDictionary(source_indices[i]);
    auto dest_page = dest_doc->GetMutablePageDictionary(static_cast<int>(insertion_index + i));
    if (!src_page || !dest_page) continue;

    // Page StructParents
    int src_sp = src_page->GetIntegerFor("StructParents", -1);
    if (src_sp >= 0 && src_entries.count(src_sp)) {
      int new_sp = next_key++;
      dest_page->SetNewFor<CPDF_Number>("StructParents", new_sp);
      auto src_val = src_entries[src_sp];
      RetainPtr<CPDF_Object> mapped_val = mapper->CloneAndMapObject(src_val);
      if (mapped_val) {
        dest_entries[new_sp] = mapped_val;
      }
    }

    // Annotation StructParent
    auto src_annots = src_page->GetArrayFor("Annots");
    auto dest_annots = dest_page->GetMutableArrayFor("Annots");
    if (src_annots && dest_annots) {
      size_t annot_count = std::min(src_annots->size(), dest_annots->size());
      for (size_t a = 0; a < annot_count; ++a) {
        auto src_annot = src_annots->GetDictAt(a);
        auto dest_annot = dest_annots->GetMutableDictAt(a);
        if (src_annot && dest_annot) {
          int ap = src_annot->GetIntegerFor("StructParent", -1);
          if (ap >= 0 && src_entries.count(ap)) {
            int new_ap = next_key++;
            dest_annot->SetNewFor<CPDF_Number>("StructParent", new_ap);
            dest_entries[new_ap] = mapper->CloneAndMapObject(src_entries[ap]);
          }
        }
      }
    }

    remap_forms(remap_forms, src_page->GetDictFor("Resources").Get(),
                dest_page->GetMutableDictFor("Resources").Get());
  }

  RebuildParentTree(dest_doc, dest_struct_root.Get(), dest_entries);
}

// -----------------------------------------------------------------------------
// Unified Application Hook for ApplyImportedPages
// -----------------------------------------------------------------------------

inline void ApplyImportedPageStructures(
    CPDF_Document* dest_doc,
    CPDF_Document* src_doc,
    const std::vector<int>& source_indices,
    size_t insertion_index,
    bool duplicate_within_document) {
  if (!dest_doc || !src_doc || source_indices.empty()) return;

  CrossDocObjectMapping mapper(dest_doc, src_doc);
  std::map<int, int> src_to_dest_page_map;
  std::set<std::pair<const CPDF_Object*, const CPDF_Object*>> visited_pairs;

  if (duplicate_within_document) {
    const int src_total = src_doc->GetPageCount();
    const size_t dup_count = source_indices.size();

    // Map all surviving original pages (none are unselected in intra-doc duplicate!)
    for (int p = 0; p < src_total; ++p) {
      int dest_p = (p < static_cast<int>(insertion_index)) ? p : (p + static_cast<int>(dup_count));
      auto src_page = src_doc->GetPageDictionary(p);
      auto dest_page = dest_doc->GetPageDictionary(dest_p);
      if (src_page && dest_page) {
        mapper.MapPage(src_page->GetObjNum(), dest_page->GetObjNum());
        src_to_dest_page_map[p] = dest_p;
        PairImportedObjects(src_page.Get(), dest_page.Get(), &mapper, &visited_pairs);
      }
    }

    // Pair the newly duplicated pages
    for (size_t i = 0; i < dup_count; ++i) {
      int s_idx = source_indices[i];
      int d_idx = static_cast<int>(insertion_index + i);
      auto src_page = src_doc->GetPageDictionary(s_idx);
      auto dest_page = dest_doc->GetPageDictionary(d_idx);
      if (src_page && dest_page) {
        PairImportedObjects(src_page.Get(), dest_page.Get(), &mapper, &visited_pairs);
      }
    }
  } else {
    // Cross-document import / extraction: only selected source indices exist in destination
    for (size_t i = 0; i < source_indices.size(); ++i) {
      src_to_dest_page_map[source_indices[i]] = static_cast<int>(insertion_index + i);
      auto src_page = src_doc->GetPageDictionary(source_indices[i]);
      auto dest_page = dest_doc->GetPageDictionary(static_cast<int>(insertion_index + i));
      if (src_page && dest_page) {
        mapper.MapPage(src_page->GetObjNum(), dest_page->GetObjNum());
        PairImportedObjects(src_page.Get(), dest_page.Get(), &mapper, &visited_pairs);
      }
    }
    mapper.MarkUnselectedSourcePages(source_indices);
  }

  RemapImportedPageLinks(dest_doc, src_doc, src_to_dest_page_map, insertion_index, source_indices);
  if (!duplicate_within_document) {
    RemapImportedOutlines(dest_doc, src_doc, &mapper, src_to_dest_page_map);
  }
  RemapImportedWidgets(dest_doc, src_doc, &mapper, source_indices, insertion_index);
  RemapImportedTaggedStructure(dest_doc, src_doc, &mapper, source_indices, insertion_index);
}

inline void ExtractStructureForSelectedPages(
    CPDF_Document* dest_doc,
    CPDF_Document* src_doc,
    const std::vector<int>& indices) {
  ApplyImportedPageStructures(dest_doc, src_doc, indices, 0, false);
}

}  // namespace pdf_editor::structure

#endif  // PDF_EDITOR_PAGE_STRUCTURE_H_
