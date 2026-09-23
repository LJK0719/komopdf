#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
archive="${1:?Pass the pinned libjpeg-turbo-3.2.0.tar.gz archive}"
install="${2:?Pass a project-local x64 installation directory}"
work="$root/tmp/qpdf-work/jpeg-x64"
printf '%s  %s\n' 6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e "$archive" | /usr/bin/shasum -a 256 -c -
mkdir -p "$work"
if [ ! -f "$work/libjpeg-turbo-3.2.0/CMakeLists.txt" ]; then
  /usr/bin/tar -xzf "$archive" -C "$work"
fi
cmake -S "$work/libjpeg-turbo-3.2.0" -B "$work/build" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_OSX_ARCHITECTURES=x86_64 \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 -DENABLE_SHARED=OFF \
  -DENABLE_STATIC=ON -DWITH_SIMD=OFF -DCMAKE_INSTALL_PREFIX="$install"
cmake --build "$work/build" --parallel 4
cmake --install "$work/build"
mkdir -p "$install/share/doc/libjpeg-turbo"
/bin/cp "$work/libjpeg-turbo-3.2.0/LICENSE.md" "$install/share/doc/libjpeg-turbo/LICENSE.md"
/usr/bin/lipo -info "$install/lib/libjpeg.a"
