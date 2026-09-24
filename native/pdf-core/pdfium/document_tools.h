#pragma once

#include <optional>
#include <string>
#include <vector>

#include "public/fpdfview.h"

namespace pdf_editor {

struct PdfPoint {
  double x = 0;
  double y = 0;
};

struct PdfRect {
  double left = 0;
  double bottom = 0;
  double right = 0;
  double top = 0;
};

struct RgbColor {
  double red = 0;
  double green = 0;
  double blue = 0;
};

struct AnnotationQuad {
  PdfPoint p1;
  PdfPoint p2;
  PdfPoint p3;
  PdfPoint p4;
};

enum class AnnotationType {
  kHighlight,
  kText,
  kRectangle,
  kInk,
};

struct AnnotationSpec {
  AnnotationType type = AnnotationType::kText;
  std::string persistent_id;
  std::string contents_utf8;
  PdfRect rect;
  std::vector<AnnotationQuad> quad_points;
  std::vector<std::vector<PdfPoint>> ink_strokes;
  RgbColor color;
  double opacity = 1;
  double stroke_width = 1;
};

enum class FormFieldType {
  kText,
  kCheckbox,
  kComboBox,
  kListBox,
  kRadioButton,
};

struct FormFieldSpec {
  FormFieldType type = FormFieldType::kText;
  std::string persistent_id;
  std::string name_utf8;
  PdfRect rect;
  int rotation = 0;
  // Radio: an empty initial value leaves every Widget Off; otherwise it must
  // match one of the distinct options_utf8 export values.
  std::string initial_value_utf8;
  std::vector<std::string> options_utf8;
  bool checked = false;
  bool read_only = false;
  bool required = false;
  bool multiple = false;  // Only list boxes support multiple selections.
  // Must be a font already loaded into `document`. Text fields without a font
  // reuse an existing valid AcroForm /DA and /DR; they never silently fall back
  // to Helvetica or a platform font.
  FPDF_FONT font = nullptr;
  double font_size = 12;
  RgbColor text_color;
};

struct FormValue {
  // Text/radio/single-choice value. Radio values are export values; choice
  // values are option export values (or custom text for an editable combo box).
  std::string text_utf8;
  // Required for checkboxes and unset for every other field type.
  std::optional<bool> checked;
  // When present, fills a choice field by export value. An empty vector clears
  // selection. Multiple values require a multi-select list field.
  std::optional<std::vector<std::string>> selected_values;
};

// Coordinates are already in PDF page space. The caller owns candidate-level
// rollback and persistence; these helpers mutate only the supplied candidate.
bool AddAnnotation(FPDF_DOCUMENT document,
                   FPDF_PAGE page,
                   const AnnotationSpec& spec,
                   std::string* error);

bool CreateFormField(FPDF_DOCUMENT document,
                     FPDF_PAGE page,
                     const FormFieldSpec& spec,
                     std::string* error);

bool FillFormField(FPDF_DOCUMENT document,
                   const std::string& field_name,
                   const FormValue& value,
                   std::string* error);

// Unspecified attributes preserve their current PDF field flags.
bool UpdateFormField(FPDF_DOCUMENT document,
                     const std::string& field_name,
                     std::optional<bool> read_only,
                     std::optional<bool> required,
                     std::optional<bool> multiple,
                     std::string* error);

}  // namespace pdf_editor
