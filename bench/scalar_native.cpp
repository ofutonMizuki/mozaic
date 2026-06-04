// Hand-written native C++ twin of bench/scalar.mzc (same LCG, same n/reps). clang -O3.
#include <cstdio>
#include <cstdint>
#include <chrono>
static uint64_t now_ns(){ return std::chrono::duration_cast<std::chrono::nanoseconds>(
  std::chrono::steady_clock::now().time_since_epoch()).count(); }
int main(){
  const uint64_t reps=40, n=20000000; uint64_t sink=0, t0=now_ns();
  for(uint64_t r=0;r<reps;r++){ uint64_t h=1234567+r;
    for(uint64_t i=0;i<n;i++){ h = h*6364136223846793005ULL + 1442695040888963407ULL; }
    sink += h; }
  uint64_t t1=now_ns();
  printf("%llu\n%llu\n",(unsigned long long)((t1-t0)/reps),(unsigned long long)sink);
  return 0;
}
