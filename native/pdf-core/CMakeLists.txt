cmake_minimum_required(VERSION 3.25)
project(pdf_editor_core VERSION 0.1.0 LANGUAGES CXX)

add_library(pdf_editor_foundation STATIC src/geometry.cc src/session_history.cc)
target_include_directories(pdf_editor_foundation PUBLIC include)
target_compile_features(pdf_editor_foundation PUBLIC cxx_std_20)
if(MSVC)
  target_compile_options(pdf_editor_foundation PUBLIC /utf-8 PRIVATE /W4)
else()
  target_compile_options(pdf_editor_foundation PRIVATE -Wall -Wextra -Wpedantic)
endif()

include(CTest)
if(BUILD_TESTING)
  add_executable(pdf_editor_foundation_test tests/foundation_test.cc)
  target_link_libraries(pdf_editor_foundation_test PRIVATE pdf_editor_foundation)
  add_test(NAME foundation COMMAND pdf_editor_foundation_test)
endif()

# PDFium 内部扩展单独接入固定源码 GN 构建；此基础库不是 PDF 解析器。
