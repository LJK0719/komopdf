#include "form_fields.h"

#include <cmath>
#include <sstream>

#include "core/fpdfapi/page/cpdf_page.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfdoc/cpdf_generateap.h"
#include "core/fpdfdoc/cpdf_interactiveform.h"

namespace pdf_editor {
namespace {
bool ValidTarget(CPDF_Document* doc, CPDF_Page* page,
                 const WideString& name, const CFX_FloatRect& rect) {
  if (!doc || !page || page->GetDocument() != doc || !doc->GetRoot() ||
      name.IsEmpty() || name.Contains(L'.') || !std::isfinite(rect.left) ||
      !std::isfinite(rect.bottom) || !std::isfinite(rect.right) ||
      !std::isfinite(rect.top) || rect.Width() <= 0 || rect.Height() <= 0) {
    return false;
  }
  CPDF_InteractiveForm fields(doc);
  return fields.CountFields(name) == 0;
}

RetainPtr<CPDF_Dictionary> EnsureForm(CPDF_Document* doc) {
  auto root = doc->GetMutableRoot();
  auto form = root->GetMutableDictFor("AcroForm");
  if (!form) {
    form = doc->NewIndirect<CPDF_Dictionary>();
    root->SetNewFor<CPDF_Reference>("AcroForm", doc, form->GetObjNum());
  }
  return form;
}

RetainPtr<CPDF_Array> CopyArray(CPDF_Dictionary* dict, ByteStringView key) {
  auto existing = dict->GetArrayFor(key);
  auto copy = existing ? ToArray(existing->Clone()) : pdfium::MakeRetain<CPDF_Array>();
  dict->SetFor(ByteString(key), copy);
  return copy;
}

RetainPtr<CPDF_Dictionary> NewWidget(CPDF_Document* doc, CPDF_Page* page,
    const WideString& name, const CFX_FloatRect& rect, ByteStringView type) {
  auto widget = doc->NewIndirect<CPDF_Dictionary>();
  widget->SetNewFor<CPDF_Name>("Type", "Annot");
  widget->SetNewFor<CPDF_Name>("Subtype", "Widget");
  widget->SetNewFor<CPDF_Name>("FT", ByteString(type));
  widget->SetNewFor<CPDF_String>("T", name.AsStringView());
  widget->SetRectFor("Rect", rect);
  widget->SetNewFor<CPDF_Number>("F", 4);
  widget->SetNewFor<CPDF_Reference>("P", doc, page->GetDict()->GetObjNum());
  return widget;
}

void AttachWidget(CPDF_Document* doc, CPDF_Page* page,
                  CPDF_Dictionary* form, CPDF_Dictionary* widget) {
  CopyArray(form, "Fields")->AppendNew<CPDF_Reference>(doc, widget->GetObjNum());
  // /Annots 可能被多页共享，不能就地追加到共享数组。
  CopyArray(page->GetMutableDict().Get(), "Annots")
      ->AppendNew<CPDF_Reference>(doc, widget->GetObjNum());
}

RetainPtr<CPDF_Stream> CheckboxAppearance(CPDF_Document* doc,
                                        float width, float height, bool checked) {
  fxcrt::ostringstream content;
  content << "q\n1 g 0 0 " << width << ' ' << height << " re f\n"
          << "0 G 1 w 0.5 0.5 " << width - 1 << ' ' << height - 1 << " re S\n";
  if (checked) {
    content << "2 w " << width * 0.2f << ' ' << height * 0.5f << " m "
            << width * 0.42f << ' ' << height * 0.25f << " l "
            << width * 0.8f << ' ' << height * 0.8f << " l S\n";
  }
  content << "Q\n";
  auto stream = doc->NewIndirect<CPDF_Stream>(&content);
  auto dict = stream->GetMutableDict();
  dict->SetNewFor<CPDF_Name>("Type", "XObject");
  dict->SetNewFor<CPDF_Name>("Subtype", "Form");
  dict->SetRectFor("BBox", {0, 0, width, height});
  dict->SetMatrixFor("Matrix", CFX_Matrix());
  dict->SetNewFor<CPDF_Dictionary>("Resources");
  return stream;
}
}

RetainPtr<CPDF_Dictionary> CreateTextField(
    CPDF_Document* doc, CPDF_Page* page, const WideString& name,
    const CFX_FloatRect& rect, RetainPtr<CPDF_Dictionary> font) {
  if (!font || !ValidTarget(doc, page, name, rect)) return nullptr;
  auto form = EnsureForm(doc);
  auto original_dr = form->GetDictFor("DR");
  auto dr = original_dr ? ToDictionary(original_dr->Clone()) : pdfium::MakeRetain<CPDF_Dictionary>();
  auto original_fonts = dr->GetDictFor("Font");
  auto fonts = original_fonts ? ToDictionary(original_fonts->Clone()) : pdfium::MakeRetain<CPDF_Dictionary>();
  dr->SetFor("Font", fonts);
  form->SetFor("DR", dr);
  ByteString font_name;
  int suffix = 0;
  do { font_name = ByteString::Format("PdfEditorFont%d", ++suffix); }
  while (fonts->KeyExist(font_name.AsStringView()));
  if (font->IsInline()) doc->AddIndirectObject(font);
  fonts->SetNewFor<CPDF_Reference>(font_name, doc, font->GetObjNum());

  auto widget = NewWidget(doc, page, name, rect, "Tx");
  widget->SetNewFor<CPDF_String>("DA", "/" + font_name + " 12 Tf 0 g");
  widget->SetNewFor<CPDF_String>("V", "");
  CPDF_GenerateAP::GenerateFormAP(doc, widget.Get(), CPDF_GenerateAP::kTextField);
  auto appearance = widget->GetDictFor("AP");
  if (!appearance || !appearance->GetStreamFor("N")) return nullptr;
  AttachWidget(doc, page, form.Get(), widget.Get());
  return widget;
}

RetainPtr<CPDF_Dictionary> CreateCheckboxField(
    CPDF_Document* doc, CPDF_Page* page, const WideString& name,
    const CFX_FloatRect& rect, bool checked) {
  if (!ValidTarget(doc, page, name, rect) || rect.Width() < 2 || rect.Height() < 2) return nullptr;
  auto form = EnsureForm(doc);
  auto widget = NewWidget(doc, page, name, rect, "Btn");
  const char* state = checked ? "Yes" : "Off";
  widget->SetNewFor<CPDF_Name>("V", state);
  widget->SetNewFor<CPDF_Name>("AS", state);
  auto normal = widget->SetNewFor<CPDF_Dictionary>("AP")->SetNewFor<CPDF_Dictionary>("N");
  for (bool on : {false, true}) {
    auto stream = CheckboxAppearance(doc, rect.Width(), rect.Height(), on);
    normal->SetNewFor<CPDF_Reference>(on ? "Yes" : "Off", doc, stream->GetObjNum());
  }
  AttachWidget(doc, page, form.Get(), widget.Get());
  return widget;
}
}  // namespace pdf_editor
