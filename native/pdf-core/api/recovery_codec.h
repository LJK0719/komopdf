#ifndef PDF_EDITOR_RECOVERY_CODEC_H_
#define PDF_EDITOR_RECOVERY_CODEC_H_

#include <bit>
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace pdf_editor {

class RecoveryWriter {
 public:
  void Integer(uint64_t value) {
    for (unsigned shift = 0; shift < 64; shift += 8)
      bytes.push_back(static_cast<uint8_t>(value >> shift));
  }
  void Number(double value) { Integer(std::bit_cast<uint64_t>(value)); }
  void Blob(std::span<const uint8_t> value) {
    Integer(value.size());
    bytes.insert(bytes.end(), value.begin(), value.end());
  }
  void String(std::string_view value) {
    Blob({reinterpret_cast<const uint8_t*>(value.data()), value.size()});
  }
  std::vector<uint8_t> bytes;
};

class RecoveryReader {
 public:
  explicit RecoveryReader(std::span<const uint8_t> data) : data_(data) {}
  uint64_t Integer() {
    if (data_.size() < 8) Invalid();
    uint64_t value = 0;
    for (unsigned index = 0; index < 8; ++index)
      value |= static_cast<uint64_t>(data_[index]) << (index * 8);
    data_ = data_.subspan(8);
    return value;
  }
  uint32_t Uint32() {
    const uint64_t value = Integer();
    if (value > std::numeric_limits<uint32_t>::max()) Invalid();
    return static_cast<uint32_t>(value);
  }
  double Number() { return std::bit_cast<double>(Integer()); }
  std::span<const uint8_t> Blob() {
    const uint64_t size = Integer();
    if (size > data_.size()) Invalid();
    const auto value = data_.first(static_cast<size_t>(size));
    data_ = data_.subspan(static_cast<size_t>(size));
    return value;
  }
  std::string String() {
    const auto value = Blob();
    return {reinterpret_cast<const char*>(value.data()), value.size()};
  }
  size_t Count() {
    const uint64_t value = Integer();
    // Every sequence item contains at least one 64-bit length or integer.
    if (value > data_.size() / 8) Invalid();
    return static_cast<size_t>(value);
  }
  bool Done() const { return data_.empty(); }
  [[noreturn]] static void Invalid() {
    throw std::runtime_error("Invalid or incompatible recovery snapshot.");
  }
 private:
  std::span<const uint8_t> data_;
};

}  // namespace pdf_editor
#endif
