#pragma once

#include <cstdint>
#include <string>
#include <unordered_set>
#include <vector>

namespace pdf_editor {
struct CommittedEdit {
  std::string transaction_id;
  std::string forward_commands;
  std::string inverse_commands;
  std::vector<std::string> resource_ids;
};
enum class JournalAction { Apply, Undo, Redo };
struct JournalEntry {
  std::uint64_t revision;
  JournalAction action;
  CommittedEdit edit;
};

// 只在 PDF 核心成功原子提交后记录；不持有另一份 PDF 状态。
class SessionHistory {
 public:
  explicit SessionHistory(std::string document_id, std::size_t undo_limit = 100);
  void CheckBase(const std::string& document_id, std::uint64_t revision) const;
  void CheckNewTransaction(const std::string& transaction_id) const;
  void RecordCommit(CommittedEdit edit);
  const CommittedEdit& PeekUndo() const;
  const CommittedEdit& PeekRedo() const;
  void RecordUndo();
  void RecordRedo();
  void MarkSaved(std::uint64_t revision);
  std::uint64_t revision() const { return revision_; }
  std::uint64_t saved_revision() const { return saved_revision_; }
  bool can_undo() const { return !undo_.empty(); }
  bool can_redo() const { return !redo_.empty(); }
  const std::vector<JournalEntry>& recovery_log() const { return recovery_log_; }
 private:
  std::string document_id_;
  std::size_t undo_limit_;
  std::uint64_t revision_ = 0;
  std::uint64_t saved_revision_ = 0;
  std::vector<CommittedEdit> undo_;
  std::vector<CommittedEdit> redo_;
  std::vector<JournalEntry> recovery_log_;
  std::unordered_set<std::string> transaction_ids_;
};
}  // namespace pdf_editor
