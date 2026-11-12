#!/usr/bin/env bash
# Slim LGPL ffmpeg for the MAXCOM Android box. Runs INSIDE the pinned Docker image started by
# build-ffmpeg-android.ps1 (no network). Inputs come from the environment:
#   ABI                armeabi-v7a | arm64-v8a
#   API_LEVEL          Android API level (28)
#   NDK_ROOT           extracted Linux NDK (volume mounted by the wrapper)
#   SRC_DIR            folder holding the three source tarballs (already hash-checked by the wrapper)
#   FFMPEG_FILE OPUS_FILE MBEDTLS_FILE and *_SHA256   tarball names and expected sha256 (checked again here)
#   *_VERSION          versions, written to the build info
#   FEATURES           path of ffmpeg-features.json (the one feature list)
#   OUT                output folder (jniLibs/<abi>/libffmpeg.so and ffmpeg-build-info.txt land here)
# The binary is linked dynamically against bionic (libc, libm, libdl) only; every other library is static.
set -euo pipefail

: "${ABI:?}" "${API_LEVEL:?}" "${NDK_ROOT:?}" "${SRC_DIR:?}" "${FEATURES:?}" "${OUT:?}"
: "${FFMPEG_FILE:?}" "${FFMPEG_SHA256:?}" "${OPUS_FILE:?}" "${OPUS_SHA256:?}" "${MBEDTLS_FILE:?}" "${MBEDTLS_SHA256:?}"
JOBS="${JOBS:-$(nproc)}"
WORK="${WORK:-/tmp/ffwork}"

log() { printf '== %s\n' "$*"; }
die() { printf 'GAGAL: %s\n' "$*" >&2; exit 1; }

verify_src() {
  local f="$SRC_DIR/$1" want="$2" got
  [ -f "$f" ] || die "tarball tiada: $f"
  got="$(sha256sum "$f" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || die "sha256 tidak sepadan untuk $1 (dapat $got, mahu $want)"
}

verify_src "$FFMPEG_FILE" "$FFMPEG_SHA256"
verify_src "$OPUS_FILE" "$OPUS_SHA256"
verify_src "$MBEDTLS_FILE" "$MBEDTLS_SHA256"

TC="$NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin"
[ -x "$TC/llvm-ar" ] || die "NDK tidak ditemui di $NDK_ROOT"
case "$ABI" in
  armeabi-v7a)
    TRIPLE="armv7a-linux-androideabi"; HOST_TRIPLE="arm-linux-androideabi"; FF_ARCH="arm"; FF_CPU="armv7-a"
    # No assembly on armv7: text relocations are refused on Android, and the relay needs no SIMD.
    ARCH_FF_FLAGS=(--disable-asm); ARCH_OPUS_FLAGS=(--disable-asm --disable-intrinsics); ARCH_LD=""
    ;;
  arm64-v8a)
    TRIPLE="aarch64-linux-android"; HOST_TRIPLE="aarch64-linux-android"; FF_ARCH="aarch64"; FF_CPU="armv8-a"
    ARCH_FF_FLAGS=(); ARCH_OPUS_FLAGS=(); ARCH_LD="-Wl,-z,max-page-size=16384"
    ;;
  *) die "ABI tidak dikenali: $ABI" ;;
esac
CC="$TC/${TRIPLE}${API_LEVEL}-clang"
[ -x "$CC" ] || die "pengkompil tiada: $CC"

# ---- feature list -> configure flags (the JSON is the single source) ----
mapfile -t FEATURE_FLAGS < <(python3 - "$FEATURES" <<'PY'
import json, sys
f = json.load(open(sys.argv[1]))
kinds = {"protocols": "protocol", "demuxers": "demuxer", "muxers": "muxer", "encoders": "encoder",
         "decoders": "decoder", "parsers": "parser", "bsfs": "bsf", "filters": "filter"}
for key, kind in kinds.items():
    for name in f[key]:
        print(f"--enable-{kind}={name}")
for lib in f["externalLibs"]:
    print(f"--enable-{lib}")
PY
)
[ "${#FEATURE_FLAGS[@]}" -gt 10 ] || die "senarai ciri kosong"

common_flags() {
  printf '%s\n' --disable-everything --disable-autodetect --disable-doc --disable-ffplay --disable-ffprobe \
    --disable-avdevice --disable-swscale --disable-debug --enable-version3 --enable-small \
    --enable-swresample --enable-avfilter --enable-pic
  printf '%s\n' "${FEATURE_FLAGS[@]}"
}

rm -rf "$WORK"; mkdir -p "$WORK" "$OUT/jniLibs/$ABI"
tar -C "$WORK" -xf "$SRC_DIR/$FFMPEG_FILE"
tar -C "$WORK" -xf "$SRC_DIR/$OPUS_FILE"
tar -C "$WORK" -xf "$SRC_DIR/$MBEDTLS_FILE"
FFSRC="$(echo "$WORK"/ffmpeg-*/)"; OPUSSRC="$(echo "$WORK"/opus-*/)"; MBEDSRC="$(echo "$WORK"/mbedtls-*/)"

# ---- static libraries: $1 = prefix, $2 = android|host ----
build_libs() {
  local prefix="$1" mode="$2" ccbin arbin ranlibbin
  mkdir -p "$prefix"
  if [ "$mode" = android ]; then ccbin="$CC"; arbin="$TC/llvm-ar"; ranlibbin="$TC/llvm-ranlib"; else ccbin="$(command -v gcc)"; arbin="$(command -v ar)"; ranlibbin="$(command -v ranlib)"; fi

  log "libopus ($mode)"
  rm -rf "$WORK/opus-$mode"; mkdir -p "$WORK/opus-$mode"
  ( cd "$WORK/opus-$mode"
    local hostarg=() flags=()
    if [ "$mode" = android ]; then hostarg=(--host="$HOST_TRIPLE"); flags=("${ARCH_OPUS_FLAGS[@]}"); fi
    CC="$ccbin" AR="$arbin" RANLIB="$ranlibbin" CFLAGS="-Os -fPIC" \
      "$OPUSSRC/configure" "${hostarg[@]}" --prefix="$prefix" --disable-shared --enable-static --with-pic \
      --disable-doc --disable-extra-programs "${flags[@]}" >configure.log 2>&1 || { tail -40 configure.log; die "libopus configure"; }
    make -j"$JOBS" >make.log 2>&1 || { tail -40 make.log; die "libopus make"; }
    make install >install.log 2>&1 )

  log "mbedTLS ($mode)"
  rm -rf "$WORK/mbed-$mode"; mkdir -p "$WORK/mbed-$mode"
  ( cd "$WORK/mbed-$mode"
    cmake -S "$MBEDSRC" -B . -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$prefix" \
      -DCMAKE_C_COMPILER="$ccbin" -DCMAKE_AR="$arbin" -DCMAKE_RANLIB="$ranlibbin" \
      -DCMAKE_C_FLAGS="-Os -fPIC" -DCMAKE_POSITION_INDEPENDENT_CODE=ON -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
      -DENABLE_PROGRAMS=OFF -DENABLE_TESTING=OFF -DUSE_SHARED_MBEDTLS_LIBRARY=OFF -DUSE_STATIC_MBEDTLS_LIBRARY=ON \
      -DMBEDTLS_FATAL_WARNINGS=OFF -DGEN_FILES=OFF >cmake.log 2>&1 || { tail -40 cmake.log; die "mbedtls cmake"; }
    ninja >ninja.log 2>&1 || { tail -40 ninja.log; die "mbedtls build"; }
    ninja install >install.log 2>&1 )
}

# ---- ffmpeg: $1 = prefix, $2 = android|host, $3 = build dir ----
build_ffmpeg() {
  local prefix="$1" mode="$2" bdir="$3"
  mkdir -p "$bdir"
  local args=()
  mapfile -t args < <(common_flags)
  if [ "$mode" = android ]; then
    args+=(--enable-cross-compile --target-os=android --arch="$FF_ARCH" --cpu="$FF_CPU"
      --cc="$CC" --cxx="${CC}++" --ar="$TC/llvm-ar" --ranlib="$TC/llvm-ranlib" --strip="$TC/llvm-strip" --nm="$TC/llvm-nm"
      --extra-ldflags="-L$prefix/lib -pie $ARCH_LD" "${ARCH_FF_FLAGS[@]}")
  else
    args+=(--cc=gcc --disable-x86asm --extra-ldflags="-L$prefix/lib")
  fi
  args+=(--extra-cflags="-Os -I$prefix/include" --pkg-config=pkg-config --pkg-config-flags=--static)
  # The licence guard: this build is LGPL v3 or later, nothing else.
  case " ${args[*]} " in
    *" --enable-gpl "*|*" --enable-nonfree "*|*"--enable-libx264"*|*"--enable-libx265"*)
      die "GPL/nonfree in the configure line" ;;
  esac
  printf '%s\n' "${args[*]}" > "$bdir/configure-line.txt"
  ( cd "$bdir"
    PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig" PKG_CONFIG_PATH="" "$FFSRC/configure" --prefix="$bdir/install" "${args[@]}" >configure.log 2>&1 \
      || { tail -60 configure.log; die "ffmpeg configure ($mode)"; }
    make -j"$JOBS" >make.log 2>&1 || { tail -40 make.log; die "ffmpeg make ($mode)"; } )
}

# ---- 1. host twin: same feature flags, runs here, proves every listed name is really built ----
log "host twin (self-check)"
HOSTP="$WORK/prefix-host"
build_libs "$HOSTP" host
build_ffmpeg "$HOSTP" host "$WORK/ff-host"
HF="$WORK/ff-host/ffmpeg"
"$HF" -hide_banner -version | head -3

python3 - "$FEATURES" "$HF" "$WORK/ff-host/config_components.h" <<'PY'
import json, subprocess, sys
f = json.load(open(sys.argv[1])); exe = sys.argv[2]; comps = open(sys.argv[3]).read()
def names(flag):
    out = subprocess.run([exe, "-hide_banner", flag], capture_output=True, text=True, check=True).stdout
    seen = set()
    for line in out.splitlines():
        for tok in line.split():
            for part in tok.split(","):
                seen.add(part)
    return seen
checks = [("protocols", "-protocols"), ("demuxers", "-demuxers"), ("muxers", "-muxers"), ("encoders", "-encoders"),
          ("decoders", "-decoders"), ("bsfs", "-bsfs"), ("filters", "-filters")]
bad = []
for key, flag in checks:
    have = names(flag)
    miss = [n for n in f[key] if n not in have]
    print(f"{flag}: {'OK' if not miss else 'MISSING ' + ','.join(miss)}")
    bad += miss
# the ffmpeg CLI has no parser list; the generated config says which parsers were compiled in
for n in f["parsers"]:
    ok = f"#define CONFIG_{n.upper()}_PARSER 1" in comps
    print(f"parser {n}: {'OK' if ok else 'MISSING'}")
    if not ok: bad.append(n)
lic = subprocess.run([exe, "-hide_banner", "-L"], capture_output=True, text=True).stdout
print(lic.strip().splitlines()[0] if lic.strip() else "no licence text")
if "Lesser" not in lic or "version 3" not in lic or "GNU General Public" in lic.replace("Lesser General", "L"):
    bad.append("licence text is not LGPL v3")
if bad:
    sys.exit("GAGAL: self-check " + str(bad))
PY

# ---- 2. the Android binary ----
log "android $ABI"
AP="$WORK/prefix-android"
build_libs "$AP" android
build_ffmpeg "$AP" android "$WORK/ff-android"
BIN="$WORK/ff-android/ffmpeg"
"$TC/llvm-strip" --strip-unneeded -o "$OUT/jniLibs/$ABI/libffmpeg.so" "$BIN"
OUTBIN="$OUT/jniLibs/$ABI/libffmpeg.so"

NEEDED="$("$TC/llvm-readelf" -d "$OUTBIN" | sed -n 's/.*Shared library: \[\(.*\)\]/\1/p' | sort -u | tr '\n' ' ')"
for lib in $NEEDED; do
  case "$lib" in libc.so|libm.so|libdl.so) ;; *) die "binary needs a non-bionic library: $lib" ;; esac
done
grep -aq "LGPL version 3 or later" "$OUTBIN" || die "licence string in the binary is not LGPL version 3 or later"
if grep -aq "GPL version 2 or later\|nonfree" "$OUTBIN"; then die "binary carries a GPL or nonfree licence string"; fi

# ---- 3. build info ----
{
  echo "MAXCOM slim ffmpeg for Android"
  echo "abi: $ABI  api: $API_LEVEL  ndk: $(basename "$NDK_ROOT")"
  echo "ffmpeg ${FFMPEG_VERSION:-?} sha256 $FFMPEG_SHA256"
  echo "libopus ${OPUS_VERSION:-?} sha256 $OPUS_SHA256"
  echo "mbedtls ${MBEDTLS_VERSION:-?} sha256 $MBEDTLS_SHA256"
  echo "licence: $(grep -aoh 'LGPL version 3 or later' "$OUTBIN" | head -1)"
  echo "needed: $NEEDED"
  echo "libffmpeg.so sha256 $(sha256sum "$OUTBIN" | cut -d' ' -f1)  size $(stat -c %s "$OUTBIN")"
  echo "configure line:"
  cat "$WORK/ff-android/configure-line.txt"
} > "$OUT/ffmpeg-build-info.txt"
cat "$OUT/ffmpeg-build-info.txt" | head -12
log "klaar: $OUTBIN"
