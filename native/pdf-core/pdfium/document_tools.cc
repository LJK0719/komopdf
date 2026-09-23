#include "document_tools.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>
#include <set>
#include <sstream>
#include <utility>
#include <vector>

#include "constants/form_flags.h"
#include "core/fpdfapi/font/cpdf_font.h"
#include "core/fpdfapi/page/cpdf_annotcontext.h"
#include "core/fpdfapi/page/cpdf_docpagedata.h"
#include "core/fpdfapi/page/cpdf_page.h"
#include "core/fpdfapi/parser/cpdf_array.h"
#include "core/fpdfapi/parser/cpdf_boolean.h"
#include "core/fpdfapi/parser/cpdf_dictionary.h"
#include "core/fpdfapi/parser/cpdf_document.h"
#include "core/fpdfapi/parser/cpdf_name.h"
#include "core/fpdfapi/parser/cpdf_number.h"
#include "core/fpdfapi/parser/cpdf_object.h"
#include "core/fpdfapi/parser/cpdf_reference.h"
#include "core/fpdfapi/parser/cpdf_stream.h"
#include "core/fpdfapi/parser/cpdf_string.h"
#include "core/fpdfapi/parser/fpdf_parser_utility.h"
#include "core/fpdfdoc/cpdf_annot.h"
#include "core/fpdfdoc/cpdf_defaultappearance.h"
#include "core/fpdfdoc/cpdf_formcontrol.h"
#include "core/fpdfdoc/cpdf_formfield.h"
#include "core/fpdfdoc/cpdf_generateap.h"
#include "core/fpdfdoc/cpdf_interactiveform.h"
#include "core/fxcrt/bytestring.h"
#include "core/fxcrt/fx_string_wrappers.h"
#include "core/fxcrt/retain_ptr.h"
#include "core/fxcrt/widestring.h"
#include "fpdfsdk/cpdfsdk_formfillenvironment.h"
#include "fpdfsdk/cpdfsdk_helpers.h"
#include "fpdfsdk/cpdfsdk_interactiveform.h"
#include "fpdfsdk/cpdfsdk_pageview.h"
#include "fpdfsdk/cpdfsdk_widget.h"
#include "public/fpdf_annot.h"
#include "public/fpdf_formfill.h"

namespace pdf_editor {
namespace {

constexpr char kFieldIdKey[] = "KomoFieldId";

bool Fail(std::string* error, const char* message) {
  if (error) {
    *error = message;
  }
  return false;
}

bool DecodeUtf8(const std::string& value,
                bool allow_empty,
                WideString* decoded,
                std::string* error,
                const char* label) {
  if ((!allow_empty && value.empty()) || value.find('\0') != std::string::npos) {
    if (error) {
      *error = std::string(label) + " must be a non-empty UTF-8 string.";
    }
    return false;
  }
  WideString wide = WideString::FromUTF8(ByteStringView(value.data(), value.size()));
  const ByteString round_trip = wide.ToUTF8();
  const auto bytes = round_trip.AsStringView().span();
  if (bytes.size() != value.size() ||
      !std::equal(bytes.begin(), bytes.end(), value.begin())) {
    if (error) {
      *error = std::string(label) + " must be valid UTF-8.";
    }
    return false;
  }
  *decoded = std::move(wide);
  return true;
}

bool IsFiniteFloat(double value) {
  return std::isfinite(value) &&
         std::abs(value) <= std::numeric_limits<float>::max();
}

bool ValidPoint(const PdfPoint& point) {
  return IsFiniteFloat(point.x) && IsFiniteFloat(point.y);
}

bool ValidRect(const PdfRect& rect) {
  return IsFiniteFloat(rect.left) && IsFiniteFloat(rect.bottom) &&
         IsFiniteFloat(rect.right) && IsFiniteFloat(rect.top) &&
         rect.left < rect.right && rect.bottom < rect.top;
}

bool ValidColor(const RgbColor& color) {
  return std::isfinite(color.red) && std::isfinite(color.green) &&
         std::isfinite(color.blue) && color.red >= 0 && color.red <= 1 &&
         color.green >= 0 && color.green <= 1 && color.blue >= 0 &&
         color.blue <= 1;
}

unsigned int ColorByte(double component) {
  return static_cast<unsigned int>(std::lround(component * 255));
}

FS_RECTF ToFsRect(const PdfRect& rect) {
  return {static_cast<float>(rect.left), static_cast<float>(rect.top),
          static_cast<float>(rect.right), static_cast<float>(rect.bottom)};
}

CFX_FloatRect ToCfxRect(const PdfRect& rect) {
  return {static_cast<float>(rect.left), static_cast<float>(rect.bottom),
          static_cast<float>(rect.right), static_cast<float>(rect.top)};
}

class ScopedCreatedAnnotation {
 public:
  ScopedCreatedAnnotation(FPDF_PAGE page, FPDF_ANNOTATION annotation)
      : page_(page), annotation_(annotation) {}
  ~ScopedCreatedAnnotation() {
    if (!annotation_) {
      return;
    }
    const int index = FPDFPage_GetAnnotIndex(page_, annotation_);
    FPDFPage_CloseAnnot(annotation_);
    if (!committed_ && index >= 0) {
      FPDFPage_RemoveAnnot(page_, index);
    }
  }

  FPDF_ANNOTATION get() const { return annotation_; }
  void Commit() { committed_ = true; }

 private:
  FPDF_PAGE const page_;
  FPDF_ANNOTATION const annotation_;
  bool committed_ = false;
};

FPDF_ANNOTATION_SUBTYPE PublicAnnotationSubtype(AnnotationType type) {
  switch (type) {
    case AnnotationType::kHighlight:
      return FPDF_ANNOT_HIGHLIGHT;
    case AnnotationType::kText:
      return FPDF_ANNOT_TEXT;
    case AnnotationType::kRectangle:
      return FPDF_ANNOT_SQUARE;
    case AnnotationType::kInk:
      return FPDF_ANNOT_INK;
  }
  return FPDF_ANNOT_UNKNOWN;
}

PdfRect BoundsForPoints(const std::vector<PdfPoint>& points) {
  PdfRect bounds{points.front().x, points.front().y, points.front().x,
                 points.front().y};
  for (const PdfPoint& point : points) {
    bounds.left = std::min(bounds.left, point.x);
    bounds.bottom = std::min(bounds.bottom, point.y);
    bounds.right = std::max(bounds.right, point.x);
    bounds.top = std::max(bounds.top, point.y);
  }
  return bounds;
}

bool AnnotationIdExists(CPDF_Document* document, const WideString& id) {
  for (int page_index = 0; page_index < document->GetPageCount(); ++page_index) {
    RetainPtr<const CPDF_Dictionary> page =
        document->GetPageDictionary(page_index);
    RetainPtr<const CPDF_Array> annotations =
        page ? page->GetArrayFor("Annots") : nullptr;
    if (!annotations) {
      continue;
    }
    for (size_t index = 0; index < annotations->size(); ++index) {
      RetainPtr<const CPDF_Dictionary> annotation = annotations->GetDictAt(index);
      if (annotation && annotation->GetUnicodeTextFor("NM") == id) {
        return true;
      }
    }
  }
  return false;
}

bool HasNormalStream(const CPDF_Dictionary* dictionary) {
  RetainPtr<const CPDF_Dictionary> ap = dictionary->GetDictFor("AP");
  RetainPtr<const CPDF_Stream> normal = ap ? ap->GetStreamFor("N") : nullptr;
  return normal && normal->GetRawSize() > 0;
}

bool GenerateTextNoteAppearance(CPDF_Document* document,
                                CPDF_Dictionary* annotation,
                                const RgbColor& color,
                                double opacity) {
  CFX_FloatRect rect = annotation->GetRectFor("Rect");
  constexpr float kNoteSize = 20;
  rect.right = rect.left + kNoteSize;
  rect.top = rect.bottom + kNoteSize;
  annotation->SetRectFor("Rect", rect);

  // Keep the pinned PDFium note shape, but make its fill and graphics-state
  // alpha come from AnnotationSpec instead of GenerateTextAP's fixed yellow.
  constexpr float kBorderWidth = 1;
  constexpr float kHalfBorderWidth = kBorderWidth / 2;
  constexpr float kTipDelta = 4;
  const float outer_left = rect.left + kHalfBorderWidth;
  const float outer_right = rect.right - kHalfBorderWidth;
  const float outer_bottom = rect.bottom + kHalfBorderWidth + kTipDelta;
  const float outer_top = rect.top - kHalfBorderWidth;
  const float tip_left = outer_left + kTipDelta;
  const float tip_right = tip_left + kTipDelta;
  const float tip_bottom = outer_bottom - kTipDelta;
  const float tip_middle = (tip_left + tip_right) / 2;

  fxcrt::ostringstream content;
  content << "q\n/GS gs\n" << static_cast<float>(color.red) << " "
          << static_cast<float>(color.green) << " "
          << static_cast<float>(color.blue) << " rg\n"
          << "0 0 0 RG\n" << kBorderWidth << " w\n"
          << outer_left << " " << outer_bottom << " m\n"
          << outer_left << " " << outer_top << " l\n"
          << outer_right << " " << outer_top << " l\n"
          << outer_right << " " << outer_bottom << " l\n"
          << tip_right << " " << outer_bottom << " l\n"
          << tip_middle << " " << tip_bottom << " l\n"
          << tip_left << " " << outer_bottom << " l\n"
          << outer_left << " " << outer_bottom << " l\n";

  float line_top = outer_top;
  const float line_left = outer_left + 2;
  const float line_right = outer_right - 2;
  const float line_delta = (outer_top - outer_bottom) / 4;
  for (int line = 0; line < 3; ++line) {
    line_top -= line_delta;
    content << line_left << " " << line_top << " m\n"
            << line_right << " " << line_top << " l\n";
  }
  content << "B*\nQ\n";

  auto stream_dictionary = document->New<CPDF_Dictionary>();
  stream_dictionary->SetNewFor<CPDF_Number>("FormType", 1);
  stream_dictionary->SetNewFor<CPDF_Name>("Type", "XObject");
  stream_dictionary->SetNewFor<CPDF_Name>("Subtype", "Form");
  stream_dictionary->SetMatrixFor("Matrix", CFX_Matrix());
  stream_dictionary->SetRectFor("BBox", rect);
  RetainPtr<CPDF_Dictionary> resources =
      stream_dictionary->SetNewFor<CPDF_Dictionary>("Resources");
  RetainPtr<CPDF_Dictionary> ext_gstates =
      resources->SetNewFor<CPDF_Dictionary>("ExtGState");
  RetainPtr<CPDF_Dictionary> graphics_state =
      ext_gstates->SetNewFor<CPDF_Dictionary>("GS");
  graphics_state->SetNewFor<CPDF_Name>("Type", "ExtGState");
  graphics_state->SetNewFor<CPDF_Number>("CA", static_cast<float>(opacity));
  graphics_state->SetNewFor<CPDF_Number>("ca", static_cast<float>(opacity));
  graphics_state->SetNewFor<CPDF_Boolean>("AIS", false);
  graphics_state->SetNewFor<CPDF_Name>("BM", "Normal");

  RetainPtr<CPDF_Stream> stream =
      document->NewIndirect<CPDF_Stream>(std::move(stream_dictionary));
  stream->SetDataFromStringstream(&content);
  annotation->GetOrCreateDictFor("AP")->SetNewFor<CPDF_Reference>(
      "N", document, stream->GetObjNum());
  return HasNormalStream(annotation);
}

RetainPtr<CPDF_Array> ShallowCopyArray(const CPDF_Array* source) {
  auto result = pdfium::MakeRetain<CPDF_Array>();
  if (!source) {
    return result;
  }
  for (size_t index = 0; index < source->size(); ++index) {
    RetainPtr<const CPDF_Object> object = source->GetObjectAt(index);
    if (object) {
      result->Append(pdfium::WrapRetain(const_cast<CPDF_Object*>(object.Get())));
    }
  }
  return result;
}

RetainPtr<CPDF_Dictionary> EnsureAcroForm(CPDF_Document* document) {
  RetainPtr<CPDF_Dictionary> root = document->GetMutableRoot();
  if (!root) {
    return nullptr;
  }
  RetainPtr<CPDF_Dictionary> form = root->GetMutableDictFor("AcroForm");
  if (form) {
    return form;
  }
  form = document->NewIndirect<CPDF_Dictionary>();
  root->SetNewFor<CPDF_Reference>("AcroForm", document, form->GetObjNum());
  return form;
}

CPDF_FormField* FindExactField(CPDF_InteractiveForm* form,
                               const WideString& full_name,
                               size_t* match_count = nullptr) {
  CPDF_FormField* found = nullptr;
  size_t matches = 0;
  const size_t count = form->CountFields(WideString());
  for (size_t index = 0; index < count; ++index) {
    CPDF_FormField* candidate = form->GetField(index, WideString());
    if (candidate && candidate->GetFullName() == full_name) {
      found = candidate;
      ++matches;
    }
  }
  if (match_count) {
    *match_count = matches;
  }
  return matches == 1 ? found : nullptr;
}

bool FieldIdExists(CPDF_InteractiveForm* form, const WideString& id) {
  const size_t count = form->CountFields(WideString());
  for (size_t index = 0; index < count; ++index) {
    CPDF_FormField* field = form->GetField(index, WideString());
    RetainPtr<const CPDF_Dictionary> dictionary =
        field ? field->GetFieldDict() : nullptr;
    if (dictionary && dictionary->GetUnicodeTextFor(kFieldIdKey) == id) {
      return true;
    }
  }
  return false;
}

ByteString MakeDefaultAppearance(const ByteString& font_alias,
                                 double font_size,
                                 const RgbColor& color) {
  fxcrt::ostringstream stream;
  stream << "/" << PDF_NameEncode(font_alias) << " "
         << static_cast<float>(font_size) << " Tf "
         << static_cast<float>(color.red) << " "
         << static_cast<float>(color.green) << " "
         << static_cast<float>(color.blue) << " rg";
  return ByteString(stream);
}

RetainPtr<CPDF_Font> ResolveFont(CPDF_Document* document,
                                CPDF_Dictionary* acroform,
                                CPDF_Dictionary* field_or_widget,
                                ByteString* alias) {
  CPDF_DefaultAppearance appearance(field_or_widget, acroform);
  auto font_and_size = appearance.GetFont();
  if (!font_and_size.has_value() || font_and_size->name.IsEmpty()) {
    return nullptr;
  }
  *alias = font_and_size->name;

  RetainPtr<CPDF_Dictionary> resources;
  if (field_or_widget) {
    resources = ToDictionary(CPDF_FormField::GetMutableFieldAttrForDict(
        field_or_widget, "DR"));
  }
  if (!resources && acroform) {
    resources = acroform->GetMutableDictFor("DR");
  }
  RetainPtr<CPDF_Dictionary> fonts =
      resources ? resources->GetMutableDictFor("Font") : nullptr;
  RetainPtr<CPDF_Dictionary> font_dictionary =
      fonts ? fonts->GetMutableDictFor(alias->AsStringView()) : nullptr;
  if (!font_dictionary && field_or_widget) {
    RetainPtr<CPDF_Dictionary> page =
        field_or_widget->GetMutableDictFor("P");
    RetainPtr<CPDF_Dictionary> page_resources =
        page ? ToDictionary(CPDF_FormField::GetMutableFieldAttrForDict(
                   page.Get(), "Resources"))
             : nullptr;
    RetainPtr<CPDF_Dictionary> page_fonts =
        page_resources ? page_resources->GetMutableDictFor("Font") : nullptr;
    font_dictionary =
        page_fonts ? page_fonts->GetMutableDictFor(alias->AsStringView())
                   : nullptr;
  }
  if (!font_dictionary) {
    return nullptr;
  }
  return CPDF_DocPageData::FromDocument(document)->GetFont(
      std::move(font_dictionary));
}

bool FontCovers(const CPDF_Font* font,
                const WideString& text,
                std::string* error) {
  if (!font) {
    return Fail(error, "The field has no usable default font in /DA and /DR.");
  }
  for (size_t index = 0; index < text.GetLength(); ++index) {
    const uint32_t code_point = static_cast<uint32_t>(text[index]);
    if (code_point == '\r' || code_point == '\n') {
      continue;
    }
    if (code_point > 0xffff || (code_point >= 0xd800 && code_point <= 0xdfff)) {
      return Fail(error,
                  "PDFium form appearance generation does not support this "
                  "supplementary character.");
    }
    const uint32_t char_code =
        font->CharCodeFromUnicode(static_cast<wchar_t>(code_point));
    const WideString round_trip =
        char_code == CPDF_Font::kInvalidCharCode
            ? WideString()
            : font->UnicodeFromCharCode(char_code);
    if (char_code == CPDF_Font::kInvalidCharCode ||
        (char_code == 0 && code_point != 0) || round_trip.GetLength() != 1 ||
        static_cast<uint32_t>(round_trip.Front()) != code_point) {
      return Fail(error,
                  "The field default font cannot encode every appearance "
                  "character; register and pass a suitable PDF font.");
    }
  }
  return true;
}

bool ValidateAppearanceFonts(CPDF_Document* document,
                             CPDF_FormField* field,
                             const std::vector<WideString>& texts,
                             std::string* error) {
  RetainPtr<CPDF_Dictionary> acroform =
      document->GetMutableRoot()->GetMutableDictFor("AcroForm");
  if (!acroform || field->CountControls() == 0) {
    return Fail(error, "The field has no usable AcroForm widget.");
  }
  for (int index = 0; index < field->CountControls(); ++index) {
    CPDF_FormControl* control = field->GetControl(index);
    RetainPtr<const CPDF_Dictionary> const_widget =
        control ? control->GetWidgetDict() : nullptr;
    CPDF_Dictionary* widget =
        const_cast<CPDF_Dictionary*>(const_widget.Get());
    ByteString alias;
    RetainPtr<CPDF_Font> font =
        widget ? ResolveFont(document, acroform.Get(), widget, &alias) : nullptr;
    if (!font) {
      return Fail(error,
                  "The field widget has no usable default font in /DA and /DR.");
    }
    for (const WideString& text : texts) {
      if (!FontCovers(font.Get(), text, error)) {
        return false;
      }
    }
  }
  return true;
}

int FindWidgetPageIndex(CPDF_Document* document,
                        const CPDF_Dictionary* widget) {
  RetainPtr<const CPDF_Dictionary> declared_page = widget->GetDictFor("P");
  if (declared_page) {
    const int page_index = document->GetPageIndex(declared_page->GetObjNum());
    if (page_index >= 0) {
      return page_index;
    }
  }
  for (int page_index = 0; page_index < document->GetPageCount(); ++page_index) {
    RetainPtr<const CPDF_Dictionary> page =
        document->GetPageDictionary(page_index);
    RetainPtr<const CPDF_Array> annotations =
        page ? page->GetArrayFor("Annots") : nullptr;
    if (!annotations) {
      continue;
    }
    for (size_t index = 0; index < annotations->size(); ++index) {
      if (annotations->GetDirectObjectAt(index).Get() == widget) {
        return page_index;
      }
    }
  }
  return -1;
}

struct LoadedPageView {
  int page_index = -1;
  RetainPtr<CPDF_Page> page;
  CPDFSDK_PageView* view = nullptr;
};

bool FieldAppearancesAreComplete(CPDF_FormField* field) {
  const bool is_button = field->GetType() == CPDF_FormField::kCheckBox ||
                         field->GetType() == CPDF_FormField::kRadioButton;
  for (int index = 0; index < field->CountControls(); ++index) {
    CPDF_FormControl* control = field->GetControl(index);
    RetainPtr<const CPDF_Dictionary> widget =
        control ? control->GetWidgetDict() : nullptr;
    RetainPtr<const CPDF_Dictionary> ap =
        widget ? widget->GetDictFor("AP") : nullptr;
    if (!is_button) {
      if (!ap || !ap->GetStreamFor("N")) {
        return false;
      }
      continue;
    }
    RetainPtr<const CPDF_Dictionary> normal =
        ap ? ap->GetDictFor("N") : nullptr;
    const ByteString state = widget ? widget->GetNameFor("AS") : ByteString();
    const ByteString on_state =
        control ? control->GetCheckedAPState() : ByteString();
    RetainPtr<const CPDF_Stream> on =
        normal ? normal->GetStreamFor(on_state.AsStringView()) : nullptr;
    RetainPtr<const CPDF_Stream> off =
        normal ? normal->GetStreamFor("Off") : nullptr;
    if (state.IsEmpty() || !on || !off || on->GetRawSize() == 0 ||
        off->GetRawSize() == 0 ||
        !normal->GetStreamFor(state.AsStringView())) {
      return false;
    }
  }
  return field->CountControls() > 0;
}

bool ResetFieldAppearances(CPDF_Document* document,
                            const WideString& field_name,
                            std::string* error) {
  // Pages must outlive the SDK environment and its page views.
  std::vector<LoadedPageView> loaded_pages;
  FPDF_FORMFILLINFO form_fill_info{};
  form_fill_info.version = 2;
  form_fill_info.xfa_disabled = true;
  CPDFSDK_FormFillEnvironment environment(document, &form_fill_info);
  CPDFSDK_InteractiveForm* sdk_form = environment.GetInteractiveForm();
  CPDF_InteractiveForm* form = sdk_form->GetInteractiveForm();
  CPDF_FormField* field = FindExactField(form, field_name);
  if (!field || field->CountControls() == 0) {
    return Fail(error, "The form field has no usable widget.");
  }

  std::vector<CPDFSDK_Widget*> widgets;
  widgets.reserve(field->CountControls());
  for (int control_index = 0; control_index < field->CountControls();
       ++control_index) {
    CPDF_FormControl* control = field->GetControl(control_index);
    RetainPtr<const CPDF_Dictionary> widget_dictionary =
        control ? control->GetWidgetDict() : nullptr;
    if (!widget_dictionary) {
      return Fail(error, "The form field contains an invalid widget.");
    }
    const int page_index =
        FindWidgetPageIndex(document, widget_dictionary.Get());
    if (page_index < 0) {
      return Fail(error, "A form widget is not attached to a document page.");
    }

    CPDFSDK_PageView* page_view = nullptr;
    for (LoadedPageView& loaded : loaded_pages) {
      if (loaded.page_index == page_index) {
        page_view = loaded.view;
        break;
      }
    }
    if (!page_view) {
      RetainPtr<CPDF_Dictionary> page_dictionary =
          document->GetMutablePageDictionary(page_index);
      if (!page_dictionary || !CPDF_Page::IsValidPageDictLoose(page_dictionary.Get())) {
        return Fail(error, "A form widget page is invalid.");
      }
      LoadedPageView loaded;
      loaded.page_index = page_index;
      loaded.page =
          pdfium::MakeRetain<CPDF_Page>(document, std::move(page_dictionary));
      loaded.view = environment.GetOrCreatePageView(loaded.page.Get());
      page_view = loaded.view;
      loaded_pages.push_back(std::move(loaded));
    }

    CPDFSDK_Widget* widget = ToCPDFSDKWidget(
        page_view->GetAnnotByDict(widget_dictionary.Get()));
    if (!widget) {
      return Fail(error, "PDFium could not load a form widget appearance.");
    }
    widgets.push_back(widget);
  }

  for (CPDFSDK_Widget* widget : widgets) {
    widget->ResetAppearance(std::nullopt, CPDFSDK_Widget::kValueChanged);
  }
  return FieldAppearancesAreComplete(field) ||
         Fail(error, "PDFium could not generate complete field appearances.");
}

RetainPtr<CPDF_Dictionary> NewWidget(CPDF_Document* document,
                                     CPDF_Page* page,
                                     const WideString& name,
                                     const WideString& persistent_id,
                                     const CFX_FloatRect& rect,
                                     int rotation,
                                     ByteStringView field_type) {
  if (page->GetDict()->GetObjNum() == 0) {
    return nullptr;
  }
  RetainPtr<CPDF_Dictionary> widget =
      document->NewIndirect<CPDF_Dictionary>();
  widget->SetNewFor<CPDF_Name>("Type", "Annot");
  widget->SetNewFor<CPDF_Name>("Subtype", "Widget");
  widget->SetNewFor<CPDF_Name>("FT", ByteString(field_type));
  widget->SetNewFor<CPDF_String>("T", name.AsStringView());
  widget->SetNewFor<CPDF_String>(kFieldIdKey, persistent_id.AsStringView());
  widget->SetRectFor("Rect", rect);
  widget->SetNewFor<CPDF_Number>("F", FPDF_ANNOT_FLAG_PRINT);
  widget->SetNewFor<CPDF_Reference>("P", document,
                                    page->GetDict()->GetObjNum());

  RetainPtr<CPDF_Dictionary> border =
      widget->SetNewFor<CPDF_Dictionary>("BS");
  border->SetNewFor<CPDF_Number>("W", 1.0f);
  border->SetNewFor<CPDF_Name>("S", "S");

  RetainPtr<CPDF_Dictionary> appearance =
      widget->SetNewFor<CPDF_Dictionary>("MK");
  appearance->SetNewFor<CPDF_Number>("R", rotation);
  RetainPtr<CPDF_Array> border_color =
      appearance->SetNewFor<CPDF_Array>("BC");
  border_color->AppendNew<CPDF_Number>(0.0f);
  border_color->AppendNew<CPDF_Number>(0.0f);
  border_color->AppendNew<CPDF_Number>(0.0f);
  RetainPtr<CPDF_Array> background =
      appearance->SetNewFor<CPDF_Array>("BG");
  background->AppendNew<CPDF_Number>(1.0f);
  background->AppendNew<CPDF_Number>(1.0f);
  background->AppendNew<CPDF_Number>(1.0f);
  return widget;
}

void AttachWidget(CPDF_Document* document,
                  CPDF_Page* page,
                  CPDF_Dictionary* acroform,
                  CPDF_Dictionary* widget) {
  RetainPtr<CPDF_Array> fields =
      ShallowCopyArray(acroform->GetArrayFor("Fields").Get());
  fields->AppendNew<CPDF_Reference>(document, widget->GetObjNum());
  acroform->SetFor("Fields", std::move(fields));

  RetainPtr<CPDF_Array> annotations =
      ShallowCopyArray(page->GetDict()->GetArrayFor("Annots").Get());
  annotations->AppendNew<CPDF_Reference>(document, widget->GetObjNum());
  page->GetMutableDict()->SetFor("Annots", std::move(annotations));
}

bool AddFontToDefaultResources(CPDF_Document* document,
                               CPDF_Dictionary* acroform,
                               FPDF_FONT font_handle,
                               ByteString* alias,
                               RetainPtr<CPDF_Font>* font,
                               std::string* error) {
  CPDF_Font* native_font = CPDFFontFromFPDFFont(font_handle);
  if (!native_font) {
    return Fail(error, "The supplied form font handle is invalid.");
  }
  RetainPtr<CPDF_Dictionary> font_dictionary =
      native_font->GetMutableFontDict();
  if (!font_dictionary) {
    return Fail(error, "The supplied form font has no PDF font dictionary.");
  }
  CPDF_Document* font_document = native_font->GetDocument();
  if ((font_document && font_document != document) ||
      (!font_document && !font_dictionary->IsInline())) {
    return Fail(error,
                "The form font must already be loaded into this document.");
  }
  if (font_dictionary->IsInline()) {
    font_dictionary = ToDictionary(font_dictionary->Clone());
    if (!font_dictionary) {
      return Fail(error, "The supplied form font could not be cloned.");
    }
    document->AddIndirectObject(font_dictionary);
  }
  if (font_dictionary->GetObjNum() == 0) {
    return Fail(error, "The supplied form font could not be made indirect.");
  }

  RetainPtr<CPDF_Dictionary> resources =
      acroform->GetOrCreateDictFor("DR");
  RetainPtr<CPDF_Dictionary> fonts = resources->GetOrCreateDictFor("Font");
  int suffix = 1;
  do {
    *alias = ByteString::Format("KomoFormFont%d", suffix++);
  } while (fonts->KeyExist(alias->AsStringView()));
  fonts->SetNewFor<CPDF_Reference>(*alias, document,
                                   font_dictionary->GetObjNum());
  *font = CPDF_DocPageData::FromDocument(document)->GetFont(
      std::move(font_dictionary));
  return *font || Fail(error, "The supplied form font could not be loaded.");
}

std::vector<WideString> ChoiceAppearanceTexts(CPDF_FormField* field) {
  std::vector<WideString> result;
  if (field->GetType() == CPDF_FormField::kListBox) {
    result.reserve(field->CountOptions());
    for (int index = 0; index < field->CountOptions(); ++index) {
      result.push_back(field->GetOptionLabel(index));
    }
    return result;
  }
  if (field->GetType() == CPDF_FormField::kComboBox) {
    const int selected = field->GetSelectedIndex(0);
    result.push_back(selected >= 0 ? field->GetOptionLabel(selected)
                                   : field->GetValue());
  }
  return result;
}

}  // namespace

bool AddAnnotation(FPDF_DOCUMENT document_handle,
                   FPDF_PAGE page_handle,
                   const AnnotationSpec& spec,
                   std::string* error) {
  if (error) {
    error->clear();
  }
  CPDF_Document* document = CPDFDocumentFromFPDFDocument(document_handle);
  CPDF_Page* page = CPDFPageFromFPDFPage(page_handle);
  if (!document || !page || page->GetDocument() != document) {
    return Fail(error, "The annotation target document or page is invalid.");
  }

  WideString persistent_id;
  WideString contents;
  if (!DecodeUtf8(spec.persistent_id, false, &persistent_id, error,
                  "Annotation persistent_id") ||
      !DecodeUtf8(spec.contents_utf8, true, &contents, error,
                  "Annotation contents_utf8")) {
    return false;
  }
  if (AnnotationIdExists(document, persistent_id)) {
    return Fail(error, "Annotation persistent_id already exists.");
  }
  if (!ValidColor(spec.color) || !std::isfinite(spec.opacity) ||
      spec.opacity < 0 || spec.opacity > 1) {
    return Fail(error, "Annotation color and opacity must be within [0, 1].");
  }
  if ((spec.type == AnnotationType::kRectangle ||
       spec.type == AnnotationType::kInk) &&
      (!std::isfinite(spec.stroke_width) || spec.stroke_width <= 0 ||
       spec.stroke_width > std::numeric_limits<float>::max())) {
    return Fail(error, "Rectangle and ink stroke_width must be positive.");
  }

  PdfRect annotation_rect = spec.rect;
  if (spec.type == AnnotationType::kHighlight) {
    if (spec.quad_points.empty()) {
      return Fail(error, "A highlight annotation requires QuadPoints.");
    }
    std::vector<PdfPoint> points;
    points.reserve(spec.quad_points.size() * 4);
    for (const AnnotationQuad& quad : spec.quad_points) {
      for (const PdfPoint& point : {quad.p1, quad.p2, quad.p3, quad.p4}) {
        if (!ValidPoint(point)) {
          return Fail(error, "Highlight QuadPoints must be finite.");
        }
        points.push_back(point);
      }
    }
    annotation_rect = BoundsForPoints(points);
  } else if (spec.type == AnnotationType::kInk) {
    if (spec.ink_strokes.empty()) {
      return Fail(error, "An ink annotation requires at least one stroke.");
    }
    std::vector<PdfPoint> points;
    for (const std::vector<PdfPoint>& stroke : spec.ink_strokes) {
      if (stroke.size() < 2) {
        return Fail(error, "Every ink stroke requires at least two points.");
      }
      for (const PdfPoint& point : stroke) {
        if (!ValidPoint(point)) {
          return Fail(error, "Ink stroke points must be finite.");
        }
        points.push_back(point);
      }
    }
    annotation_rect = BoundsForPoints(points);
    const double half_width = spec.stroke_width / 2;
    if (annotation_rect.left == annotation_rect.right) {
      annotation_rect.left -= half_width;
      annotation_rect.right += half_width;
    }
    if (annotation_rect.bottom == annotation_rect.top) {
      annotation_rect.bottom -= half_width;
      annotation_rect.top += half_width;
    }
  }
  if (!ValidRect(annotation_rect)) {
    return Fail(error, "The annotation rectangle must have positive area.");
  }

  const FPDF_ANNOTATION_SUBTYPE subtype = PublicAnnotationSubtype(spec.type);
  FPDF_ANNOTATION raw_annotation =
      FPDFPage_CreateAnnot(page_handle, subtype);
  if (!raw_annotation) {
    return Fail(error, "PDFium could not create the requested annotation.");
  }
  ScopedCreatedAnnotation annotation(page_handle, raw_annotation);
  CPDF_AnnotContext* context =
      CPDFAnnotContextFromFPDFAnnotation(annotation.get());
  RetainPtr<CPDF_Dictionary> dictionary =
      context ? context->GetMutableAnnotDict() : nullptr;
  if (!dictionary) {
    return Fail(error, "PDFium returned an invalid annotation dictionary.");
  }

  const FS_RECTF rect = ToFsRect(annotation_rect);
  if (!FPDFAnnot_SetRect(annotation.get(), &rect) ||
      !FPDFAnnot_SetFlags(annotation.get(), FPDF_ANNOT_FLAG_PRINT) ||
      !FPDFAnnot_SetColor(annotation.get(), FPDFANNOT_COLORTYPE_Color,
                          ColorByte(spec.color.red), ColorByte(spec.color.green),
                          ColorByte(spec.color.blue), ColorByte(spec.opacity))) {
    return Fail(error, "PDFium could not set annotation geometry or color.");
  }
  dictionary->SetNewFor<CPDF_String>("NM", persistent_id.AsStringView());
  dictionary->SetNewFor<CPDF_String>("Contents", contents.AsStringView());

  if (spec.type == AnnotationType::kHighlight) {
    for (const AnnotationQuad& quad : spec.quad_points) {
      const FS_QUADPOINTSF points{
          static_cast<float>(quad.p1.x), static_cast<float>(quad.p1.y),
          static_cast<float>(quad.p2.x), static_cast<float>(quad.p2.y),
          static_cast<float>(quad.p3.x), static_cast<float>(quad.p3.y),
          static_cast<float>(quad.p4.x), static_cast<float>(quad.p4.y)};
      if (!FPDFAnnot_AppendAttachmentPoints(annotation.get(), &points)) {
        return Fail(error, "PDFium could not append highlight QuadPoints.");
      }
    }
  } else if (spec.type == AnnotationType::kInk) {
    for (const std::vector<PdfPoint>& stroke : spec.ink_strokes) {
      std::vector<FS_POINTF> points;
      points.reserve(stroke.size());
      for (const PdfPoint& point : stroke) {
        points.push_back(
            {static_cast<float>(point.x), static_cast<float>(point.y)});
      }
      if (FPDFAnnot_AddInkStroke(annotation.get(), points.data(), points.size()) <
          0) {
        return Fail(error, "PDFium could not append an ink stroke.");
      }
    }
  }
  if (spec.type == AnnotationType::kRectangle ||
      spec.type == AnnotationType::kInk) {
    if (!FPDFAnnot_SetBorder(annotation.get(), 0, 0,
                             static_cast<float>(spec.stroke_width))) {
      return Fail(error, "PDFium could not set the annotation border.");
    }
  }

  const bool generated =
      spec.type == AnnotationType::kText
          ? GenerateTextNoteAppearance(document, dictionary.Get(), spec.color,
                                       spec.opacity)
          : CPDF_GenerateAP::GenerateAnnotAP(
                document, dictionary.Get(),
                static_cast<CPDF_Annot::Subtype>(subtype));
  if (!generated || !HasNormalStream(dictionary.Get())) {
    return Fail(error,
                "PDFium could not generate a persistent annotation appearance.");
  }
  annotation.Commit();
  return true;
}

bool CreateFormField(FPDF_DOCUMENT document_handle,
                     FPDF_PAGE page_handle,
                     const FormFieldSpec& spec,
                     std::string* error) {
  if (error) {
    error->clear();
  }
  CPDF_Document* document = CPDFDocumentFromFPDFDocument(document_handle);
  CPDF_Page* page = CPDFPageFromFPDFPage(page_handle);
  if (!document || !page || page->GetDocument() != document ||
      !document->GetRoot()) {
    return Fail(error, "The form field target document or page is invalid.");
  }
  if (!ValidRect(spec.rect)) {
    return Fail(error, "The form field rectangle must have positive area.");
  }
  const bool choice = spec.type == FormFieldType::kComboBox ||
                      spec.type == FormFieldType::kListBox;
  const bool radio = spec.type == FormFieldType::kRadioButton;
  if (spec.type != FormFieldType::kText &&
      spec.type != FormFieldType::kCheckbox && !choice && !radio) {
    return Fail(error, "Unsupported form field type.");
  }
  if ((choice && (spec.options_utf8.empty() || !spec.font)) ||
      (radio && spec.options_utf8.empty()) ||
      (!choice && !radio && !spec.options_utf8.empty())) {
    return Fail(error, "Choice and radio fields require options; choice fields "
                       "also require an embedded font.");
  }
  if (radio && spec.checked) {
    return Fail(error, "A radio field selects an option via "
                       "initial_value_utf8, not checked.");
  }
  if (spec.rotation != 0 && spec.rotation != 90 && spec.rotation != 180 &&
      spec.rotation != 270) {
    return Fail(error, "Form field rotation must be 0, 90, 180, or 270.");
  }

  WideString persistent_id;
  WideString name;
  WideString initial_value;
  if (!DecodeUtf8(spec.persistent_id, false, &persistent_id, error,
                  "Form field persistent_id") ||
      !DecodeUtf8(spec.name_utf8, false, &name, error,
                  "Form field name_utf8") ||
      !DecodeUtf8(spec.initial_value_utf8, true, &initial_value, error,
                  "Form field initial_value_utf8")) {
    return false;
  }
  if (name.Contains(L'.')) {
    return Fail(error,
                "New top-level field names cannot contain hierarchy dots.");
  }
  std::vector<WideString> choices;
  int selected_index = radio ? -1 : 0;
  if (choice || radio) {
    choices.reserve(spec.options_utf8.size());
    for (const auto& value : spec.options_utf8) {
      WideString option;
      if (!DecodeUtf8(value, false, &option, error,
                      radio ? "Radio option" : "Choice option") ||
          std::find(choices.begin(), choices.end(), option) != choices.end()) {
        if (error && error->empty()) *error = "Form field options must be distinct.";
        return false;
      }
      choices.push_back(std::move(option));
    }
    if (!initial_value.IsEmpty()) {
      const auto selected = std::find(choices.begin(), choices.end(), initial_value);
      if (selected == choices.end()) return Fail(error, "The initial value must be an option.");
      selected_index = static_cast<int>(selected - choices.begin());
    }
  }
  if (radio && ((spec.rect.right - spec.rect.left) / choices.size() < 8 ||
                spec.rect.top - spec.rect.bottom < 8)) {
    return Fail(error, "Each radio Widget must be at least 8 PDF points "
                       "wide and tall.");
  }

  CPDF_InteractiveForm existing_fields(document);
  size_t name_matches = 0;
  FindExactField(&existing_fields, name, &name_matches);
  if (name_matches != 0 || existing_fields.CountFields(name) != 0) {
    return Fail(error,
                "A form field with this full name or hierarchy already exists.");
  }
  if (FieldIdExists(&existing_fields, persistent_id)) {
    return Fail(error, "Form field persistent_id already exists.");
  }

  if ((spec.type == FormFieldType::kText || choice) &&
      (!ValidColor(spec.text_color) || !std::isfinite(spec.font_size) ||
       spec.font_size <= 0 ||
       spec.font_size > std::numeric_limits<float>::max())) {
    return Fail(error,
                "Field color must be within [0, 1] and font_size positive.");
  }

  RetainPtr<CPDF_Dictionary> acroform =
      document->GetMutableRoot()->GetMutableDictFor("AcroForm");
  ByteString font_alias;
  RetainPtr<CPDF_Font> field_font;
  if (spec.type == FormFieldType::kText && !spec.font) {
    if (!acroform) {
      return Fail(error,
                  "A text field without font requires an existing AcroForm /DA "
                  "and /DR.");
    }
    field_font = ResolveFont(document, acroform.Get(), nullptr, &font_alias);
    if (!field_font) {
      return Fail(error,
                  "The existing AcroForm /DA and /DR do not resolve a font.");
    }
    if (!FontCovers(field_font.Get(), initial_value, error)) {
      return false;
    }
  }

  if (!acroform) {
    acroform = EnsureAcroForm(document);
  }
  if (!acroform) {
    return Fail(error, "PDFium could not create the AcroForm dictionary.");
  }
  if ((spec.type == FormFieldType::kText || choice) && spec.font) {
    if (!AddFontToDefaultResources(document, acroform.Get(), spec.font,
                                   &font_alias, &field_font, error) ||
        !FontCovers(field_font.Get(), initial_value, error)) {
      return false;
    }
    for (const auto& option : choices) {
      if (!FontCovers(field_font.Get(), option, error)) return false;
    }
  }
  acroform->GetOrCreateDictFor("DR");
  if (acroform->GetByteStringFor("DA").IsEmpty()) {
    acroform->SetNewFor<CPDF_String>(
        "DA", spec.type == FormFieldType::kText || choice
                  ? MakeDefaultAppearance(font_alias, spec.font_size,
                                          spec.text_color)
                  : ByteString("0 g"));
  }

  if (radio) {
    // /Opt holds Unicode export values; PDFium uses each control's index as
    // its /AP/N on-state and the field's /V when /Opt is present.
    RetainPtr<CPDF_Dictionary> group = document->NewIndirect<CPDF_Dictionary>();
    group->SetNewFor<CPDF_Name>("FT", "Btn");
    group->SetNewFor<CPDF_String>("T", name.AsStringView());
    group->SetNewFor<CPDF_String>(kFieldIdKey, persistent_id.AsStringView());
    group->SetNewFor<CPDF_Number>(
        "Ff", static_cast<int>(pdfium::form_flags::kButtonRadio |
                               pdfium::form_flags::kButtonNoToggleToOff));
    group->SetNewFor<CPDF_String>("DA", "0 g");
    auto options = group->SetNewFor<CPDF_Array>("Opt");
    for (const auto& option : choices) {
      options->AppendNew<CPDF_String>(option.AsStringView());
    }
    group->SetNewFor<CPDF_Name>(
        "V", selected_index < 0 ? ByteString("Off")
                                : ByteString::FormatInteger(selected_index));
    auto kids = group->SetNewFor<CPDF_Array>("Kids");
    auto annotations =
        ShallowCopyArray(page->GetDict()->GetArrayFor("Annots").Get());
    const double cell_width =
        (spec.rect.right - spec.rect.left) / choices.size();
    for (size_t index = 0; index < choices.size(); ++index) {
      const std::string widget_id =
          spec.persistent_id + "/radio/" + std::to_string(index);
      const WideString widget_name = WideString::FromUTF8(
          ByteStringView(widget_id.data(), widget_id.size()));
      if (AnnotationIdExists(document, widget_name)) {
        return Fail(error, "A radio Widget NM already exists.");
      }
      PdfRect child_rect = spec.rect;
      child_rect.left = spec.rect.left + cell_width * index;
      child_rect.right = index + 1 == choices.size()
                             ? spec.rect.right
                             : spec.rect.left + cell_width * (index + 1);
      const CFX_FloatRect widget_rect = ToCfxRect(child_rect);
      if (widget_rect.left >= widget_rect.right) {
        return Fail(error, "A radio Widget rectangle is too narrow.");
      }
      RetainPtr<CPDF_Dictionary> widget = NewWidget(
          document, page, WideString(), WideString(), widget_rect,
          spec.rotation, "Btn");
      if (!widget) {
        return Fail(error, "PDFium could not create an indirect radio Widget.");
      }
      widget->RemoveFor("FT");
      widget->RemoveFor("T");
      widget->RemoveFor(kFieldIdKey);
      widget->SetNewFor<CPDF_Reference>("Parent", document, group->GetObjNum());
      widget->SetNewFor<CPDF_String>("NM", widget_name.AsStringView());
      widget->SetNewFor<CPDF_Name>(
          "AS", static_cast<int>(index) == selected_index
                    ? ByteString::FormatInteger(selected_index)
                    : ByteString("Off"));
      kids->AppendNew<CPDF_Reference>(document, widget->GetObjNum());
      annotations->AppendNew<CPDF_Reference>(document, widget->GetObjNum());
    }
    auto fields = ShallowCopyArray(acroform->GetArrayFor("Fields").Get());
    fields->AppendNew<CPDF_Reference>(document, group->GetObjNum());
    acroform->SetFor("Fields", std::move(fields));
    page->GetMutableDict()->SetFor("Annots", std::move(annotations));

    CPDF_InteractiveForm created_fields(document);
    CPDF_FormField* created = FindExactField(&created_fields, name);
    if (!created || created->GetType() != CPDF_FormField::kRadioButton ||
        created->CountControls() != static_cast<int>(choices.size())) {
      return Fail(error, "PDFium could not index the new radio group.");
    }
    return ResetFieldAppearances(document, name, error);
  }

  RetainPtr<CPDF_Dictionary> widget = NewWidget(
      document, page, name, persistent_id, ToCfxRect(spec.rect), spec.rotation,
      choice ? "Ch" : spec.type == FormFieldType::kText ? "Tx" : "Btn");
  if (!widget) {
    return Fail(error, "PDFium could not create an indirect Widget field.");
  }

  if (spec.type == FormFieldType::kText) {
    widget->SetNewFor<CPDF_String>(
        "DA", MakeDefaultAppearance(font_alias, spec.font_size, spec.text_color));
    widget->SetNewFor<CPDF_String>("V", initial_value.AsStringView());
  } else if (choice) {
    widget->SetNewFor<CPDF_Number>("Ff", spec.type == FormFieldType::kComboBox
        ? static_cast<int>(pdfium::form_flags::kChoiceCombo) : 0);
    widget->SetNewFor<CPDF_String>(
        "DA", MakeDefaultAppearance(font_alias, spec.font_size, spec.text_color));
    auto options = widget->SetNewFor<CPDF_Array>("Opt");
    for (const auto& option : choices)
      options->AppendNew<CPDF_String>(option.AsStringView());
    widget->SetNewFor<CPDF_String>("V", choices[selected_index].AsStringView());
    widget->SetNewFor<CPDF_Array>("I")->AppendNew<CPDF_Number>(selected_index);
  } else {
    widget->SetNewFor<CPDF_String>("DA", "0 g");
    widget->SetNewFor<CPDF_Name>("V", spec.checked ? "Yes" : "Off");
    widget->SetNewFor<CPDF_Name>("AS", spec.checked ? "Yes" : "Off");
  }
  AttachWidget(document, page, acroform.Get(), widget.Get());

  CPDF_InteractiveForm created_fields(document);
  CPDF_FormField* created = FindExactField(&created_fields, name);
  if (!created) {
    return Fail(error, "PDFium could not index the newly created form field.");
  }
  if (spec.type == FormFieldType::kText || choice) {
    const std::vector<WideString> texts = choice ? choices : std::vector<WideString>{initial_value};
    if (!ValidateAppearanceFonts(document, created, texts, error)) return false;
  }
  return ResetFieldAppearances(document, name, error);
}

bool FillFormField(FPDF_DOCUMENT document_handle,
                   const std::string& field_name,
                   const FormValue& value,
                   std::string* error) {
  if (error) {
    error->clear();
  }
  CPDF_Document* document = CPDFDocumentFromFPDFDocument(document_handle);
  if (!document || !document->GetRoot()) {
    return Fail(error, "The form document is invalid.");
  }
  WideString name;
  if (!DecodeUtf8(field_name, false, &name, error, "Form field_name")) {
    return false;
  }

  CPDF_InteractiveForm form(document);
  size_t matches = 0;
  CPDF_FormField* field = FindExactField(&form, name, &matches);
  if (matches == 0) {
    return Fail(error, "No form field has this full name.");
  }
  if (!field) {
    return Fail(error, "The full field name is ambiguous.");
  }
  if (field->GetFieldFlags() & pdfium::form_flags::kReadOnly) {
    return Fail(error, "The form field is read-only.");
  }

  switch (field->GetType()) {
    case CPDF_FormField::kText: {
      if (value.checked.has_value() || value.selected_values.has_value()) {
        return Fail(error, "A text field requires only text_utf8.");
      }
      WideString text;
      if (!DecodeUtf8(value.text_utf8, true, &text, error,
                      "Form text value")) {
        return false;
      }
      std::vector<WideString> texts{text};
      if (!ValidateAppearanceFonts(document, field, texts, error) ||
          !field->SetValue(text, NotificationOption::kDoNotNotify)) {
        return false;
      }
      return ResetFieldAppearances(document, name, error);
    }

    case CPDF_FormField::kCheckBox: {
      if (!value.checked.has_value() || value.selected_values.has_value()) {
        return Fail(error, "A checkbox requires checked and no selected_values.");
      }
      if (field->CountControls() == 0) {
        return Fail(error, "The checkbox has no controls.");
      }
      const WideString check_value =
          value.checked.value()
              ? field->GetControl(0)->GetExportValue()
              : WideString::FromASCII("Off");
      field->SetValue(check_value, NotificationOption::kDoNotNotify);
      return ResetFieldAppearances(document, name, error);
    }

    case CPDF_FormField::kRadioButton: {
      if (value.checked.has_value() || value.selected_values.has_value()) {
        return Fail(error,
                    "A radio field requires an export value in text_utf8.");
      }
      WideString selected;
      if (!DecodeUtf8(value.text_utf8, false, &selected, error,
                      "Radio export value")) {
        return false;
      }
      bool found = false;
      for (int index = 0; index < field->CountControls(); ++index) {
        if (field->GetControl(index)->GetExportValue() == selected) {
          found = true;
          break;
        }
      }
      if (!found) {
        return Fail(error, "The radio export value does not exist.");
      }
      field->SetValue(selected, NotificationOption::kDoNotNotify);
      return ResetFieldAppearances(document, name, error);
    }

    case CPDF_FormField::kComboBox:
    case CPDF_FormField::kListBox: {
      if (value.checked.has_value()) {
        return Fail(error, "A choice field cannot use checked.");
      }
      const bool is_combo = field->GetType() == CPDF_FormField::kComboBox;
      const bool is_multi =
          field->GetFieldFlags() & pdfium::form_flags::kChoiceMultiSelect;
      if (value.selected_values.has_value()) {
        const std::vector<std::string>& selected_values =
            value.selected_values.value();
        if (selected_values.size() > 1 && (is_combo || !is_multi)) {
          return Fail(error,
                      "Multiple values require a multi-select list field.");
        }
        std::vector<int> indices;
        std::set<int> unique_indices;
        for (const std::string& encoded : selected_values) {
          WideString selected;
          if (!DecodeUtf8(encoded, true, &selected, error,
                          "Choice export value")) {
            return false;
          }
          const int option_index = field->FindOption(selected);
          if (option_index < 0) {
            return Fail(error, "A selected choice export value does not exist.");
          }
          if (!unique_indices.insert(option_index).second) {
            return Fail(error, "Choice selected_values contains a duplicate.");
          }
          indices.push_back(option_index);
        }
        std::vector<WideString> appearance_texts;
        if (is_combo) {
          appearance_texts.push_back(
              indices.empty() ? WideString()
                              : field->GetOptionLabel(indices.front()));
        } else {
          appearance_texts = ChoiceAppearanceTexts(field);
        }
        if (!ValidateAppearanceFonts(document, field, appearance_texts,
                                     error) ||
            !field->ClearSelection(NotificationOption::kDoNotNotify)) {
          return false;
        }
        for (int option_index : indices) {
          field->SetItemSelection(option_index,
                                  NotificationOption::kDoNotNotify);
        }
      } else {
        WideString selected;
        if (!DecodeUtf8(value.text_utf8, true, &selected, error,
                        "Choice value")) {
          return false;
        }
        const int option_index = field->FindOption(selected);
        if (option_index < 0 &&
            (!is_combo || !(field->GetFieldFlags() &
                            pdfium::form_flags::kChoiceEdit))) {
          return Fail(error, "The choice export value does not exist.");
        }
        std::vector<WideString> appearance_texts;
        if (is_combo) {
          appearance_texts.push_back(
              option_index >= 0 ? field->GetOptionLabel(option_index) : selected);
        } else {
          appearance_texts = ChoiceAppearanceTexts(field);
        }
        if (!ValidateAppearanceFonts(document, field, appearance_texts,
                                     error) ||
            !field->SetValue(selected, NotificationOption::kDoNotNotify)) {
          return false;
        }
      }
      return ResetFieldAppearances(document, name, error);
    }

    default:
      return Fail(error,
                  "Only text, checkbox, radio, combo, and list fields are "
                  "supported.");
  }
}

}  // namespace pdf_editor
