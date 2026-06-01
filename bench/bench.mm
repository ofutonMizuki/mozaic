// mozaic GPU/CPU benchmark — what does Apple Silicon UMA actually buy?
//
// Compares three execution paths on identical work, for two kernel shapes:
//   CPU         : single-thread serial loop (matches mozaic's CPU backend, mz::launch)
//   GPU shared  : MTLStorageModeShared — host writes/reads buf.contents directly, the GPU
//                 uses the SAME memory. No host<->device copy. This is mozaic's --gpu path.
//   GPU private : MTLStorageModePrivate — emulates a discrete GPU: blit-copy inputs in,
//                 dispatch, blit-copy results out. The copies are exactly what UMA removes.
//
// Two kernels:
//   vadd  (memory-bound)  : out = a*k + b      — 3 mem ops, 2 flops/elem; bandwidth limited.
//   heavy (compute-bound) : ~ITERS fma/elem    — tiny memory, lots of math; throughput limited.
//
// Build/run:  bench/run.sh   (or see that script for the clang++ line)
// Tuning:     bench/bench [log2N_min] [log2N_max] [reps] [iters]
#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <vector>
#include <algorithm>
#include <cmath>

using Clock = std::chrono::steady_clock;
static double ms_since(Clock::time_point t0) {
  return std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
}

static const char* kSrc = R"MSL(
#include <metal_stdlib>
using namespace metal;

kernel void vadd(device const float* a [[buffer(0)]],
                 device const float* b [[buffer(1)]],
                 device float*       o [[buffer(2)]],
                 constant uint&      n [[buffer(3)]],
                 constant float&     k [[buffer(4)]],
                 uint gid [[thread_position_in_grid]]) {
  if (gid < n) o[gid] = a[gid] * k + b[gid];
}

kernel void heavy(device const float* in    [[buffer(0)]],
                  device float*       o     [[buffer(1)]],
                  constant uint&      n     [[buffer(2)]],
                  constant uint&      iters [[buffer(3)]],
                  uint gid [[thread_position_in_grid]]) {
  if (gid >= n) return;
  float x = in[gid], acc = 0.0f;
  for (uint i = 0; i < iters; i++) {       // dependent chain: not optimizable away
    acc = fma(acc, 1.0000001f, x);
    x   = fma(x, 0.9999999f, 1.0f);
  }
  o[gid] = acc;
}
)MSL";

static id<MTLComputePipelineState> makePSO(id<MTLDevice> dev, id<MTLLibrary> lib, const char* name) {
  NSError* err = nil;
  id<MTLFunction> fn = [lib newFunctionWithName:[NSString stringWithUTF8String:name]];
  id<MTLComputePipelineState> pso = [dev newComputePipelineStateWithFunction:fn error:&err];
  if (!pso) { fprintf(stderr, "pipeline %s: %s\n", name, err.localizedDescription.UTF8String); exit(1); }
  return pso;
}

static MTLSize tgFor(id<MTLComputePipelineState> pso, uint32_t n) {
  NSUInteger t = pso.maxTotalThreadsPerThreadgroup;
  if (t > n) t = n ? n : 1;
  return MTLSizeMake(t, 1, 1);
}

// median of timings (robust to a stray scheduler hiccup)
static double median(std::vector<double> v) {
  std::sort(v.begin(), v.end());
  return v.empty() ? 0.0 : v[v.size() / 2];
}

int main(int argc, char** argv) {
  @autoreleasepool {
    int    lo    = argc > 1 ? atoi(argv[1]) : 16;   // N = 1<<lo .. 1<<hi
    int    hi    = argc > 2 ? atoi(argv[2]) : 22;
    int    reps  = argc > 3 ? atoi(argv[3]) : 9;    // timed GPU reps (median)
    uint32_t ITERS = argc > 4 ? (uint32_t)atoi(argv[4]) : 256;  // heavy kernel inner loop
    int    cpuReps = reps < 3 ? reps : 3;            // CPU is deterministic + slow: fewer reps

    id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
    if (!dev) { fprintf(stderr, "no Metal device\n"); return 1; }
    printf("device: %s   (unified memory: %s)\n",
           dev.name.UTF8String, dev.hasUnifiedMemory ? "yes" : "no");

    // One-time GPU startup cost: MSL compile + pipeline build (explains small-N losses).
    auto tc = Clock::now();
    NSError* err = nil;
    id<MTLLibrary> lib = [dev newLibraryWithSource:[NSString stringWithUTF8String:kSrc] options:nil error:&err];
    if (!lib) { fprintf(stderr, "MSL: %s\n", err.localizedDescription.UTF8String); return 1; }
    double t_compile = ms_since(tc);
    id<MTLComputePipelineState> psoVadd  = makePSO(dev, lib, "vadd");
    id<MTLComputePipelineState> psoHeavy = makePSO(dev, lib, "heavy");
    id<MTLCommandQueue> q = [dev newCommandQueue];
    printf("one-time: MSL compile %.2f ms, pipelines built (vadd+heavy)\n", t_compile);
    printf("reps=%d (median)   heavy ITERS=%u   CPU=single-thread\n\n", reps, ITERS);

    const float K = 1.5f;

    // ----- memory-bound: out = a*k + b -----
    printf("== vadd (memory-bound: 3x f32 mem, 2 flops/elem) ==\n");
    printf("%10s | %10s | %12s | %12s | %9s | %9s\n",
           "N", "CPU ms", "GPU-UMA ms", "GPUpriv ms", "vs CPU", "UMA win");
    fflush(stdout);
    for (int e = lo; e <= hi; e++) {
      uint32_t N = 1u << e;
      size_t bytes = (size_t)N * sizeof(float);

      // host inputs
      std::vector<float> a(N), b(N), ref(N);
      for (uint32_t i = 0; i < N; i++) { a[i] = (float)(i & 1023); b[i] = (float)((i * 7) & 1023); }

      // CPU
      std::vector<double> cpu;
      for (int r = 0; r < cpuReps; r++) {
        auto t0 = Clock::now();
        for (uint32_t i = 0; i < N; i++) ref[i] = a[i] * K + b[i];
        cpu.push_back(ms_since(t0));
      }
      double cpu_ms = median(cpu);

      // GPU shared (UMA): fill via .contents (no copy), dispatch, read via .contents (no copy)
      id<MTLBuffer> sa = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      id<MTLBuffer> sb = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      id<MTLBuffer> so = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      memcpy(sa.contents, a.data(), bytes);   // filling host memory (would happen regardless)
      memcpy(sb.contents, b.data(), bytes);
      MTLSize tg = tgFor(psoVadd, N), grid = MTLSizeMake(N, 1, 1);
      std::vector<double> uma;
      for (int r = -2; r < reps; r++) {       // 2 warmups
        auto t0 = Clock::now();
        id<MTLCommandBuffer> cb = [q commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:psoVadd];
        [enc setBuffer:sa offset:0 atIndex:0]; [enc setBuffer:sb offset:0 atIndex:1];
        [enc setBuffer:so offset:0 atIndex:2];
        [enc setBytes:&N length:sizeof(N) atIndex:3]; [enc setBytes:&K length:sizeof(K) atIndex:4];
        [enc dispatchThreads:grid threadsPerThreadgroup:tg]; [enc endEncoding];
        [cb commit]; [cb waitUntilCompleted];
        if (r >= 0) uma.push_back(ms_since(t0));
      }
      double uma_ms = median(uma);
      // correctness
      float* og = (float*)so.contents; double maxerr = 0;
      for (uint32_t i = 0; i < N; i++) maxerr = fmax(maxerr, fabs(og[i] - ref[i]));

      // GPU private (discrete emulation): copy in, dispatch, copy out — the UMA tax
      id<MTLBuffer> pa = [dev newBufferWithLength:bytes options:MTLResourceStorageModePrivate];
      id<MTLBuffer> pb = [dev newBufferWithLength:bytes options:MTLResourceStorageModePrivate];
      id<MTLBuffer> po = [dev newBufferWithLength:bytes options:MTLResourceStorageModePrivate];
      id<MTLBuffer> stg = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      std::vector<double> prv;
      for (int r = -2; r < reps; r++) {
        auto t0 = Clock::now();
        id<MTLCommandBuffer> cb = [q commandBuffer];
        id<MTLBlitCommandEncoder> bl = [cb blitCommandEncoder];
        memcpy(stg.contents, a.data(), bytes); [bl copyFromBuffer:stg sourceOffset:0 toBuffer:pa destinationOffset:0 size:bytes];
        memcpy(stg.contents, b.data(), bytes); [bl copyFromBuffer:stg sourceOffset:0 toBuffer:pb destinationOffset:0 size:bytes];
        [bl endEncoding];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:psoVadd];
        [enc setBuffer:pa offset:0 atIndex:0]; [enc setBuffer:pb offset:0 atIndex:1];
        [enc setBuffer:po offset:0 atIndex:2];
        [enc setBytes:&N length:sizeof(N) atIndex:3]; [enc setBytes:&K length:sizeof(K) atIndex:4];
        [enc dispatchThreads:grid threadsPerThreadgroup:tg]; [enc endEncoding];
        id<MTLBlitCommandEncoder> bl2 = [cb blitCommandEncoder];
        [bl2 copyFromBuffer:po sourceOffset:0 toBuffer:stg destinationOffset:0 size:bytes]; [bl2 endEncoding];
        [cb commit]; [cb waitUntilCompleted];
        if (r >= 0) prv.push_back(ms_since(t0));
      }
      double prv_ms = median(prv);

      printf("%10u | %10.3f | %12.3f | %12.3f | %8.1fx | %8.2fx   (maxerr %.1e)\n",
             N, cpu_ms, uma_ms, prv_ms, cpu_ms / uma_ms, prv_ms / uma_ms, maxerr);
      fflush(stdout);
    }

    // ----- compute-bound: heavy inner loop -----
    printf("\n== heavy (compute-bound: %u fma/elem, ~no memory) ==\n", ITERS);
    printf("%10s | %10s | %12s | %12s | %9s | %9s\n",
           "N", "CPU ms", "GPU-UMA ms", "GPUpriv ms", "vs CPU", "UMA win");
    fflush(stdout);
    for (int e = lo; e <= hi; e++) {
      uint32_t N = 1u << e;
      size_t bytes = (size_t)N * sizeof(float);
      std::vector<float> in(N), ref(N);
      for (uint32_t i = 0; i < N; i++) in[i] = (float)(i & 255) * 0.01f;

      auto cpuHeavy = [&](float xx) {
        float x = xx, acc = 0.0f;
        for (uint32_t i = 0; i < ITERS; i++) { acc = fmaf(acc, 1.0000001f, x); x = fmaf(x, 0.9999999f, 1.0f); }
        return acc;
      };
      std::vector<double> cpu;
      for (int r = 0; r < cpuReps; r++) {
        auto t0 = Clock::now();
        for (uint32_t i = 0; i < N; i++) ref[i] = cpuHeavy(in[i]);
        cpu.push_back(ms_since(t0));
      }
      double cpu_ms = median(cpu);

      id<MTLBuffer> si = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      id<MTLBuffer> so = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      memcpy(si.contents, in.data(), bytes);
      MTLSize tg = tgFor(psoHeavy, N), grid = MTLSizeMake(N, 1, 1);
      std::vector<double> uma;
      for (int r = -2; r < reps; r++) {
        auto t0 = Clock::now();
        id<MTLCommandBuffer> cb = [q commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:psoHeavy];
        [enc setBuffer:si offset:0 atIndex:0]; [enc setBuffer:so offset:0 atIndex:1];
        [enc setBytes:&N length:sizeof(N) atIndex:2]; [enc setBytes:&ITERS length:sizeof(ITERS) atIndex:3];
        [enc dispatchThreads:grid threadsPerThreadgroup:tg]; [enc endEncoding];
        [cb commit]; [cb waitUntilCompleted];
        if (r >= 0) uma.push_back(ms_since(t0));
      }
      double uma_ms = median(uma);
      float* og = (float*)so.contents; double maxerr = 0;
      for (uint32_t i = 0; i < N; i += (N > 4096 ? N / 4096 : 1)) maxerr = fmax(maxerr, fabs(og[i] - ref[i]));

      id<MTLBuffer> pi = [dev newBufferWithLength:bytes options:MTLResourceStorageModePrivate];
      id<MTLBuffer> po = [dev newBufferWithLength:bytes options:MTLResourceStorageModePrivate];
      id<MTLBuffer> stg = [dev newBufferWithLength:bytes options:MTLResourceStorageModeShared];
      std::vector<double> prv;
      for (int r = -2; r < reps; r++) {
        auto t0 = Clock::now();
        id<MTLCommandBuffer> cb = [q commandBuffer];
        id<MTLBlitCommandEncoder> bl = [cb blitCommandEncoder];
        memcpy(stg.contents, in.data(), bytes); [bl copyFromBuffer:stg sourceOffset:0 toBuffer:pi destinationOffset:0 size:bytes];
        [bl endEncoding];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:psoHeavy];
        [enc setBuffer:pi offset:0 atIndex:0]; [enc setBuffer:po offset:0 atIndex:1];
        [enc setBytes:&N length:sizeof(N) atIndex:2]; [enc setBytes:&ITERS length:sizeof(ITERS) atIndex:3];
        [enc dispatchThreads:grid threadsPerThreadgroup:tg]; [enc endEncoding];
        id<MTLBlitCommandEncoder> bl2 = [cb blitCommandEncoder];
        [bl2 copyFromBuffer:po sourceOffset:0 toBuffer:stg destinationOffset:0 size:bytes]; [bl2 endEncoding];
        [cb commit]; [cb waitUntilCompleted];
        if (r >= 0) prv.push_back(ms_since(t0));
      }
      double prv_ms = median(prv);

      printf("%10u | %10.3f | %12.3f | %12.3f | %8.1fx | %8.2fx   (maxerr %.1e)\n",
             N, cpu_ms, uma_ms, prv_ms, cpu_ms / uma_ms, prv_ms / uma_ms, maxerr);
      fflush(stdout);
    }
    printf("\nvs CPU  = CPU/GPU-UMA  (>1 = GPU faster)\n");
    printf("UMA win = GPUpriv/GPU-UMA  (>1 = how much the discrete-style copy-in/out costs)\n");
  }
  return 0;
}
