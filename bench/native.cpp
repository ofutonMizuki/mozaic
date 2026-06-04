// Hand-written native C++ baseline for the mozaic kernels (heavy, vadd), to compare against the
// mozaic-compiled CPU and GPU paths. Mirrors bench/heavy.mzc and bench/vadd.mzc exactly: same N,
// iters, reps, per-rep input perturbation, and result sink — and the SAME methodology (ns/launch).
// Two CPU variants per kernel: serial, and parallel (std::thread, spawned per launch — matching how
// mozaic's mz::launch partitions a 1-D index space across hardware_concurrency() threads).
//
// All float math is genuine f32 (this is the point of the comparison): the mozaic CPU path currently
// promotes `f32_var * float_literal` to double because literals lack an `f` suffix.
//   build: clang++ -std=c++20 -O3 native.cpp -o native
#include <cstdio>
#include <cstdint>
#include <vector>
#include <thread>
#include <chrono>

static unsigned NT() { unsigned n = std::thread::hardware_concurrency(); return n ? n : 1; }
static uint64_t now_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count();
}
// Run body(lo,hi) over [0,n) split across T threads, spawned fresh each call (as mz::launch does).
template <class F> static void par(uint32_t n, F body) {
  unsigned T = NT(); if ((uint64_t)T > n) T = n ? n : 1;
  std::vector<std::thread> ts; ts.reserve(T);
  for (unsigned t = 0; t < T; t++) {
    uint32_t lo = (uint32_t)((uint64_t)n * t / T), hi = (uint32_t)((uint64_t)n * (t + 1) / T);
    ts.emplace_back([=]{ body(lo, hi); });
  }
  for (auto& th : ts) th.join();
}

// ---- heavy: dependent f32 FMA chain, `iters` deep, per element (compute-bound) ----
static inline void heavy_elem(const float* in, float* out, uint32_t gid, uint32_t iters) {
  float x = in[gid], acc = 0.0f;
  for (uint32_t i = 0; i < iters; i++) { acc = acc * 1.0000001f + x; x = x * 0.9999999f + 1.0f; }
  out[gid] = acc;
}
// ---- vadd: out = a*k + b (memory-bound) ----
static inline void vadd_elem(const float* a, const float* b, float* out, uint32_t gid, float k) {
  out[gid] = a[gid] * k + b[gid];
}

static void bench_heavy(bool parallel) {
  const uint32_t n = 1048576, iters = 256; const uint64_t reps = 15;
  std::vector<float> in(n, 1.0f), out(n);
  auto run = [&]{ if (parallel) par(n, [&](uint32_t lo, uint32_t hi){ for (uint32_t g=lo; g<hi; g++) heavy_elem(in.data(), out.data(), g, iters); });
                  else for (uint32_t g=0; g<n; g++) heavy_elem(in.data(), out.data(), g, iters); };
  run();                                                   // warmup
  float sink = 0.0f; uint64_t t0 = now_ns();
  for (uint64_t r=0; r<reps; r++){ in[0] = in[0] + 1.0f; run(); sink = sink + out[0]; }
  uint64_t t1 = now_ns();
  printf("heavy  %-8s | %12.3f us/launch | sink=%g\n", parallel?"parallel":"serial", (t1-t0)/(double)reps/1000.0, sink);
}
static void bench_vadd(bool parallel) {
  const uint32_t n = 16777216; const uint64_t reps = 30; const float k = 1.5f;
  std::vector<float> a(n, 1.0f), b(n, 2.0f), out(n);
  auto run = [&]{ if (parallel) par(n, [&](uint32_t lo, uint32_t hi){ for (uint32_t g=lo; g<hi; g++) vadd_elem(a.data(), b.data(), out.data(), g, k); });
                  else for (uint32_t g=0; g<n; g++) vadd_elem(a.data(), b.data(), out.data(), g, k); };
  run();
  float sink = 0.0f; uint64_t t0 = now_ns();
  for (uint64_t r=0; r<reps; r++){ a[0] = a[0] + 1.0f; run(); sink = sink + out[0]; }
  uint64_t t1 = now_ns();
  printf("vadd   %-8s | %12.3f us/launch | sink=%g\n", parallel?"parallel":"serial", (t1-t0)/(double)reps/1000.0, sink);
}

int main() {
  printf("native C++ (clang -O3, true f32) — us per launch (lower = faster); %u hw threads\n", NT());
  bench_heavy(false); bench_heavy(true);
  bench_vadd(false);  bench_vadd(true);
  return 0;
}
