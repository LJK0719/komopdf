#include "pdf_editor_qpdf.h"

#include <qpdf/Buffer.hh>
#include <qpdf/QPDF.hh>

#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

int main(int argc, char** argv)
{
    if (argc != 2 || pde_qpdf_abi_version() != 2) return 1;
    std::ifstream file(argv[1], std::ios::binary);
    std::vector<unsigned char> source{
        std::istreambuf_iterator<char>{file}, std::istreambuf_iterator<char>{}};
    if (source.empty()) return 2;

    unsigned char* output = nullptr;
    size_t size = 0;
    auto status = pde_qpdf_resample_images(
        source.data(), source.size(), nullptr, 70, 40, &output, &size);
    if (status != PDE_QPDF_OK || output == nullptr || size == 0) {
        std::cerr << pde_qpdf_last_error() << '\n';
        return 3;
    }
    QPDF pdf;
    pdf.processMemoryFile("resampled copy", reinterpret_cast<char const*>(output), size);
    int resized = 0;
    for (auto& object: pdf.getAllObjects()) {
        if (!object.isStreamOfType("/XObject", "/Image")) continue;
        auto dict = object.getDict();
        if (dict.getKey("/Width").getIntValue() == 40 &&
            dict.getKey("/Height").getIntValue() == 20 &&
            dict.getKey("/Filter").isNameAndEquals("/DCTDecode")) {
            auto components = dict.getKey("/ColorSpace").isNameAndEquals("/DeviceRGB") ? 3 : 1;
            auto pixels = object.getStreamData(qpdf_dl_all);
            if (!pixels || pixels->getSize() != static_cast<size_t>(40 * 20 * components)) {
                return 7;
            }
            ++resized;
        }
    }
    pde_qpdf_free(output);
    if (resized != 2) return 4;

    output = nullptr;
    size = 0;
    status = pde_qpdf_resample_images(
        source.data(), source.size(), nullptr, 70, 80, &output, &size);
    if (status == PDE_QPDF_OK || output != nullptr || size != 0 ||
        std::string(pde_qpdf_last_error()).find("exceeded the maximum edge") == std::string::npos) {
        return 5;
    }
    status = pde_qpdf_resample_images(
        source.data(), source.size(), nullptr, 70, 0, &output, &size);
    if (status != PDE_QPDF_INVALID_ARGUMENT || output != nullptr || size != 0) return 6;

    // The pre-existing quality-only ABI must never change pixel dimensions.
    status = pde_qpdf_optimize_images(
        source.data(), source.size(), nullptr, 70, &output, &size);
    if (status == PDE_QPDF_OK) {
        QPDF legacy;
        legacy.processMemoryFile("quality-only copy", reinterpret_cast<char const*>(output), size);
        for (auto& object: legacy.getAllObjects()) {
            if (!object.isStreamOfType("/XObject", "/Image")) continue;
            auto dict = object.getDict();
            if (dict.getKey("/Width").getIntValue() == 40) return 8;
        }
        pde_qpdf_free(output);
    } else if (status != PDE_QPDF_OPEN_FAILED || output != nullptr || size != 0 ||
               std::string(pde_qpdf_last_error()).find("became smaller") == std::string::npos) {
        return 9;
    }
    std::cout << "C ABI2 resampling, quality-only and no-op/invalid-argument cases passed\n";
    return 0;
}
