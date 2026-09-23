cmake_minimum_required(VERSION 3.16)

project(pdf_editor_qpdf LANGUAGES C CXX)

if(NOT QPDF_SOURCE_DIR)
  message(FATAL_ERROR "QPDF_SOURCE_DIR must point to the pinned qpdf source tree")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(MSVC)
  add_compile_options(/utf-8)
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(BUILD_STATIC_LIBS ON CACHE BOOL "" FORCE)
set(BUILD_DOC OFF CACHE BOOL "" FORCE)
set(BUILD_DOC_HTML OFF CACHE BOOL "" FORCE)
set(BUILD_DOC_PDF OFF CACHE BOOL "" FORCE)
set(BUILD_DOC_DIST OFF CACHE BOOL "" FORCE)
set(ENABLE_COVERAGE OFF CACHE BOOL "" FORCE)
set(ENABLE_QTC OFF CACHE BOOL "" FORCE)
set(GENERATE_AUTO_JOB OFF CACHE BOOL "" FORCE)
set(INSTALL_CMAKE_PACKAGE OFF CACHE BOOL "" FORCE)
set(INSTALL_EXAMPLES OFF CACHE BOOL "" FORCE)
set(INSTALL_MANUAL OFF CACHE BOOL "" FORCE)
set(INSTALL_PKGCONFIG OFF CACHE BOOL "" FORCE)
set(MAINTAINER_MODE OFF CACHE BOOL "" FORCE)
set(REQUIRE_SHELLS OFF CACHE BOOL "" FORCE)
set(WERROR OFF CACHE BOOL "" FORCE)
set(ZOPFLI OFF CACHE BOOL "" FORCE)

if(EMSCRIPTEN)
  set(USE_IMPLICIT_CRYPTO OFF CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_NATIVE ON CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_OPENSSL OFF CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_GNUTLS OFF CACHE BOOL "" FORCE)
  set(DEFAULT_CRYPTO native CACHE STRING "" FORCE)
elseif(APPLE)
  set(USE_IMPLICIT_CRYPTO OFF CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_NATIVE ON CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_OPENSSL OFF CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_GNUTLS OFF CACHE BOOL "" FORCE)
  set(DEFAULT_CRYPTO native CACHE STRING "" FORCE)
else()
  set(USE_IMPLICIT_CRYPTO ON CACHE BOOL "" FORCE)
  set(ALLOW_CRYPTO_NATIVE ON CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_NATIVE ON CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_OPENSSL ON CACHE BOOL "" FORCE)
  set(REQUIRE_CRYPTO_GNUTLS OFF CACHE BOOL "" FORCE)
  set(DEFAULT_CRYPTO openssl CACHE STRING "" FORCE)
endif()

add_subdirectory("${QPDF_SOURCE_DIR}" qpdf-upstream EXCLUDE_FROM_ALL)

# Pl_DCT's public header includes jpeglib.h; qpdf keeps its JPEG include
# directory private, so the image optimizer needs it explicitly as well.
if(MSVC)
  set(PDE_JPEG_INCLUDE "${QPDF_SOURCE_DIR}/vcpkg/installed/x64-windows-static/include")
elseif(APPLE)
  set(PDE_JPEG_INCLUDE "${LIBJPEG_H_PATH}")
endif()

add_library(pdf_editor_qpdf_bridge STATIC src/pdf_editor_qpdf.cpp src/image_optimizer.cpp)
target_include_directories(pdf_editor_qpdf_bridge PUBLIC include PRIVATE ${PDE_JPEG_INCLUDE})
target_link_libraries(pdf_editor_qpdf_bridge PUBLIC libqpdf)
set_target_properties(pdf_editor_qpdf_bridge PROPERTIES OUTPUT_NAME "pdf-editor-qpdf-bridge")

if(EMSCRIPTEN)
  add_executable(pdf_editor_qpdf_wasm src/pdf_editor_qpdf.cpp src/image_optimizer.cpp)
  target_include_directories(pdf_editor_qpdf_wasm PRIVATE include ${PDE_JPEG_INCLUDE})
  target_link_libraries(pdf_editor_qpdf_wasm PRIVATE libqpdf)
  target_compile_options(pdf_editor_qpdf_wasm PRIVATE -fexceptions)
  target_link_options(pdf_editor_qpdf_wasm PRIVATE
    --no-entry
    -fexceptions
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sINITIAL_MEMORY=67108864
    -sMAXIMUM_MEMORY=1073741824
    -sUSE_ZLIB=1
    -sUSE_LIBJPEG=1
    "-sEXPORTED_FUNCTIONS=['_pde_qpdf_abi_version','_pde_qpdf_version','_pde_qpdf_transform','_pde_qpdf_optimize_images','_pde_qpdf_resample_images','_pde_qpdf_last_error','_pde_qpdf_free','_malloc','_free']"
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAPU32','UTF8ToString','stringToUTF8','lengthBytesUTF8']")
  set_target_properties(pdf_editor_qpdf_wasm PROPERTIES
    OUTPUT_NAME "pdf-editor-qpdf"
    SUFFIX ".js")
else()
  add_executable(pdf_editor_qpdf_cli src/qpdf_job_main.cpp src/image_optimizer.cpp)
  target_include_directories(pdf_editor_qpdf_cli PRIVATE ${PDE_JPEG_INCLUDE})
  target_link_libraries(pdf_editor_qpdf_cli PRIVATE libqpdf)
  set_target_properties(pdf_editor_qpdf_cli PROPERTIES OUTPUT_NAME "pdf-editor-qpdf")
endif()

option(PDE_QPDF_TESTS "Build focused qpdf bridge tests" OFF)
if(PDE_QPDF_TESTS AND NOT EMSCRIPTEN)
  add_executable(pdf_editor_qpdf_resample_test tests/test_resample_api.cpp)
  target_include_directories(pdf_editor_qpdf_resample_test PRIVATE include)
  target_link_libraries(pdf_editor_qpdf_resample_test PRIVATE pdf_editor_qpdf_bridge)
endif()
