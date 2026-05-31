// G0 spike: prove the whole Metal compute pipeline by hand (no mozaic involved).
// addk: output[i] = input[i] + k, on the GPU. Expected output: 10 11 12 13.
// Build: clang++ -x objective-c++ -std=c++20 -fobjc-arc \
//          -framework Metal -framework Foundation spike/addk_metal.mm -o build/spike_addk
#import <Metal/Metal.h>
#import <Foundation/Foundation.h>
#include <cstdint>
#include <cstdio>
#include <cstdlib>

static const char* kSrc = R"MSL(
#include <metal_stdlib>
using namespace metal;
kernel void addk(device const uint* input  [[buffer(0)]],
                 device uint*       output [[buffer(1)]],
                 constant uint&     k       [[buffer(2)]],
                 constant uint&     out_len [[buffer(3)]],
                 uint gid [[thread_position_in_grid]]) {
  if (gid < out_len) output[gid] = input[gid] + k;
}
)MSL";

int main() {
  @autoreleasepool {
    id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
    if (!dev) { fprintf(stderr, "no Metal device\n"); return 1; }

    NSError* err = nil;
    id<MTLLibrary> lib =
        [dev newLibraryWithSource:[NSString stringWithUTF8String:kSrc]
                          options:nil
                            error:&err];
    if (!lib) { fprintf(stderr, "compile MSL: %s\n", err.localizedDescription.UTF8String); return 1; }

    id<MTLFunction> fn = [lib newFunctionWithName:@"addk"];
    id<MTLComputePipelineState> pso =
        [dev newComputePipelineStateWithFunction:fn error:&err];
    if (!pso) { fprintf(stderr, "pipeline: %s\n", err.localizedDescription.UTF8String); return 1; }

    const uint32_t n = 4;
    id<MTLBuffer> input  = [dev newBufferWithLength:n * sizeof(uint32_t)
                                            options:MTLResourceStorageModeShared];
    id<MTLBuffer> output = [dev newBufferWithLength:n * sizeof(uint32_t)
                                            options:MTLResourceStorageModeShared];
    // Fill input on the CPU through the SAME memory the GPU will read (UMA, zero-copy).
    uint32_t* in = (uint32_t*)input.contents;
    for (uint32_t i = 0; i < n; i++) in[i] = i;        // 0 1 2 3

    uint32_t k = 10, out_len = n;

    id<MTLCommandQueue> q = [dev newCommandQueue];
    id<MTLCommandBuffer> cb = [q commandBuffer];
    id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
    [enc setComputePipelineState:pso];
    [enc setBuffer:input  offset:0 atIndex:0];
    [enc setBuffer:output offset:0 atIndex:1];
    [enc setBytes:&k       length:sizeof(k)       atIndex:2];
    [enc setBytes:&out_len length:sizeof(out_len) atIndex:3];

    NSUInteger tg = pso.maxTotalThreadsPerThreadgroup;
    if (tg > n) tg = n;
    [enc dispatchThreads:MTLSizeMake(n, 1, 1)
       threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
    [enc endEncoding];
    [cb commit];
    [cb waitUntilCompleted];

    // Read back through the same UMA memory — no explicit copy.
    uint32_t* out = (uint32_t*)output.contents;
    for (uint32_t i = 0; i < n; i++) printf("%u\n", out[i]);   // 10 11 12 13
  }
  return 0;
}
