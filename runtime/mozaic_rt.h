// mozaic M0 runtime — tiny, stdio only.
// Internal text is UTF-32; stdin/stdout are transcoded to/from UTF-8.
#pragma once
#include <string>
#include <vector>
#include <iostream>
#include <cstdint>
#include <limits>
#include <cstdlib>
#include <chrono>
#include <optional>
#include <type_traits>
#include <array>

namespace mz {

using String = std::u32string;   // owned UTF-32 (M0: str/String share this)
using str    = std::u32string;

// ---- integer arithmetic (overflow-aware) ----
// Default add/sub/mul: trap on overflow in debug, wrap in release (-DMZ_RELEASE).
[[noreturn]] inline void panic(const char* msg) { std::cerr << "mozaic: " << msg << "\n"; std::abort(); }

// `defer body;` -> `auto _d = mz::defer([&]{ body });`. The guard's destructor runs the
// body at enclosing-scope exit; C++ destroys in reverse construction order, giving LIFO.
template <class F> struct DeferGuard {
  F f;
  DeferGuard(F fn) : f(fn) {}
  DeferGuard(const DeferGuard&) = delete;
  ~DeferGuard() { f(); }
};
template <class F> DeferGuard<F> defer(F f) { return DeferGuard<F>(f); }

// Monotonic wall-clock in nanoseconds (for `clock.now()` — benchmarking/timing).
inline uint64_t now_ns() {
  return (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
           std::chrono::steady_clock::now().time_since_epoch()).count();
}

template <class T> T add(T a, T b) { T r; bool o = __builtin_add_overflow(a, b, &r);
#ifndef MZ_RELEASE
  if (o) panic("integer overflow in '+'");
#else
  (void)o;
#endif
  return r; }
template <class T> T sub(T a, T b) { T r; bool o = __builtin_sub_overflow(a, b, &r);
#ifndef MZ_RELEASE
  if (o) panic("integer overflow in '-'");
#else
  (void)o;
#endif
  return r; }
template <class T> T mul(T a, T b) { T r; bool o = __builtin_mul_overflow(a, b, &r);
#ifndef MZ_RELEASE
  if (o) panic("integer overflow in '*'");
#else
  (void)o;
#endif
  return r; }
template <class T> T divi(T a, T b) {
  if (b == 0) panic("division by zero");
  if (std::numeric_limits<T>::is_signed && b == (T)(-1) && a == std::numeric_limits<T>::min()) panic("integer overflow in '/'");
  return a / b;
}
template <class T> T modi(T a, T b) {
  if (b == 0) panic("remainder by zero");
  if (std::numeric_limits<T>::is_signed && b == (T)(-1) && a == std::numeric_limits<T>::min()) return 0;
  return a % b;
}
// wrapping (two's complement)
template <class T> T wadd(T a, T b) { T r; __builtin_add_overflow(a, b, &r); return r; }
template <class T> T wsub(T a, T b) { T r; __builtin_sub_overflow(a, b, &r); return r; }
template <class T> T wmul(T a, T b) { T r; __builtin_mul_overflow(a, b, &r); return r; }
// saturating (clamp to type min/max)
template <class T> T sadd(T a, T b) { T r; if (__builtin_add_overflow(a, b, &r)) return b >= 0 ? std::numeric_limits<T>::max() : std::numeric_limits<T>::min(); return r; }
template <class T> T ssub(T a, T b) { T r; if (__builtin_sub_overflow(a, b, &r)) return b <= 0 ? std::numeric_limits<T>::max() : std::numeric_limits<T>::min(); return r; }
template <class T> T smul(T a, T b) { T r; if (__builtin_mul_overflow(a, b, &r)) return ((a < 0) != (b < 0)) ? std::numeric_limits<T>::min() : std::numeric_limits<T>::max(); return r; }

// `[]T` slice: a {ptr, len} view (no ownership). Built from a fixed array via slice(arr).
// Lifetimes are not yet checked (M5), so a slice must not outlive its backing storage.
template <class T> struct Slice {
  T* ptr;
  uint32_t len;
  T& operator[](uint32_t i) { return ptr[i]; }
  const T& operator[](uint32_t i) const { return ptr[i]; }
};

// `x as? To` — fallible numeric cast. Returns none unless the value round-trips exactly
// (so truncation, sign loss, or a non-integral float all yield none). To is always an integer.
template <class To, class From>
std::optional<To> checked_cast(From v) {
  if constexpr (std::is_floating_point_v<From>) {
    if (!(v == v)) return std::nullopt;                                   // NaN
    long double lv = (long double)v;
    if (lv < (long double)std::numeric_limits<To>::lowest() ||
        lv > (long double)std::numeric_limits<To>::max()) return std::nullopt;
    To r = (To)v;
    if ((From)r != v) return std::nullopt;                                // not an exact integer
    return r;
  } else {
    To r = (To)v;
    if ((From)r != v) return std::nullopt;                                // magnitude/sign didn't survive
    return r;
  }
}

// Result<T, E>: an aggregate {ok, val, err}. Ok(x) -> {true, x} (err value-inited);
// Err(e) -> {false, {}, e}. T and E must be default-constructible (M2 limitation).
template <class T, class E> struct Result {
  bool ok;
  T val{};
  E err{};
};
template <class T, class E> T result_unwrap(const Result<T, E>& r) {
  if (!r.ok) panic("unwrap() on an Err value");
  return r.val;
}
template <class T, class E> E result_unwrap_err(const Result<T, E>& r) {
  if (r.ok) panic("unwrapErr() on an Ok value");
  return r.err;
}

// ---- device buffers + data-parallel launch ----
// Two backends, selected at compile time:
//   default        : CPU path. Buffer is std::vector-backed; launch is a serial loop.
//   -DMZ_METAL     : Apple Silicon GPU. Buffer is MTLBuffer(shared)-backed — the CPU
//                    pointer (buf.contents) and the GPU address are the SAME memory (UMA,
//                    zero-copy). launch dispatches a precompiled MSL kernel and (for now)
//                    waits synchronously. Compile the generated unit as Objective-C++.

// A 1/2/3-D launch grid. grid.{x,y,z} in a kernel index into this (1 for unused dims).
struct Grid { uint32_t x, y, z; };

#ifdef MZ_METAL
} // namespace mz  (reopen after importing Metal)
#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include <cstring>
namespace mz {

inline id<MTLDevice> metal_device() {
  static id<MTLDevice> d = MTLCreateSystemDefaultDevice();
  if (!d) panic("no Metal device (Apple Silicon GPU required)");
  return d;
}
inline id<MTLCommandQueue> metal_queue() {
  static id<MTLCommandQueue> q = [metal_device() newCommandQueue];
  return q;
}

// MTLBuffer(shared)-backed: contents() is host-visible AND the GPU's memory (UMA).
template <class T> struct Buffer {
  id<MTLBuffer> buf;
  uint32_t len;
  Buffer(uint32_t n) : len(n) {
    buf = [metal_device() newBufferWithLength:(NSUInteger)n * sizeof(T)
                                      options:MTLResourceStorageModeShared];
    std::memset(buf.contents, 0, (size_t)n * sizeof(T));   // match CPU value-init
  }
  T& operator[](uint32_t i) { return ((T*)buf.contents)[i]; }
  const T& operator[](uint32_t i) const { return ((const T*)buf.contents)[i]; }
};

// Device value. The backend is fixed at compile time (--gpu), so this is currently a marker;
// runtime Device.gpu/cpu selection is a later milestone.
struct Device { };

// A launched-but-not-yet-joined kernel. Holds the in-flight command buffer; await() is the
// sync point (the borrow returns here). On UMA this is a fence only — no copy-back.
struct Job {
  id<MTLCommandBuffer> cb;
  void await() { if (cb) [cb waitUntilCompleted]; }
};

// One pipeline per kernel, compiled from MSL source on first use (cached at the call site).
struct MetalKernel {
  id<MTLComputePipelineState> pso;
  MetalKernel(const char* name, const char* src) {
    NSError* err = nil;
    id<MTLLibrary> lib = [metal_device() newLibraryWithSource:[NSString stringWithUTF8String:src]
                                                      options:nil error:&err];
    if (!lib) { std::cerr << "mozaic: MSL compile failed: " << err.localizedDescription.UTF8String << "\n"; std::abort(); }
    id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:name]];
    if (!fn) { std::cerr << "mozaic: kernel '" << name << "' not found in MSL\n"; std::abort(); }
    pso = [metal_device() newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) { std::cerr << "mozaic: pipeline failed: " << err.localizedDescription.UTF8String << "\n"; std::abort(); }
  }
};

// One dispatch: bind args (in MSL buffer-index order), then run() synchronously.
struct MetalDispatch {
  id<MTLCommandBuffer> cb;
  id<MTLComputeCommandEncoder> enc;
  id<MTLComputePipelineState> pso;
  Grid grid;
  MetalDispatch(MetalKernel& k, Grid g) : pso(k.pso), grid(g) {
    cb = [metal_queue() commandBuffer];
    enc = [cb computeCommandEncoder];
    [enc setComputePipelineState:pso];
  }
  template <class T> void buffer(int idx, Buffer<T>& b) { [enc setBuffer:b.buf offset:0 atIndex:idx]; }
  template <class T> void value(int idx, T v)           { [enc setBytes:&v length:sizeof(T) atIndex:idx]; }
  template <class T> void length(int idx, Buffer<T>& b) { uint32_t l = b.len; [enc setBytes:&l length:sizeof(l) atIndex:idx]; }
  void encode() {
    if (grid.x == 0 || grid.y == 0 || grid.z == 0) return;
    // Pick a threadgroup whose volume stays within the device limit (greedy x,y,z).
    NSUInteger maxT = pso.maxTotalThreadsPerThreadgroup;
    NSUInteger tx = grid.x < maxT ? grid.x : maxT;
    NSUInteger ty = grid.y < (maxT / tx) ? grid.y : (maxT / tx ? maxT / tx : 1);
    NSUInteger tz = grid.z < (maxT / (tx * ty)) ? grid.z : (maxT / (tx * ty) ? maxT / (tx * ty) : 1);
    [enc dispatchThreads:MTLSizeMake(grid.x, grid.y, grid.z)
       threadsPerThreadgroup:MTLSizeMake(tx, ty, tz)];
  }
  void run() {                 // synchronous: free launch(...) waits inline
    encode(); [enc endEncoding]; [cb commit]; [cb waitUntilCompleted];
  }
  Job commit() {               // async: dev.launch(...) returns the Job; caller awaits
    encode(); [enc endEncoding]; [cb commit];
    return Job{ cb };
  }
};

#else  // ---- CPU path ----

template <class T> struct Buffer {
  std::vector<T> data;
  uint32_t len;
  // value-init each element (C++20 zero-inits scalars AND std::atomic). NOT data(n, T()):
  // the copy-fill form requires T copyable, which std::atomic (Buffer<Atomic<...>>) is not.
  Buffer(uint32_t n) : data(n), len(n) {}
  T& operator[](uint32_t i) { return data[i]; }
  const T& operator[](uint32_t i) const { return data[i]; }
};
template <class F> void launch(Grid g, F fn) {
  for (uint32_t z = 0; z < g.z; z++)
    for (uint32_t y = 0; y < g.y; y++)
      for (uint32_t x = 0; x < g.x; x++) fn(x, y, z);
}

// CPU dev.launch runs the loop eagerly, so the Job is already complete; await() is a no-op.
struct Device { };
struct Job { void await() {} };

#endif

// UTF-8 bytes -> UTF-32
inline std::u32string decodeUtf8(const std::string& bytes) {
  std::u32string out;
  const size_t n = bytes.size();
  size_t i = 0;
  while (i < n) {
    const uint8_t c = (uint8_t)bytes[i];
    char32_t cp;
    int len;
    if (c < 0x80)            { cp = c;        len = 1; }
    else if ((c >> 5) == 0x6){ cp = c & 0x1F; len = 2; }
    else if ((c >> 4) == 0xE){ cp = c & 0x0F; len = 3; }
    else if ((c >> 3) == 0x1E){ cp = c & 0x07; len = 4; }
    else                     { cp = 0xFFFD;   len = 1; }  // invalid -> replacement
    for (int k = 1; k < len && i + (size_t)k < n; ++k) {
      cp = (cp << 6) | ((uint8_t)bytes[i + k] & 0x3F);
    }
    out.push_back(cp);
    i += (size_t)len;
  }
  return out;
}

// UTF-32 -> UTF-8 bytes
inline std::string encodeUtf8(const std::u32string& s) {
  std::string out;
  for (char32_t cp : s) {
    if (cp < 0x80) {
      out.push_back((char)cp);
    } else if (cp < 0x800) {
      out.push_back((char)(0xC0 | (cp >> 6)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
      out.push_back((char)(0xE0 | (cp >> 12)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    } else {
      out.push_back((char)(0xF0 | (cp >> 18)));
      out.push_back((char)(0x80 | ((cp >> 12) & 0x3F)));
      out.push_back((char)(0x80 | ((cp >> 6) & 0x3F)));
      out.push_back((char)(0x80 | (cp & 0x3F)));
    }
  }
  return out;
}

inline std::vector<String> stdin_lines() {
  std::vector<String> lines;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();  // CRLF
    lines.push_back(decodeUtf8(line));
  }
  return lines;
}

inline void println(const String& s)        { std::cout << encodeUtf8(s) << "\n"; }
inline void println(const char* s)           { std::cout << s << "\n"; }
inline void println(char32_t cp)             { std::cout << encodeUtf8(std::u32string(1, cp)) << "\n"; }
inline void println(long long v)             { std::cout << v << "\n"; }
inline void println(unsigned long long v)    { std::cout << v << "\n"; }
inline void println(double v)                { std::cout << v << "\n"; }
inline void println(bool v)                  { std::cout << (v ? "true" : "false") << "\n"; }

inline bool eq(const String& a, const char* b) { return a == decodeUtf8(std::string(b)); }
inline bool eq(const String& a, const String& b) { return a == b; }

// format(x) -> String, for template interpolation and explicit format(...).
inline String format(const String& s)       { return s; }
inline String format(char32_t c)            { return String(1, c); }
inline String format(bool b)                { return decodeUtf8(b ? "true" : "false"); }
inline String format(long long v)           { return decodeUtf8(std::to_string(v)); }
inline String format(unsigned long long v)  { return decodeUtf8(std::to_string(v)); }
inline String format(double v)              { return decodeUtf8(std::to_string(v)); }

// abort / assert. panic_msg takes an mz::String (needs encodeUtf8, defined above).
// assert_ is always checked (a correctness contract, unlike the debug-only overflow traps).
[[noreturn]] inline void panic_msg(const String& m) { std::cerr << "mozaic: " << encodeUtf8(m) << "\n"; std::abort(); }
inline void assert_(bool c)                  { if (!c) panic("assertion failed"); }
inline void assert_(bool c, const String& m) { if (!c) panic_msg(m); }

} // namespace mz

// String literals lower to `U"..."_mz`, yielding an owned mz::String prvalue. (A bare U"..."
// is a const char32_t*, which would prefer the println(bool)/pointer conversions — this avoids that.)
inline mz::String operator""_mz(const char32_t* s, std::size_t n) { return mz::String(s, n); }
