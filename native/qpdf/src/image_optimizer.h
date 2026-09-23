#ifndef PDF_EDITOR_IMAGE_OPTIMIZER_H
#define PDF_EDITOR_IMAGE_OPTIMIZER_H

#include <qpdf/QPDF.hh>

#include <stdexcept>

struct NoImagesOptimized final: std::runtime_error
{
    NoImagesOptimized(): std::runtime_error(
        "No supported opaque RGB/grayscale images became smaller at this JPEG quality; "
        "transparent, masked and other image formats were kept unchanged") {}
    explicit NoImagesOptimized(char const* message): std::runtime_error(message) {}
};

// Edits only eligible image streams in this export-only QPDF instance. Returns
// the number of distinct image objects whose compressed data was reduced.
int optimize_export_images(QPDF& pdf, int quality);

// Resamples only eligible images with a longer side above max_edge, keeping
// their aspect ratio. Returns the number of distinct resampled image objects.
int resample_export_images(QPDF& pdf, int quality, int max_edge);

#endif
