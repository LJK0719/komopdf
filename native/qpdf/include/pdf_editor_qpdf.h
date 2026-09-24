#ifndef PDF_EDITOR_QPDF_H
#define PDF_EDITOR_QPDF_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  define PDE_QPDF_EXPORT __declspec(dllexport)
#else
#  define PDE_QPDF_EXPORT __attribute__((visibility("default")))
#endif

#define PDE_QPDF_ABI_VERSION 2u

typedef enum pde_qpdf_operation {
    PDE_QPDF_DECRYPT = 1,
    PDE_QPDF_ENCRYPT_AES256 = 2,
    PDE_QPDF_OPTIMIZE_LOSSLESS = 3
} pde_qpdf_operation;

typedef enum pde_qpdf_permission {
    PDE_QPDF_ALLOW_ACCESSIBILITY = 1u << 0,
    PDE_QPDF_ALLOW_EXTRACT = 1u << 1,
    PDE_QPDF_ALLOW_ASSEMBLE = 1u << 2,
    PDE_QPDF_ALLOW_ANNOTATE_AND_FORM = 1u << 3,
    PDE_QPDF_ALLOW_FORM_FILLING = 1u << 4,
    PDE_QPDF_ALLOW_MODIFY_OTHER = 1u << 5,
    PDE_QPDF_ALLOW_PRINT_LOW = 1u << 6,
    PDE_QPDF_ALLOW_PRINT_HIGH = 1u << 7,
    PDE_QPDF_ALLOW_ALL = 0xffu
} pde_qpdf_permission;

typedef enum pde_qpdf_status {
    PDE_QPDF_OK = 0,
    PDE_QPDF_INVALID_ARGUMENT = 1,
    PDE_QPDF_OPEN_FAILED = 2,
    PDE_QPDF_WRITE_FAILED = 3,
    PDE_QPDF_OUT_OF_MEMORY = 4,
    PDE_QPDF_INTERNAL_ERROR = 5
} pde_qpdf_status;

PDE_QPDF_EXPORT uint32_t pde_qpdf_abi_version(void);
PDE_QPDF_EXPORT char const* pde_qpdf_version(void);

/*
 * Transform one complete PDF held in memory. Passwords are UTF-8 C strings and
 * are never written to files or emitted by this API. input_password may be NULL
 * for an unencrypted input. user_password and owner_password are used only for
 * PDE_QPDF_ENCRYPT_AES256 and may be empty strings when that is intentional.
 *
 * On success, *output_data is allocated by this module. Release it with
 * pde_qpdf_free. On failure, no output is returned; pde_qpdf_last_error contains
 * a process-local diagnostic that is replaced by the next call on this thread.
 */
PDE_QPDF_EXPORT int pde_qpdf_transform(
    uint32_t operation,
    unsigned char const* input_data,
    size_t input_size,
    char const* input_password,
    char const* user_password,
    char const* owner_password,
    uint32_t permissions,
    int encrypt_metadata,
    unsigned char** output_data,
    size_t* output_size);

/* Explicit lossy export on a copy only. Quality is 1..95. Reports an error
 * instead of returning an unchanged PDF when no supported opaque RGB/gray/CMYK
 * images were actually reduced. Masks/alpha and unsupported formats are kept.
 */
PDE_QPDF_EXPORT int pde_qpdf_optimize_images(
    unsigned char const* input_data,
    size_t input_size,
    char const* input_password,
    int quality,
    unsigned char** output_data,
    size_t* output_size);

/* Separate explicit lossy export on a copy: only opaque 8-bit DeviceRGB/Gray/CMYK
 * page images whose longer side exceeds max_edge (positive pixels) are area-
 * resampled to that maximum, with aspect ratio preserved and encoded at quality
 * 1..95. Returns an error with no output when no image dimensions shrink.
 * Existing quality-only pde_qpdf_optimize_images retains its ABI2 semantics.
 */
PDE_QPDF_EXPORT int pde_qpdf_resample_images(
    unsigned char const* input_data,
    size_t input_size,
    char const* input_password,
    int quality,
    int max_edge,
    unsigned char** output_data,
    size_t* output_size);

PDE_QPDF_EXPORT char const* pde_qpdf_last_error(void);
PDE_QPDF_EXPORT void pde_qpdf_free(void* pointer);

#ifdef __cplusplus
}
#endif

#endif
