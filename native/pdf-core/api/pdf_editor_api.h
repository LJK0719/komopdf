#ifndef PDF_EDITOR_API_H
#define PDF_EDITOR_API_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// ABI 3. Calls are serialized by the host. Handles are private to the adapter;
// document/page/object IDs exposed to the editor are strings, not PDF pointers.
uint32_t pde_abi_version(void);
// Returns the global command-name JSON array implemented by this core build.
const char* pde_capabilities(void);
int pde_initialize(void);
void pde_shutdown(void);

// The core copies memory input and retains an immutable source until close.
// The caller creates a fresh document_id for each open/recovery session.
uint32_t pde_open_memory(const uint8_t* bytes,
                         uint32_t length,
                         const char* document_id,
                         const char* source_id,
                         const char* password_utf8);
// Native hosts pass an authorized immutable source copy, never a WebView path.
uint32_t pde_open_file_utf8(const char* path_utf8,
                            const char* document_id,
                            const char* source_id,
                            const char* password_utf8);
int pde_close(uint32_t document);

// Returns UTF-8 JSON matching contracts, or NULL on error. A returned string
// remains valid until the next operation, excluding the binary/error getters.
const char* pde_document_info(uint32_t document);
const char* pde_describe_page(uint32_t document, uint32_t page_index);
const char* pde_extract_page(uint32_t document, uint32_t page_index);

// Render an explicit viewport in normalized page coordinates. full_width and
// full_height are the full-page pixel size; offsets place it inside the bitmap.
// Placement offsets are zero or negative, as in FPDF_RenderPageBitmap.
// Returns RenderResult metadata WITHOUT pixels; binary getters expose RGBA.
const char* pde_render(uint32_t document,
                       uint32_t page_index,
                       uint32_t width,
                       uint32_t height,
                       int32_t offset_x,
                       int32_t offset_y,
                       uint32_t full_width,
                       uint32_t full_height);

// Unchanged documents save as the exact immutable source. Edited documents
// serialize the committed PDFium state. Export reports the current revision but
// savedRevision advances only through pde_confirm_save() after host
// persistence.
const char* pde_save_memory(uint32_t document);
// Use a new staging destination. Existing files are never truncated here;
// the native host owns the final user-confirmed atomic replacement.
int pde_save_file_utf8(uint32_t document, const char* destination_utf8);

// ABI 2 editing entry points. Read entry points keep their ABI 1 signatures.
// Native callers use this C layout; wasm32 adapters check the returned stride
// before packing the six 32-bit fields (24 bytes) in linear memory.
typedef struct PdeTextEdit {
  uint32_t page_index;
  const char* block_id;
  uint32_t start_utf16;
  uint32_t end_utf16;
  const char* replacement_utf8;
  const char* font_id;  // NULL preserves the current font.
} PdeTextEdit;
uint32_t pde_text_edit_stride(void);
// Legacy registration: accepts one standalone TrueType face only.
int pde_register_truetype_font(const char* font_id,
                               const uint8_t* bytes,
                               uint32_t length);
// Returns a FontFaceInfo[] JSON array for a standalone SFNT or collection.
const char* pde_font_faces(const uint8_t* bytes, uint32_t length);
// Registers one immutable face and returns its FontFaceInfo plus id/faceIndex.
const char* pde_register_font(const char* font_id,
                              const uint8_t* bytes,
                              uint32_t length,
                              uint32_t face_index);
// Preview never changes the committed document. JSON is TextLayoutResult,
// optionally with replacementFontId to disclose a selected fallback.
const char* pde_preview_text(uint32_t document, const PdeTextEdit* edit);
// The whole batch commits once, or the previously committed state is retained.
// JSON is CommitResult. Caller-owned strings are copied into the recovery log.
const char* pde_apply_text(uint32_t document,
                           uint32_t base_revision,
                           const char* transaction_id,
                           const PdeTextEdit* edits,
                           uint32_t count);

// ABI 3 command layout. wasm32 has twelve 32-bit scalar/pointer fields followed
// by ten doubles at offset 48, for an exact stride of 128 bytes. Native callers
// must use this C structure and pde_edit_command_stride(); a 64-bit native
// structure is intentionally larger than the wasm32 record. For type 3,
// flags 1/2/4/8 keep font/size/color/character-spacing; flag 16 enables
// values[9] as a line-height multiplier, and mutually exclusive flags 32/64
// select center/right alignment (neither means left). For type 2, flag 16
// enables start_utf16/end_utf16 range formatting of exactly one block in ids;
// flags 1/2/4/8 and their values retain the whole-block style layout.
// Type 3 also accepts 128=invisible, 256=fitBounds (requires invisible),
// 512=OCR (requires both), or 1024=logical paragraph (mutually exclusive).
// Type 20 is paragraph reflow: type-3 geometry/style plus ids=source block IDs;
// target_id is the new logical object's ID and flag 1024 is required.
// Type 21 aligns two or more top-level object IDs on one page; values[0] is
// 0=left, 1=center, 2=right, 3=top, 4=middle, 5=bottom.
// Types 22/23 update or delete a persistent annotation on page_id. Type 22
// takes the same complete appearance/geometry payload as annotation.add;
// both preserve the annotation ID and enter the ordinary PDF transaction.
// Type 24 distributes three or more top-level objects by center within the
// selected outer centers; values[0] 0=horizontal, 1=vertical.
// Type 25 crops each page in ids to a top-left normalized rectangle in
// values[0..3]. Pixels outside CropBox remain in the PDF; this is not redaction.
// Type 26 groups two or more adjacent top-level objects in ids as a persistent
// Form XObject with target_id=groupId; type 27 ungroups target_id=groupId.
// Nested Form children, MCIDs and cross-stream members need fuller structural
// rewriting and are rejected rather than silently changing drawing order.
typedef struct PdeEditCommand {
  uint32_t type;
  const char* page_id;
  const char* target_id;
  const char* resource_id;
  const char* text_utf8;
  const char* font_id;
  const char* const* ids;
  uint32_t id_count;
  uint32_t start_utf16;
  uint32_t end_utf16;
  uint32_t flags;
  uint32_t resource_page_index;
  double values[10];
} PdeEditCommand;

uint32_t pde_edit_command_stride(void);
int pde_register_rgba_image(uint32_t document,
                            const char* id,
                            uint32_t width,
                            uint32_t height,
                            const uint8_t* rgba,
                            uint32_t length);
const char* pde_register_pdf_resource(uint32_t document,
                                      const char* id,
                                      const uint8_t* bytes,
                                      uint32_t length);
const char* pde_preview_commands(uint32_t document,
                                 uint32_t base_revision,
                                 const PdeEditCommand* commands,
                                 uint32_t count);
// Previews one type-3 text.insert or type-20 text.reflow command on a real candidate.
// Returns TextLayoutResult JSON. Overflow is reported without committing;
// all other command types are rejected.
const char* pde_preview_text_insert(uint32_t document,
                                    uint32_t base_revision,
                                    const PdeEditCommand* command);
const char* pde_apply_commands(uint32_t document,
                               uint32_t base_revision,
                               const char* transaction_id,
                               const PdeEditCommand* commands,
                               uint32_t count);
const char* pde_confirm_save(uint32_t document, uint32_t saved_revision);

// Local recovery archives preserve the immutable source, complete transaction
// history, IDs and resources. Passwords are never included; protected sources
// require a password again on restore. Native paths are host-owned staging files.
const char* pde_export_recovery(uint32_t document);
const char* pde_recovery_resources(uint32_t document);
const char* pde_describe_forms(uint32_t document);
const char* pde_describe_annotations(uint32_t document, uint32_t page_index);
// Read-only outline entries in display order. Invalid or external destinations
// have a null page ID; no actions or PDF JavaScript are executed.
const char* pde_describe_outline(uint32_t document);
const char* pde_export_recovery_file_utf8(uint32_t document, const char* path_utf8);
uint32_t pde_restore_recovery(const uint8_t* bytes, uint32_t length,
                              const char* password_utf8);
uint32_t pde_restore_recovery_file_utf8(const char* path_utf8,
                                        const char* password_utf8);
const char* pde_document_id(uint32_t document);
uint32_t pde_document_revision(uint32_t document);

const char* pde_undo(uint32_t document);
const char* pde_redo(uint32_t document);

// Binary data remains owned by the core. Copy before the next operation;
// do not transfer/detach WebAssembly linear memory itself.
const uint8_t* pde_binary_data(void);
uint32_t pde_binary_size(void);
const char* pde_error_code(void);
const char* pde_error_message(void);

#ifdef __cplusplus
}
#endif
#endif
