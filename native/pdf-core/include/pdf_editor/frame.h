#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>

namespace pdf_editor {
enum class FrameType : std::uint16_t { Control = 1, BinaryChunk = 2 };
struct FrameHeader { FrameType type; std::uint32_t length; std::uint32_t sequence; };
constexpr std::size_t kFrameHeaderBytes = 16;
constexpr std::uint32_t kControlBytes = 1024 * 1024;
constexpr std::uint32_t kBinaryChunkBytes = 1024 * 1024;

// PDFE | u16 protocol | u16 type | u32 payload length | u32 sequence; little-endian.
inline FrameHeader DecodeFrameHeader(std::span<const std::uint8_t> bytes) {
  if (bytes.size() < kFrameHeaderBytes || bytes[0] != 'P' || bytes[1] != 'D' ||
      bytes[2] != 'F' || bytes[3] != 'E') throw std::invalid_argument("Invalid frame magic");
  const auto u16 = [&](int offset) { return static_cast<std::uint16_t>(bytes[offset] | bytes[offset + 1] << 8); };
  const auto u32 = [&](int offset) { return static_cast<std::uint32_t>(bytes[offset]) |
      static_cast<std::uint32_t>(bytes[offset + 1]) << 8 |
      static_cast<std::uint32_t>(bytes[offset + 2]) << 16 |
      static_cast<std::uint32_t>(bytes[offset + 3]) << 24; };
  if (u16(4) != 1) throw std::invalid_argument("Incompatible worker protocol");
  const auto type = static_cast<FrameType>(u16(6));
  if (type != FrameType::Control && type != FrameType::BinaryChunk) throw std::invalid_argument("Unknown frame type");
  const auto length = u32(8);
  const auto limit = type == FrameType::Control ? kControlBytes : kBinaryChunkBytes;
  if (length > limit) throw std::length_error("Frame exceeds limit");
  return {type, length, u32(12)};
}

inline std::array<std::uint8_t, kFrameHeaderBytes> EncodeFrameHeader(FrameHeader header) {
  std::array<std::uint8_t, kFrameHeaderBytes> bytes{'P', 'D', 'F', 'E', 1, 0};
  const auto type = static_cast<std::uint16_t>(header.type);
  bytes[6] = type & 0xff; bytes[7] = (type >> 8) & 0xff;
  for (int i = 0; i < 4; ++i) {
    bytes[8 + i] = static_cast<std::uint8_t>(header.length >> (8 * i));
    bytes[12 + i] = static_cast<std::uint8_t>(header.sequence >> (8 * i));
  }
  DecodeFrameHeader(bytes);
  return bytes;
}
}  // namespace pdf_editor
