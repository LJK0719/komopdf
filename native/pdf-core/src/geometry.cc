#include "pdf_editor/geometry.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace pdf_editor {
namespace {
PdfBox Ordered(PdfBox box) {
  if (!std::isfinite(box.left) || !std::isfinite(box.bottom) ||
      !std::isfinite(box.right) || !std::isfinite(box.top)) {
    throw std::invalid_argument("Non-finite page box");
  }
  return {std::min(box.left, box.right), std::min(box.bottom, box.top),
          std::max(box.left, box.right), std::max(box.bottom, box.top)};
}
}

Point Matrix::Apply(Point p) const {
  return {a * p.x + c * p.y + e, b * p.x + d * p.y + f};
}
Matrix Matrix::Inverse() const {
  const auto determinant = a * d - b * c;
  if (!std::isfinite(determinant) || determinant == 0) {
    throw std::invalid_argument("Singular transform");
  }
  return {d / determinant, -b / determinant, -c / determinant,
          a / determinant, (c * f - d * e) / determinant,
          (b * e - a * f) / determinant};
}
Matrix Matrix::Then(const Matrix& n) const {
  return {n.a * a + n.c * b, n.b * a + n.d * b,
          n.a * c + n.c * d, n.b * c + n.d * d,
          n.a * e + n.c * f + n.e, n.b * e + n.d * f + n.f};
}
Rect Matrix::ApplyBounds(const Rect& r) const {
  const std::array<Point, 4> points = {Apply({r.x, r.y}),
      Apply({r.x + r.width, r.y}), Apply({r.x, r.y + r.height}),
      Apply({r.x + r.width, r.y + r.height})};
  auto min_x = points[0].x, max_x = min_x;
  auto min_y = points[0].y, max_y = min_y;
  for (auto p : points) {
    min_x = std::min(min_x, p.x); max_x = std::max(max_x, p.x);
    min_y = std::min(min_y, p.y); max_y = std::max(max_y, p.y);
  }
  return {min_x, min_y, max_x - min_x, max_y - min_y};
}

PageGeometry NormalizePage(PdfBox media, std::optional<PdfBox> crop,
                           int rotation, double unit) {
  media = Ordered(media);
  auto box = crop ? Ordered(*crop) : media;
  box.left = std::max(box.left, media.left);
  box.bottom = std::max(box.bottom, media.bottom);
  box.right = std::min(box.right, media.right);
  box.top = std::min(box.top, media.top);
  if (box.right <= box.left || box.top <= box.bottom ||
      !std::isfinite(unit) || unit <= 0 || rotation % 90 != 0) {
    throw std::invalid_argument("Invalid page geometry");
  }
  rotation = (rotation % 360 + 360) % 360;
  Matrix matrix;
  switch (rotation) {
    case 0: matrix = {unit, 0, 0, -unit, -box.left * unit, box.top * unit}; break;
    case 90: matrix = {0, unit, unit, 0, -box.bottom * unit, -box.left * unit}; break;
    case 180: matrix = {-unit, 0, 0, unit, box.right * unit, -box.bottom * unit}; break;
    case 270: matrix = {0, -unit, -unit, 0, box.top * unit, box.right * unit}; break;
  }
  auto width = (box.right - box.left) * unit;
  auto height = (box.top - box.bottom) * unit;
  if (rotation == 90 || rotation == 270) std::swap(width, height);
  return {box, width, height, rotation, matrix, matrix.Inverse()};
}
}  // namespace pdf_editor
