#ifndef PDF_EDITOR_NATIVE_FILE_PATH_H_
#define PDF_EDITOR_NATIVE_FILE_PATH_H_

#include <limits>
#include <string>
#include <string_view>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

namespace pdf_editor {

#if defined(_WIN32)
inline std::wstring NativeWidePath(std::string_view path) {
  if (path.empty() || path.size() > static_cast<size_t>(std::numeric_limits<int>::max())) return {};
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
      path.data(), static_cast<int>(path.size()), nullptr, 0);
  if (length <= 0) return {};
  std::wstring wide(static_cast<size_t>(length), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path.data(),
      static_cast<int>(path.size()), wide.data(), length) != length) return {};
  if (wide.starts_with(L"\\\\?\\")) return wide;

  // Resolve relative paths and dot segments before adding the extended-length
  // prefix, which otherwise disables the Win32 path normalization rules.
  const DWORD needed = GetFullPathNameW(wide.c_str(), 0, nullptr, nullptr);
  if (!needed) return {};
  std::wstring absolute(needed, L'\0');
  const DWORD written = GetFullPathNameW(wide.c_str(), needed, absolute.data(), nullptr);
  if (!written || written >= needed) return {};
  absolute.resize(written);
  if (absolute.starts_with(L"\\\\")) return L"\\\\?\\UNC\\" + absolute.substr(2);
  return L"\\\\?\\" + absolute;
}
#endif

inline std::string NativeFilePathUtf8(std::string_view path) {
#if defined(_WIN32)
  const std::wstring wide = NativeWidePath(path);
  if (wide.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
      static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0) return {};
  std::string result(static_cast<size_t>(length), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
      static_cast<int>(wide.size()), result.data(), length, nullptr, nullptr) != length) return {};
  return result;
#else
  return std::string(path);
#endif
}

}  // namespace pdf_editor
#endif
