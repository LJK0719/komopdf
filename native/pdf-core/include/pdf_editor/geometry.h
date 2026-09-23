#pragma once

#include <array>
#include <optional>

namespace pdf_editor {
struct Point { double x; double y; };
struct PdfBox { double left; double bottom; double right; double top; };
struct Rect { double x; double y; double width; double height; };

// x' = a*x + c*y + e; y' = b*x + d*y + f.
struct Matrix {
  double a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
  Point Apply(Point point) const;
  Matrix Inverse() const;
  Matrix Then(const Matrix& next) const;
  Rect ApplyBounds(const Rect& rect) const;
};

struct PageGeometry {
  PdfBox visible_box;
  double width_pt;
  double height_pt;
  int rotation;
  Matrix pdf_to_page;
  Matrix page_to_pdf;
};

PageGeometry NormalizePage(PdfBox media_box,
                           std::optional<PdfBox> crop_box,
                           int clockwise_rotation,
                           double user_unit = 1);
}  // namespace pdf_editor
