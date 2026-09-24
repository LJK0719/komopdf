#include "image_optimizer.h"

#include <qpdf/Buffer.hh>
#include <qpdf/Pl_Buffer.hh>
#include <qpdf/Pl_DCT.hh>
#include <qpdf/QPDFObjectHandle.hh>
#include <qpdf/QPDFPageDocumentHelper.hh>

#include <algorithm>
#include <cstdint>
#include <limits>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace
{
// Do not decode arbitrarily large images into memory, especially in wasm32.
constexpr size_t max_decoded_bytes = 64 * 1024 * 1024;

bool eligible(QPDFObjectHandle const& image, std::set<QPDFObjGen> const& masks,
              size_t& expected_bytes, int& width, int& height, int& components,
              J_COLOR_SPACE& color_space)
{
    if (!image.isStreamOfType("/XObject", "/Image") || masks.count(image.getObjGen()) != 0) {
        return false;
    }
    auto dict = image.getDict();
    // An image with a stencil, color-key mask, soft mask, decode inversion or
    // custom JPEG parameters cannot be safely rewritten as an opaque JPEG.
    if (!dict.getKey("/SMask").isNull() || !dict.getKey("/Mask").isNull() ||
        !dict.getKey("/ImageMask").isNull() || !dict.getKey("/Decode").isNull() ||
        !dict.getKey("/DecodeParms").isNull() || !dict.getKey("/SMaskInData").isNull() ||
        !dict.getKey("/Alternates").isNull()) {
        return false;
    }
    auto filter = dict.getKey("/Filter");
    if (!(filter.isNameAndEquals("/FlateDecode") || filter.isNameAndEquals("/DCTDecode"))) {
        return false;
    }
    auto bits = dict.getKey("/BitsPerComponent");
    auto w = dict.getKey("/Width");
    auto h = dict.getKey("/Height");
    if (!bits.isInteger() || bits.getIntValue() != 8 || !w.isInteger() || !h.isInteger()) {
        return false;
    }
    auto iw = w.getIntValue();
    auto ih = h.getIntValue();
    if (iw <= 0 || ih <= 0 || iw > std::numeric_limits<JDIMENSION>::max() ||
        ih > std::numeric_limits<JDIMENSION>::max()) {
        return false;
    }
    auto cs = dict.getKey("/ColorSpace");
    if (cs.isNameAndEquals("/DeviceRGB")) {
        components = 3;
        color_space = JCS_RGB;
    } else if (cs.isNameAndEquals("/DeviceGray")) {
        components = 1;
        color_space = JCS_GRAYSCALE;
    } else if (cs.isNameAndEquals("/DeviceCMYK")) {
        components = 4;
        color_space = JCS_CMYK;
    } else {
        return false;
    }
    if (iw > static_cast<long long>(max_decoded_bytes / components) / ih) {
        return false;
    }
    width = static_cast<int>(iw);
    height = static_cast<int>(ih);
    expected_bytes = static_cast<size_t>(iw) * static_cast<size_t>(ih) * components;
    return true;
}

// Area average in exact integer pixel-boundary coordinates. This avoids
// aliasing on large reductions without an intermediate full-size image.
std::vector<unsigned char> resample(
    unsigned char const* source, int width, int height, int components,
    int target_width, int target_height)
{
    std::vector<unsigned char> result(
        static_cast<size_t>(target_width) * target_height * components);
    auto divisor = static_cast<uint64_t>(width) * height;
    for (int dy = 0; dy < target_height; ++dy) {
        auto y0 = static_cast<uint64_t>(dy) * height;
        auto y1 = static_cast<uint64_t>(dy + 1) * height;
        for (int dx = 0; dx < target_width; ++dx) {
            uint64_t sums[4]{};
            auto x0 = static_cast<uint64_t>(dx) * width;
            auto x1 = static_cast<uint64_t>(dx + 1) * width;
            for (uint64_t sy = y0 / target_height; sy <= (y1 - 1) / target_height; ++sy) {
                auto wy = std::min(y1, (sy + 1) * target_height) -
                          std::max(y0, sy * target_height);
                for (uint64_t sx = x0 / target_width; sx <= (x1 - 1) / target_width; ++sx) {
                    auto wx = std::min(x1, (sx + 1) * target_width) -
                              std::max(x0, sx * target_width);
                    auto weight = wx * wy;
                    auto offset = (static_cast<size_t>(sy) * width + sx) * components;
                    for (int c = 0; c < components; ++c) {
                        sums[c] += weight * source[offset + c];
                    }
                }
            }
            auto dest = (static_cast<size_t>(dy) * target_width + dx) * components;
            for (int c = 0; c < components; ++c) {
                result[dest + c] =
                    static_cast<unsigned char>((sums[c] + divisor / 2) / divisor);
            }
        }
    }
    return result;
}

int process_images(QPDF& pdf, int quality, int max_edge)
{
    if (quality < 1 || quality > 95) {
        throw std::invalid_argument("JPEG quality must be an integer from 1 to 95");
    }
    if (max_edge < 0) {
        throw std::invalid_argument("maximum image edge must be a positive number of pixels");
    }
    auto objects = pdf.getAllObjects();
    std::set<QPDFObjGen> masks;
    for (auto& object: objects) {
        // Soft masks implemented through an ExtGState transparency group can
        // draw arbitrary images inside a Form. Without a full usage graph we
        // cannot distinguish those mask images from ordinary page images.
        auto candidate_dict = object.isDictionary() ? object :
                              object.isStream() ? object.getDict() : QPDFObjectHandle();
        if (candidate_dict.isDictionary()) {
            if (candidate_dict.getKey("/SMask").isDictionary()) {
                throw NoImagesOptimized();
            }
            auto resources = candidate_dict.getKeyIfDict("/Resources");
            auto states = resources.getKeyIfDict("/ExtGState");
            if (states.isDictionary()) {
                for (auto const& key: states.getKeys()) {
                    if (states.getKey(key).getKeyIfDict("/SMask").isDictionary()) {
                        throw NoImagesOptimized();
                    }
                }
            }
        }
        if (!object.isStreamOfType("/XObject", "/Image")) {
            continue;
        }
        auto dict = object.getDict();
        for (auto const& key: {"/SMask", "/Mask"}) {
            auto mask = dict.getKey(key);
            if (mask.isStream()) {
                masks.insert(mask.getObjGen());
            }
        }
    }

    std::set<QPDFObjGen> page_images;
    QPDFPageDocumentHelper pages(pdf);
    for (auto& page: pages.getAllPages()) {
        page.forEachImage(true, [&](QPDFObjectHandle& image, QPDFObjectHandle&, std::string const&) {
            page_images.insert(image.getObjGen());
        });
    }

    int changed = 0;
    for (auto& image: objects) {
        if (page_images.count(image.getObjGen()) == 0) {
            continue;
        }
        size_t expected_bytes = 0;
        int width = 0;
        int height = 0;
        int components = 0;
        J_COLOR_SPACE color_space = JCS_UNKNOWN;
        if (!eligible(image, masks, expected_bytes, width, height, components, color_space)) {
            continue;
        }
        if (max_edge != 0 && std::max(width, height) <= max_edge) {
            continue;
        }
        int target_width = width;
        int target_height = height;
        if (max_edge != 0) {
            auto longest = std::max(width, height);
            target_width = std::max(1, static_cast<int>(
                (static_cast<uint64_t>(width) * max_edge + longest / 2) / longest));
            target_height = std::max(1, static_cast<int>(
                (static_cast<uint64_t>(height) * max_edge + longest / 2) / longest));
        }
        // First encode in isolation; on any unsupported/corrupt stream leave
        // the original object and all its shared references intact.
        std::shared_ptr<Buffer> compressed;
        try {
            auto original = image.getRawStreamData();
            auto decoded = image.getStreamData(qpdf_dl_all);
            if (!original || !decoded || decoded->getSize() != expected_bytes) {
                continue;
            }
            std::vector<unsigned char> resized;
            unsigned char const* pixels = decoded->getBuffer();
            size_t pixel_bytes = expected_bytes;
            if (max_edge != 0) {
                resized = resample(pixels, width, height, components, target_width, target_height);
                pixels = resized.data();
                pixel_bytes = resized.size();
            }
            Pl_Buffer output("optimized JPEG");
            auto config = Pl_DCT::make_compress_config(
                [quality](jpeg_compress_struct* info) { jpeg_set_quality(info, quality, FALSE); });
            Pl_DCT jpeg("JPEG encoder", &output, target_width, target_height, components,
                        color_space, config.get());
            jpeg.write(pixels, pixel_bytes);
            jpeg.finish();
            compressed = output.getBufferSharedPointer();
            // Preserve quality-only's byte-reduction semantics. Resampling is
            // explicitly requested and must keep its new dimensions even if
            // the JPEG bytes happen to be larger than the original stream.
            if (!compressed || (max_edge == 0 && compressed->getSize() >= original->getSize())) {
                continue;
            }
        } catch (std::exception const&) {
            // Unsupported or malformed individual images must stay untouched.
            continue;
        }
        // Replacement failure is fatal: do not write a PDF with partially
        // changed stream metadata.
        image.replaceStreamData(compressed, QPDFObjectHandle::newName("/DCTDecode"),
                                QPDFObjectHandle::newNull());
        if (max_edge != 0) {
            auto dict = image.getDict();
            dict.replaceKey("/Width", QPDFObjectHandle::newInteger(target_width));
            dict.replaceKey("/Height", QPDFObjectHandle::newInteger(target_height));
        }
        ++changed;
    }
    if (changed == 0) {
        if (max_edge != 0) {
            throw NoImagesOptimized(
                "No supported opaque RGB/grayscale/CMYK image exceeded the maximum edge and was "
                "resampled; unchanged dimensions, masks and unsupported formats were kept");
        }
        throw NoImagesOptimized();
    }
    return changed;
}
} // namespace

int optimize_export_images(QPDF& pdf, int quality)
{
    return process_images(pdf, quality, 0);
}

int resample_export_images(QPDF& pdf, int quality, int max_edge)
{
    if (max_edge < 1) {
        throw std::invalid_argument("maximum image edge must be a positive number of pixels");
    }
    return process_images(pdf, quality, max_edge);
}
