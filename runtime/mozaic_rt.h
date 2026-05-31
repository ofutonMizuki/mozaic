// mozaic M0 runtime — tiny, stdio only.
// Internal text is UTF-32; stdin/stdout are transcoded to/from UTF-8.
#pragma once
#include <string>
#include <vector>
#include <iostream>
#include <cstdint>
#include <limits>
#include <cstdlib>

namespace mz {

using String = std::u32string;   // owned UTF-32 (M0: str/String share this)
using str    = std::u32string;

// ---- integer arithmetic (overflow-aware) ----
// Default add/sub/mul: trap on overflow in debug, wrap in release (-DMZ_RELEASE).
[[noreturn]] inline void panic(const char* msg) { std::cerr << "mozaic: " << msg << "\n"; std::abort(); }

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

// ---- device buffers + data-parallel launch (M0: CPU path; Metal/UMA backend later) ----
template <class T> struct Buffer {
  std::vector<T> data;
  uint32_t len;
  Buffer(uint32_t n) : data(n, T()), len(n) {}
  T& operator[](uint32_t i) { return data[i]; }
  const T& operator[](uint32_t i) const { return data[i]; }
};
template <class F> void launch(uint32_t grid, F fn) { for (uint32_t i = 0; i < grid; i++) fn(i); }

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
inline void println(long long v)             { std::cout << v << "\n"; }
inline void println(unsigned long long v)    { std::cout << v << "\n"; }
inline void println(double v)                { std::cout << v << "\n"; }
inline void println(bool v)                  { std::cout << (v ? "true" : "false") << "\n"; }

inline bool eq(const String& a, const char* b) { return a == decodeUtf8(std::string(b)); }
inline bool eq(const String& a, const String& b) { return a == b; }

} // namespace mz
