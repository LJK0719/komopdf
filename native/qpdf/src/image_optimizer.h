#ifndef PDF_EDITOR_IMAGE_OPTIMIZER_H
#define PDF_EDITOR_IMAGE_OPTIMIZER_H

#include <qpdf/QPDF.hh>

#include <stdexcept>

struct NoImagesOptimized final: std::runtime_error
{
    NoImagesOptimized(): std::runtime_error(
        "No supported opaque RGB/grayscale images became smaller at this JPEG quality; "
        "transparent, masked and other image formats were kept unchanged") {}
};

// Edits only eligible image streams in this export-only QPDF instance. Returns
// the number of distinct image objects whose compressed data was reduced.
int optimize_export_images(QPDF& pdf, int quality);

#endif
