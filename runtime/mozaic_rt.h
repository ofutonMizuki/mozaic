// mozaic M0 runtime — tiny, stdio only.
// Internal text is UTF-32; stdin/stdout are transcoded to/from UTF-8.
#pragma once
#include <string>
#include <vector>
#include <iostream>
#include <cstdint>

namespace mz {

using String = std::u32string;   // owned UTF-32 (M0: str/String share this)
using str    = std::u32string;

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

inline void println(const String& s)   { std::cout << encodeUtf8(s) << "\n"; }
inline void println(const char* s)      { std::cout << s << "\n"; }

inline bool eq(const String& a, const char* b) { return a == decodeUtf8(std::string(b)); }
inline bool eq(const String& a, const String& b) { return a == b; }

} // namespace mz
