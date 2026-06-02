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
#include <sstream>
#include <memory>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <unordered_map>
#include <fstream>
#include <barrier>
#include <thread>
#include <future>

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
// MZ_DEFER(stmts...): a uniquely-named defer guard (used by the self-hosted compiler, which has
// no counter state). __COUNTER__ gives each guard a distinct name; LIFO at enclosing-scope exit.
#define MZ_DEFER_CAT2(a, b) a##b
#define MZ_DEFER_CAT(a, b) MZ_DEFER_CAT2(a, b)
#define MZ_DEFER(...) auto MZ_DEFER_CAT(_mzdef_, __COUNTER__) = mz::defer([&]{ __VA_ARGS__ })

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
// Left-operand-typed wrap/saturate ops for the self-hosted compiler: it has no type info, so it emits
// `mz::wrap_add(a, b)` and T is deduced from the left operand (b is cast into T). a +% b / a +| b etc.
template <class T, class U> T wrap_add(T a, U b) { T r; __builtin_add_overflow(a, (T)b, &r); return r; }
template <class T, class U> T wrap_sub(T a, U b) { T r; __builtin_sub_overflow(a, (T)b, &r); return r; }
template <class T, class U> T wrap_mul(T a, U b) { T r; __builtin_mul_overflow(a, (T)b, &r); return r; }
template <class T, class U> T sat_add(T a, U b) { return sadd<T>(a, (T)b); }
template <class T, class U> T sat_sub(T a, U b) { return ssub<T>(a, (T)b); }
template <class T, class U> T sat_mul(T a, U b) { return smul<T>(a, (T)b); }

// `[]T` slice: a {ptr, len} view (no ownership). Built from a fixed array via slice(arr).
// Lifetimes are not yet checked (M5), so a slice must not outlive its backing storage.
template <class T> struct Slice {
  T* ptr;
  uint32_t len;
  T& operator[](uint32_t i) { return ptr[i]; }
  const T& operator[](uint32_t i) const { return ptr[i]; }
  uint32_t size() const { return len; }
};
// make_slice(arr): build a Slice over a fixed array, deducing the element type (used by the
// self-hosted compiler's emit, which has no type info; in-language slice() lowers type-aware in emit.ts).
template <class T, std::size_t N> Slice<T> make_slice(std::array<T, N>& a) { return Slice<T>{ a.data(), (uint32_t)N }; }

// SIMD vector `<scalar>xN` (e.g. f32x4). A flat, Copy value of N lanes. Lane-wise arithmetic;
// build via the lane-constructor f32x4(a,b,c,d) or f32x4.splat(s). Indexed by lane: v[i].
// (-O2 auto-vectorizes the lane loops; the semantics are what the language guarantees.)
template <class T, int N> struct Simd {
  T lane[N];
  T& operator[](uint32_t i) { return lane[i]; }
  const T& operator[](uint32_t i) const { return lane[i]; }
  uint32_t size() const { return N; }
  static Simd splat(T s) { Simd v{}; for (int i = 0; i < N; i++) v.lane[i] = s; return v; }
};
template <class T, int N> Simd<T, N> operator+(const Simd<T, N>& a, const Simd<T, N>& b) { Simd<T, N> r{}; for (int i = 0; i < N; i++) r.lane[i] = a.lane[i] + b.lane[i]; return r; }
template <class T, int N> Simd<T, N> operator-(const Simd<T, N>& a, const Simd<T, N>& b) { Simd<T, N> r{}; for (int i = 0; i < N; i++) r.lane[i] = a.lane[i] - b.lane[i]; return r; }
template <class T, int N> Simd<T, N> operator*(const Simd<T, N>& a, const Simd<T, N>& b) { Simd<T, N> r{}; for (int i = 0; i < N; i++) r.lane[i] = a.lane[i] * b.lane[i]; return r; }
template <class T, int N> Simd<T, N> operator/(const Simd<T, N>& a, const Simd<T, N>& b) { Simd<T, N> r{}; for (int i = 0; i < N; i++) r.lane[i] = a.lane[i] / b.lane[i]; return r; }
template <class T, int N> Simd<T, N> operator%(const Simd<T, N>& a, const Simd<T, N>& b) { Simd<T, N> r{}; for (int i = 0; i < N; i++) r.lane[i] = a.lane[i] % b.lane[i]; return r; }

// ---- concurrency library types (M4) ----
// Box<T>: an owned heap box. Its whole purpose is to break the size cycle of recursive types
// (e.g. enum Expr { Add(Box<Expr>, Box<Expr>) }), so a node holds a pointer, not itself. Built
// with Box.new(v) (T inferred); read via b.get(). Heap-backed so copying a node is shallow.
template <class T> struct Box {
  std::shared_ptr<T> p;
  const T& get() const { return *p; }
};
// box_new(v): construct a Box with T deduced from v (used by the self-hosted compiler's emit,
// which has no type info; the in-language `Box.new(v)` lowers via the type-aware path in emit.ts).
template <class T> Box<T> box_new(T v) { return Box<T>{ std::make_shared<T>(std::move(v)) }; }
template <class T> struct Arc;
template <class T> Arc<T> arc_new(T v);   // defined after Arc (used by the self-hosted compiler's emit)

// Arc<T>: atomically reference-counted shared ownership. clone() hands out another owning handle
// (refcount++, thread-safe); get() reads the shared, immutable value. Lower than a borrow: an Arc
// handle outlives any lexical scope, so it crosses spawn boundaries by value (pass a.clone()).
template <class T> struct Arc {
  std::shared_ptr<T> p;
  Arc<T> clone() const { return Arc<T>{ p }; }
  const T& get() const { return *p; }
};
template <class T> Arc<T> arc_new(T v) { return Arc<T>{ std::make_shared<T>(std::move(v)) }; }

// JoinFuture<R>: a result-returning task. join() blocks and returns the value (the self-hosted
// compiler maps Task<R> here so t.join() is uniform with a void Task's std::thread::join()).
template <class R> struct JoinFuture {
  std::future<R> f;
  R join() { return f.get(); }
};

// Mutex<T>: a value guarded by a lock. lock() returns a MutexGuard whose `.val` is the guarded T
// (read & write under the held lock); the guard releases at scope exit (RAII). Shared by &Mutex<T>.
// std::mutex is non-movable, so a Mutex is constructed in place (like Atomic) and never copied/moved.
template <class T> struct MutexGuard {
  std::unique_lock<std::mutex> lk;
  T* p;
  T& val;   // alias of the guarded value (so the self-hosted compiler's `g.val` is a plain field, no type info needed)
};
template <class T> struct Mutex {
  std::mutex m;
  T val{};
  MutexGuard<T> lock() { return MutexGuard<T>{ std::unique_lock<std::mutex>(m), &val, val }; }
};

// Channel<T>: a blocking MPSC queue. send(v) enqueues; recv() blocks until an item is available.
// Shared by &Channel<T> (Sync) across threads.
template <class T> struct Channel {
  std::mutex m;
  std::condition_variable cv;
  std::queue<T> q;
  void send(const T& v) { { std::lock_guard<std::mutex> lk(m); q.push(v); } cv.notify_one(); }
  T recv() { std::unique_lock<std::mutex> lk(m); cv.wait(lk, [&]{ return !q.empty(); }); T v = std::move(q.front()); q.pop(); return v; }
};

// Vec<T>: a growable, owned array (std::vector). push/pop/len, O(1) indexing v[i]. Move-only
// at the language level (single owner); pass &mut Vec<T> to mutate it in a callee. The workhorse
// container for real programs (token lists, AST nodes, symbol tables, ...).
template <class T> struct Vec {
  std::vector<T> data;
  void push(const T& v) { data.push_back(v); }
  void push_back(const T& v) { data.push_back(v); }   // alias: the self-hosted compiler maps mozaic .push -> .push_back (shared with std::string)
  std::optional<T> pop() { if (data.empty()) return std::nullopt; T v = std::move(data.back()); data.pop_back(); return v; }
  uint32_t len() const { return (uint32_t)data.size(); }
  uint32_t size() const { return (uint32_t)data.size(); }
  T& operator[](uint32_t i) { return data[i]; }
  const T& operator[](uint32_t i) const { return data[i]; }
};

// Map<K, V>: a hash map (std::unordered_map). insert / get():V? / has / .len. Move-only at the
// language level; pass &mut Map<K,V> to mutate in a callee. K must be hashable (str, ints, char).
template <class K, class V> struct Map {
  std::unordered_map<K, V> m;
  void insert(const K& k, const V& v) { m[k] = v; }
  std::optional<V> get(const K& k) const { auto it = m.find(k); if (it == m.end()) return std::nullopt; return it->second; }
  bool has(const K& k) const { return m.find(k) != m.end(); }
  uint32_t len() const { return (uint32_t)m.size(); }
  uint32_t size() const { return (uint32_t)m.size(); }
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
// Postfix `?` propagation helpers — overloaded for optional AND Result so the self-hosted compiler
// needn't know which it is (C++ overload resolution picks by type; the `?` emit just returns the
// operand unchanged on the failing path, which is the enclosing fn's return type in both cases).
template <class T> bool is_ok(const std::optional<T>& o) { return o.has_value(); }
template <class T, class E> bool is_ok(const Result<T, E>& r) { return r.ok; }
template <class T> T get_val(const std::optional<T>& o) { return o.value(); }
template <class T, class E> T get_val(const Result<T, E>& r) { return r.val; }

// ---- device buffers + data-parallel launch ----
// Two backends, selected at compile time:
//   default        : CPU path. Buffer is std::vector-backed; launch is a serial loop.
//   -DMZ_METAL     : Apple Silicon GPU. Buffer is MTLBuffer(shared)-backed — the CPU
//                    pointer (buf.contents) and the GPU address are the SAME memory (UMA,
//                    zero-copy). launch dispatches a precompiled MSL kernel and (for now)
//                    waits synchronously. Compile the generated unit as Objective-C++.

// A 1/2/3-D launch grid. grid.{x,y,z} in a kernel index into this (1 for unused dims).
// tx/ty/tz = an explicit threadgroup (workgroup) size; 0 = let the backend pick. A workgroup
// kernel (local/group/barrier/shared) must be launched with an explicit threadgroup via gridGroups.
struct Grid { uint32_t x, y, z; uint32_t tx, ty, tz; };

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
  uint32_t size() const { return len; }
};

// Device value (kind: 0 = cpu, 1 = gpu). The compute backend is chosen at compile time (--gpu),
// but `Device.gpu.first()` reports whether a GPU is actually present, so the portable idiom
// `Device.gpu.first() ?? Device.cpu` resolves correctly per build (Metal build with a GPU -> gpu;
// CPU build -> none -> cpu). first() yields some(self) when this device kind is available, else none.
struct Device {
  uint32_t kind;
  std::optional<Device> first() const {
    if (kind == 1) { id<MTLDevice> d = MTLCreateSystemDefaultDevice(); return d ? std::optional<Device>{*this} : std::nullopt; }
    return std::optional<Device>{*this};
  }
};

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
    NSUInteger tx, ty, tz;
    if (grid.tx) {   // explicit threadgroup (workgroup kernels): use it as given
      tx = grid.tx; ty = grid.ty ? grid.ty : 1; tz = grid.tz ? grid.tz : 1;
    } else {         // pick a threadgroup whose volume stays within the device limit (greedy x,y,z)
      NSUInteger maxT = pso.maxTotalThreadsPerThreadgroup;
      tx = grid.x < maxT ? grid.x : maxT;
      ty = grid.y < (maxT / tx) ? grid.y : (maxT / tx ? maxT / tx : 1);
      tz = grid.z < (maxT / (tx * ty)) ? grid.z : (maxT / (tx * ty) ? maxT / (tx * ty) : 1);
    }
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
  uint32_t size() const { return len; }
};
template <class F> void launch(Grid g, F fn) {
  for (uint32_t z = 0; z < g.z; z++)
    for (uint32_t y = 0; y < g.y; y++)
      for (uint32_t x = 0; x < g.x; x++) fn(x, y, z);
}

// CPU dev.launch runs the loop eagerly, so the Job is already complete; await() is a no-op.
// In a CPU build there is no GPU, so Device.gpu.first() (kind==1) yields none.
struct Device {
  uint32_t kind;
  std::optional<Device> first() const { return kind == 1 ? std::nullopt : std::optional<Device>{*this}; }
};
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

// ---- file I/O (M6) ---- (defined after encode/decodeUtf8, which they use)
// readFile(path): the whole file as a String (none on error). writeFile(path, content): ok?
inline std::optional<String> read_file(const String& path) {
  std::ifstream f(encodeUtf8(path), std::ios::binary);
  if (!f) return std::nullopt;
  std::ostringstream ss; ss << f.rdbuf();
  return decodeUtf8(ss.str());
}
inline bool write_file(const String& path, const String& content) {
  std::ofstream f(encodeUtf8(path), std::ios::binary);
  if (!f) return false;
  f << encodeUtf8(content);
  return (bool)f;
}

// Read ALL of stdin as one owned String (UTF-8 -> UTF-32). For stdin-driven tools
// (e.g. `mozaic build < src.mzc`) and the self-host bootstrap, which scan whole sources.
inline String read_all_stdin() {
  std::ostringstream ss;
  ss << std::cin.rdbuf();
  return decodeUtf8(ss.str());
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
// std::string (byte) variant for the self-hosted compiler, whose str == std::string.
inline std::vector<std::string> stdin_lines_str() {
  std::vector<std::string> lines;
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();  // CRLF
    lines.push_back(line);
  }
  return lines;
}

// 128-bit integers have no std::to_string; format/print them by hand.
inline std::string u128_str(unsigned __int128 v) {
  if (v == 0) return "0";
  char buf[40]; int i = 40;
  while (v > 0) { buf[--i] = (char)('0' + (int)(v % 10)); v /= 10; }
  return std::string(buf + i, buf + 40);
}
inline std::string i128_str(__int128 v) { return v < 0 ? "-" + u128_str((unsigned __int128)(-v)) : u128_str((unsigned __int128)v); }

inline void println(const String& s)        { std::cout << encodeUtf8(s) << "\n"; }
inline void println(const char* s)           { std::cout << s << "\n"; }
inline void println(char32_t cp)             { std::cout << encodeUtf8(std::u32string(1, cp)) << "\n"; }
inline void println(__int128 v)              { std::cout << i128_str(v) << "\n"; }
inline void println(unsigned __int128 v)     { std::cout << u128_str(v) << "\n"; }
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
inline String format(__int128 v)            { return decodeUtf8(i128_str(v)); }
inline String format(unsigned __int128 v)   { return decodeUtf8(u128_str(v)); }
inline String format(double v)              { std::ostringstream os; os << v; return decodeUtf8(os.str()); }   // match println(double)

// abort / assert. panic_msg takes an mz::String (needs encodeUtf8, defined above).
// assert_ is always checked (a correctness contract, unlike the debug-only overflow traps).
[[noreturn]] inline void panic_msg(const String& m) { std::cerr << "mozaic: " << encodeUtf8(m) << "\n"; std::abort(); }
inline void assert_(bool c)                  { if (!c) panic("assertion failed"); }
inline void assert_(bool c, const String& m) { if (!c) panic_msg(m); }

// ---- helpers used by the SELF-HOSTED compiler (its `str` is std::string; no static type info) ----
// fmt(x): universal formatter — handles any scalar/string/char/bool via C++ template deduction, so
// the emitter needn't know x's type (this dissolves the format/template "type-info wall").
template <class T> std::string fmt(const T& x) {
  if constexpr (std::is_same_v<T, std::string>) return x;
  else if constexpr (std::is_same_v<T, std::u32string>) return encodeUtf8(x);                  // codepoint string -> UTF-8 (self-hosted compiler's str)
  else if constexpr (std::is_same_v<T, bool>) return x ? std::string("true") : std::string("false");
  else if constexpr (std::is_same_v<T, char>) return std::string(1, x);                      // a byte char -> that character
  else if constexpr (std::is_same_v<T, char32_t>) return encodeUtf8(std::u32string(1, x));    // codepoint -> UTF-8
  else if constexpr (std::is_floating_point_v<T>) { std::ostringstream o; o << x; return o.str(); }
  else if constexpr (std::is_same_v<T, __int128>) return i128_str(x);                          // 128-bit: no std::to_string
  else if constexpr (std::is_same_v<T, unsigned __int128>) return u128_str(x);
  else return std::to_string((long long)(x));
}
inline std::string fmt(const char* s) { return std::string(s); }   // non-template overload (avoid pointer->int)
// ufmt(x): like fmt but returns a u32string — the self-hosted compiler's str is std::u32string, so its
// string-building (format(x), template interpolation) must yield codepoint strings, not UTF-8 bytes.
template <class T> std::u32string ufmt(const T& x) {
  if constexpr (std::is_same_v<T, std::u32string>) return x;
  else if constexpr (std::is_same_v<T, std::string>) return decodeUtf8(x);
  else if constexpr (std::is_same_v<T, bool>) return x ? std::u32string(U"true") : std::u32string(U"false");
  else if constexpr (std::is_same_v<T, char32_t>) return std::u32string(1, x);
  else if constexpr (std::is_same_v<T, char>) return std::u32string(1, (char32_t)x);
  else return decodeUtf8(fmt(x));   // numbers / floats / 128-bit: format as ASCII, then widen
}
inline std::u32string ufmt(const char* s) { return decodeUtf8(std::string(s)); }
[[noreturn]] inline void panic_str(const std::string& m) { std::cerr << "mozaic: " << m << "\n"; std::abort(); }
inline std::string read_all_stdin_str() { std::ostringstream ss; ss << std::cin.rdbuf(); return ss.str(); }
inline std::optional<std::string> read_file_str(const std::string& path) {
  std::ifstream f(path, std::ios::binary); if (!f) return std::nullopt;
  std::ostringstream ss; ss << f.rdbuf(); return ss.str();
}
inline bool write_file_str(const std::string& path, const std::string& content) {
  std::ofstream f(path, std::ios::binary); if (!f) return false; f << content; return (bool)f;
}

} // namespace mz

// String literals lower to `U"..."_mz`, yielding an owned mz::String prvalue. (A bare U"..."
// is a const char32_t*, which would prefer the println(bool)/pointer conversions — this avoids that.)
inline mz::String operator""_mz(const char32_t* s, std::size_t n) { return mz::String(s, n); }
