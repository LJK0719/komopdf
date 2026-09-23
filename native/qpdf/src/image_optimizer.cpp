#include "image_optimizer.h"

#include <qpdf/Buffer.hh>
#include <qpdf/Pl_Buffer.hh>
#include <qpdf/Pl_DCT.hh>
#include <qpdf/QPDFObjectHandle.hh>
#include <qpdf/QPDFPageDocumentHelper.hh>

#include <limits>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>

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
} // namespace

int optimize_export_images(QPDF& pdf, int quality)
{
    if (quality < 1 || quality > 95) {
        throw std::invalid_argument("JPEG quality must be an integer from 1 to 95");
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
        // First encode in isolation; on any unsupported/corrupt stream or a
        // larger JPEG leave the original object and all its references intact.
        std::shared_ptr<Buffer> compressed;
        try {
            auto original = image.getRawStreamData();
            auto decoded = image.getStreamData(qpdf_dl_all);
            if (!original || !decoded || decoded->getSize() != expected_bytes) {
                continue;
            }
            Pl_Buffer output("optimized JPEG");
            auto config = Pl_DCT::make_compress_config(
                [quality](jpeg_compress_struct* info) { jpeg_set_quality(info, quality, FALSE); });
            Pl_DCT jpeg("JPEG encoder", &output, width, height, components, color_space,
                        config.get());
            jpeg.write(decoded->getBuffer(), decoded->getSize());
            jpeg.finish();
            compressed = output.getBufferSharedPointer();
            if (!compressed || compressed->getSize() >= original->getSize()) {
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
        ++changed;
    }
    if (changed == 0) {
        throw NoImagesOptimized();
    }
    return changed;
}
