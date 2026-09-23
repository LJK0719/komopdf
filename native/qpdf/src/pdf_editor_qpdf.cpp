#include "pdf_editor_qpdf.h"
#include "image_optimizer.h"

#include <qpdf/Buffer.hh>
#include <qpdf/QPDF.hh>
#include <qpdf/QPDFWriter.hh>

#include <cstdlib>
#include <cstring>
#include <exception>
#include <memory>
#include <string>

namespace
{
thread_local std::string last_error;

bool allowed(uint32_t permissions, uint32_t bit)
{
    return (permissions & bit) != 0;
}

qpdf_r3_print_e print_permission(uint32_t permissions)
{
    if (allowed(permissions, PDE_QPDF_ALLOW_PRINT_HIGH)) {
        return qpdf_r3p_full;
    }
    if (allowed(permissions, PDE_QPDF_ALLOW_PRINT_LOW)) {
        return qpdf_r3p_low;
    }
    return qpdf_r3p_none;
}

void configure_writer(
    QPDFWriter& writer,
    uint32_t operation,
    char const* user_password,
    char const* owner_password,
    uint32_t permissions,
    bool encrypt_metadata)
{
    switch (operation) {
    case PDE_QPDF_DECRYPT:
        writer.setPreserveEncryption(false);
        break;

    case PDE_QPDF_ENCRYPT_AES256:
        if ((user_password == nullptr) || (owner_password == nullptr)) {
            throw std::invalid_argument(
                "AES-256 output requires explicit user and owner password strings");
        }
        writer.setR6EncryptionParameters(
            user_password,
            owner_password,
            allowed(permissions, PDE_QPDF_ALLOW_ACCESSIBILITY),
            allowed(permissions, PDE_QPDF_ALLOW_EXTRACT),
            allowed(permissions, PDE_QPDF_ALLOW_ASSEMBLE),
            allowed(permissions, PDE_QPDF_ALLOW_ANNOTATE_AND_FORM),
            allowed(permissions, PDE_QPDF_ALLOW_FORM_FILLING),
            allowed(permissions, PDE_QPDF_ALLOW_MODIFY_OTHER),
            print_permission(permissions),
            encrypt_metadata);
        break;

    case PDE_QPDF_OPTIMIZE_LOSSLESS:
        writer.setObjectStreamMode(qpdf_o_generate);
        writer.setCompressStreams(true);
        writer.setDecodeLevel(qpdf_dl_generalized);
        writer.setRecompressFlate(true);
        writer.setPreserveUnreferencedObjects(false);
        break;

    default:
        throw std::invalid_argument("unknown QPDF transform operation");
    }
}
} // namespace

extern "C" uint32_t
pde_qpdf_abi_version(void)
{
    return PDE_QPDF_ABI_VERSION;
}

extern "C" char const*
pde_qpdf_version(void)
{
    static std::string const version = QPDF::QPDFVersion();
    return version.c_str();
}

extern "C" int
pde_qpdf_transform(
    uint32_t operation,
    unsigned char const* input_data,
    size_t input_size,
    char const* input_password,
    char const* user_password,
    char const* owner_password,
    uint32_t permissions,
    int encrypt_metadata,
    unsigned char** output_data,
    size_t* output_size)
{
    last_error.clear();
    if (output_data != nullptr) {
        *output_data = nullptr;
    }
    if (output_size != nullptr) {
        *output_size = 0;
    }

    if ((input_data == nullptr) || (input_size == 0) || (output_data == nullptr) ||
        (output_size == nullptr)) {
        last_error = "input PDF and output pointers are required";
        return PDE_QPDF_INVALID_ARGUMENT;
    }
    if ((operation < PDE_QPDF_DECRYPT) || (operation > PDE_QPDF_OPTIMIZE_LOSSLESS)) {
        last_error = "unknown QPDF transform operation";
        return PDE_QPDF_INVALID_ARGUMENT;
    }

    try {
        QPDF pdf;
        pdf.setSuppressWarnings(true);
        pdf.processMemoryFile(
            "export copy",
            reinterpret_cast<char const*>(input_data),
            input_size,
            input_password);

        QPDFWriter writer(pdf);
        writer.setOutputMemory();
        configure_writer(
            writer,
            operation,
            user_password,
            owner_password,
            permissions,
            encrypt_metadata != 0);
        writer.write();

        std::shared_ptr<Buffer> buffer = writer.getBufferSharedPointer();
        if (!buffer || (buffer->getSize() == 0)) {
            last_error = "QPDF produced an empty output";
            return PDE_QPDF_WRITE_FAILED;
        }

        auto* result = static_cast<unsigned char*>(std::malloc(buffer->getSize()));
        if (result == nullptr) {
            last_error = "unable to allocate QPDF output buffer";
            return PDE_QPDF_OUT_OF_MEMORY;
        }
        std::memcpy(result, buffer->getBuffer(), buffer->getSize());
        *output_data = result;
        *output_size = buffer->getSize();
        return PDE_QPDF_OK;
    } catch (std::invalid_argument const& error) {
        last_error = error.what();
        return PDE_QPDF_INVALID_ARGUMENT;
    } catch (std::exception const& error) {
        last_error = error.what();
        return PDE_QPDF_OPEN_FAILED;
    } catch (...) {
        last_error = "unknown QPDF failure";
        return PDE_QPDF_INTERNAL_ERROR;
    }
}

extern "C" int
pde_qpdf_optimize_images(
    unsigned char const* input_data,
    size_t input_size,
    char const* input_password,
    int quality,
    unsigned char** output_data,
    size_t* output_size)
{
    last_error.clear();
    if (output_data != nullptr) *output_data = nullptr;
    if (output_size != nullptr) *output_size = 0;
    if ((input_data == nullptr) || (input_size == 0) || (output_data == nullptr) ||
        (output_size == nullptr) || (quality < 1) || (quality > 95)) {
        last_error = "input PDF, output pointers and JPEG quality 1..95 are required";
        return PDE_QPDF_INVALID_ARGUMENT;
    }
    try {
        QPDF pdf;
        pdf.setSuppressWarnings(true);
        pdf.processMemoryFile(
            "export copy", reinterpret_cast<char const*>(input_data), input_size, input_password);
        optimize_export_images(pdf, quality);
        QPDFWriter writer(pdf);
        writer.setPreserveEncryption(true);
        writer.setOutputMemory();
        writer.write();
        auto buffer = writer.getBufferSharedPointer();
        if (!buffer || buffer->getSize() == 0) {
            last_error = "QPDF produced an empty output";
            return PDE_QPDF_WRITE_FAILED;
        }
        auto* result = static_cast<unsigned char*>(std::malloc(buffer->getSize()));
        if (result == nullptr) {
            last_error = "unable to allocate QPDF output buffer";
            return PDE_QPDF_OUT_OF_MEMORY;
        }
        std::memcpy(result, buffer->getBuffer(), buffer->getSize());
        *output_data = result;
        *output_size = buffer->getSize();
        return PDE_QPDF_OK;
    } catch (std::invalid_argument const& error) {
        last_error = error.what();
        return PDE_QPDF_INVALID_ARGUMENT;
    } catch (std::exception const& error) {
        last_error = error.what();
        return PDE_QPDF_OPEN_FAILED;
    } catch (...) {
        last_error = "unknown QPDF failure";
        return PDE_QPDF_INTERNAL_ERROR;
    }
}

extern "C" char const*
pde_qpdf_last_error(void)
{
    return last_error.c_str();
}

extern "C" void
pde_qpdf_free(void* pointer)
{
    std::free(pointer);
}
