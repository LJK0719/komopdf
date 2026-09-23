#include "pdf_editor/geometry.h"
#include "pdf_editor/frame.h"
#include "pdf_editor/session_history.h"

#include <cmath>
#include <iostream>
#include <stdexcept>

using namespace pdf_editor;
void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
void Near(double actual, double expected) { Require(std::abs(actual - expected) < 1e-8, "Coordinate mismatch"); }
int main() {
  try {
    const PdfBox media{-20, -30, 600, 900};
    const PdfBox crop{10, 20, 210, 320};
    for (int rotation : {0, 90, 180, 270}) {
      const auto geometry = NormalizePage(media, crop, rotation, 2);
      Near(geometry.width_pt, rotation % 180 == 0 ? 400 : 600);
      Near(geometry.height_pt, rotation % 180 == 0 ? 600 : 400);
      const auto rect = geometry.pdf_to_page.ApplyBounds({10, 20, 200, 300});
      Near(rect.x, 0); Near(rect.y, 0);
      Near(rect.width, geometry.width_pt); Near(rect.height, geometry.height_pt);
      const Point input{37, 121};
      const auto output = geometry.page_to_pdf.Apply(geometry.pdf_to_page.Apply(input));
      Near(input.x, output.x); Near(input.y, output.y);
    }
    const auto rotated = NormalizePage(media, crop, 90, 2);
    const auto origin = rotated.pdf_to_page.Apply({10, 20});
    Near(origin.x, 0); Near(origin.y, 0);
    const auto clipped = NormalizePage(media, PdfBox{-50, -50, 100, 100}, 0);
    Near(clipped.width_pt, 120); Near(clipped.height_pt, 130);
    const Matrix move{1, 0, 0, 1, 10, 20};
    const Matrix scale{2, 0, 0, 2, 0, 0};
    const auto composed = move.Then(scale).Apply({1, 2});
    Near(composed.x, 22); Near(composed.y, 44);
    std::cout << "PASS geometry: crop, rotation, user-unit, inverse, composition\n";

    const auto header = EncodeFrameHeader({FrameType::BinaryChunk, 65536, 7});
    const std::array<std::uint8_t, 16> golden{80, 68, 70, 69, 1, 0, 2, 0, 0, 0, 1, 0, 7, 0, 0, 0};
    Require(header == golden, "Wire protocol differs from shared contract");
    const auto decoded = DecodeFrameHeader(header);
    Require(decoded.length == 65536 && decoded.sequence == 7, "Header round trip failed");
    bool oversized_rejected = false;
    try { EncodeFrameHeader({FrameType::Control, 1024 * 1024 + 1, 1}); }
    catch (const std::length_error&) { oversized_rejected = true; }
    Require(oversized_rejected, "Oversized frame was accepted before allocation");
    std::cout << "PASS frames: cross-language golden bytes and length limit\n";

    SessionHistory history("doc-1");
    for (int i = 0; i < 101; ++i) {
      history.CheckBase("doc-1", i);
      history.RecordCommit({"tx-" + std::to_string(i), "forward", "inverse", {"font-1"}});
    }
    Require(history.recovery_log().size() == 101, "Recovery log was truncated");
    history.MarkSaved(101);
    Require(history.recovery_log().size() == 101, "Save truncated recovery log");
    for (int i = 0; i < 100; ++i) history.RecordUndo();
    Require(!history.can_undo(), "Undo limit not enforced");
    Require(history.recovery_log().size() == 201, "Undo lost recovery events");
    history.RecordRedo();
    Require(history.revision() == 202 && history.saved_revision() == 101, "Revision mismatch");
    history.RecordCommit({"new-branch", "forward", "inverse", {}});
    Require(!history.can_redo(), "Branch retained redo history");
    Require(history.recovery_log().size() == 203, "Branch lost recovery events");
    bool stale_rejected = false;
    try { history.CheckBase("restored-doc", history.revision()); }
    catch (const std::invalid_argument&) { stale_rejected = true; }
    Require(stale_rejected, "Old instance accepted");
    bool duplicate_rejected = false;
    try { history.CheckNewTransaction("tx-0"); }
    catch (const std::invalid_argument&) { duplicate_rejected = true; }
    Require(duplicate_rejected, "Evicted transaction ID reused");
    std::cout << "PASS history: 101 edits, 100 undo, save, redo, branch, identity\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
