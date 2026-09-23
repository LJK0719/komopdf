#include "pdf_editor/session_history.h"

#include <stdexcept>
#include <utility>

namespace pdf_editor {
SessionHistory::SessionHistory(std::string id, std::size_t limit)
    : document_id_(std::move(id)), undo_limit_(limit) {
  if (document_id_.empty() || limit == 0) throw std::invalid_argument("Invalid history configuration");
}
void SessionHistory::CheckBase(const std::string& id, std::uint64_t revision) const {
  if (id != document_id_ || revision != revision_) throw std::invalid_argument("STALE_REVISION");
}
void SessionHistory::CheckNewTransaction(const std::string& id) const {
  if (id.empty() || transaction_ids_.contains(id)) throw std::invalid_argument("Duplicate or empty transaction identity");
}
void SessionHistory::RecordCommit(CommittedEdit edit) {
  CheckNewTransaction(edit.transaction_id);
  transaction_ids_.insert(edit.transaction_id);
  recovery_log_.push_back({++revision_, JournalAction::Apply, edit});
  undo_.push_back(std::move(edit));
  if (undo_.size() > undo_limit_) undo_.erase(undo_.begin());
  redo_.clear();
}
const CommittedEdit& SessionHistory::PeekUndo() const {
  if (!can_undo()) throw std::logic_error("Nothing to undo");
  return undo_.back();
}
const CommittedEdit& SessionHistory::PeekRedo() const {
  if (!can_redo()) throw std::logic_error("Nothing to redo");
  return redo_.back();
}
void SessionHistory::RecordUndo() {
  const auto edit = PeekUndo();
  recovery_log_.push_back({++revision_, JournalAction::Undo, edit});
  redo_.push_back(edit);
  undo_.pop_back();
}
void SessionHistory::RecordRedo() {
  const auto edit = PeekRedo();
  recovery_log_.push_back({++revision_, JournalAction::Redo, edit});
  undo_.push_back(edit);
  redo_.pop_back();
}
void SessionHistory::MarkSaved(std::uint64_t revision) {
  if (revision > revision_ || revision < saved_revision_) throw std::invalid_argument("Invalid saved revision");
  saved_revision_ = revision;
}
}  // namespace pdf_editor
