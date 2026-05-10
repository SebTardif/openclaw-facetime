#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper_dir="${repo_root}/helper"
build_dir="${TMPDIR:-/tmp}/openclaw-facetime-macabi"
sdk_root="/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
clang_bin="/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang"
staged_dir="${HOME}/Library/Containers/com.apple.FaceTime/Data/tmp"
staged_dylib="${staged_dir}/FaceTimeHelper.dylib"

mkdir -p "${build_dir}" "${staged_dir}"

DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer "${clang_bin}" \
  -target arm64e-apple-ios15.0-macabi \
  -dynamiclib \
  -isysroot "${sdk_root}" \
  -fobjc-arc \
  -fmodules \
  -DDEBUG=1 \
  -ObjC \
  -I "${helper_dir}/FaceTimeHelper" \
  -I "${helper_dir}/FaceTimeHelper/FaceTime" \
  -I "${helper_dir}/FaceTimeHelper/ZKSwizzle" \
  -I "${helper_dir}/Pods/CocoaAsyncSocket/Source/GCD" \
  -iframework /System/Library/PrivateFrameworks \
  "${helper_dir}/FaceTimeHelper/FaceTimeHelper.m" \
  "${helper_dir}/FaceTimeHelper/NetworkController.m" \
  "${helper_dir}/FaceTimeHelper/CTBlockDescription.m" \
  "${helper_dir}/FaceTimeHelper/ZKSwizzle/ZKSwizzle.m" \
  "${helper_dir}/Pods/CocoaAsyncSocket/Source/GCD/GCDAsyncSocket.m" \
  -framework Foundation \
  -framework CoreServices \
  -framework Security \
  -framework TelephonyUtilities \
  -framework IMCore \
  -o "${build_dir}/FaceTimeHelper.dylib"

codesign --force --sign - "${build_dir}/FaceTimeHelper.dylib"
cp "${build_dir}/FaceTimeHelper.dylib" "${staged_dylib}"
codesign --force --sign - "${staged_dylib}"

echo "${staged_dylib}"
