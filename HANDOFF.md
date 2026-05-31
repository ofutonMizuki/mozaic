# HANDOFF — Mac 実機へ引き継ぎ(GPU/Metal バックエンド)

最終更新: 2026-05-31。この開発機は **WSL Linux で Metal が無い**ため、ここから **Apple Silicon Mac** へ移行する。
次の主目的は mozaic の**目玉である GPU/Metal バックエンド** ── UMA ゼロコピー + 「借用=同期」の実装。

## 0. まず読む
- [VISION.md](VISION.md) — 思想とキーストーン(借用=デバイス同期、Apple Silicon UMA)
- [SPEC.md](SPEC.md) — 言語仕様。特に **§6 デバイスとカーネル**、§5 並行性
- [README.md](README.md) — 現状の機能と使い方
- メモリ: `~/.claude/projects/-home-mozuku-mozaic/memory/mozaic-language-design.md`(設計判断の全履歴)

## 1. 現状(M0:Linux で完成・検証済み、ゴールデン 9/9)
TS→C++ コンパイラが動作。機能は README 参照(厳密型・関数・struct・enum+網羅match・整数オーバーフロー・**CPU パスのカーネル**)。
- コンパイラ: [src/](src/) = `lexer.ts → parser.ts →(ast.ts)→ check.ts → emit.ts → main.ts`(Node が `.ts` を直接実行、ビルド不要)
- ランタイム: [runtime/mozaic_rt.h](runtime/mozaic_rt.h)
- **カーネルの現状**: `kernel` → C++ 関数 `void k(uint32_t grid_x, mz::Buffer<T>& …)`、`launch(k, grid, …)` → `mz::launch(grid, lambda)` が **CPU で逐次ループ**実行。`mz::Buffer<T>` は `std::vector` backed。Device/Job/await/借用同期は**未実装**(GPU と一緒に入れる想定)。

## 2. Mac セットアップ確認
```sh
node --version          # 23.6+(できれば 24)。TypeScript を直接実行できること
clang++ --version       # Xcode Command Line Tools: `xcode-select --install`
node tests/run.ts       # 既存コンパイラが Mac でも 9/9 になるか先に確認
```
- **Apple Silicon**(M1/M2/M3…)であること(UMA の意味が出る)。
- **metal-cpp** を入手(developer.apple.com/metal/cpp/)。`Metal/Metal.hpp` / `Foundation/Foundation.hpp` / `QuartzCore/QuartzCore.hpp`。1 つの .cpp で `*_PRIVATE_IMPLEMENTATION` を定義して実装を生成する流儀。

## 3. 最初の地雷:コンパイラ呼び出しが `g++` 固定
[src/main.ts](src/main.ts) のドライバは `execFileSync("g++", …)` 決め打ち。Mac では `clang++` を使い、Metal ではフレームワークリンクが要る。
→ **C++ コンパイラと追加フラグを環境変数化**する(例 `MZ_CXX`, `MZ_CXXFLAGS`)。Metal パスでは概ね:
```
clang++ -std=c++20 -O2 -framework Metal -framework Foundation -framework QuartzCore -I<metal-cpp> …
```

## 4. タスク:GPU/Metal バックエンド(段階計画)
核となる設計:**同じ `kernel` コードを CPU でも GPU でも動かす**。GPU では kernel を **MSL(Metal Shading Language)** へ降ろし、ホストは metal-cpp で dispatch。バッファは **`MTLStorageModeShared`** にして Apple Silicon で **ゼロコピー**。

- **G0 手書きで疎通(最重要)**:mozaic を介さず、`addk` 相当の MSL + metal-cpp ホストを手書きし、GPU で `10 11 12 13` を出す。Metal の API・ビルド・リンクの不確実性をここで全部潰す。
- **G1 Buffer を MTLBuffer 化**:Metal ビルド時、`mz::Buffer<T>` を `MTLBuffer`(shared storage)backed に。`buffer->contents()` の CPU ポインタ = GPU と同一メモリ(UMA)。CPU パスと `#ifdef MZ_METAL` で両立。
- **G2 kernel→MSL エミッタ**:[src/emit.ts](src/emit.ts) に **カーネル用の第2バックエンド**(MSL 生成)を追加。`emitKernel`(今は C++ を吐く)の隣に MSL 版。例:
  ```metal
  #include <metal_stdlib>
  using namespace metal;
  kernel void addk(device const uint* input  [[buffer(0)]],
                   device uint*       output [[buffer(1)]],
                   constant uint&     k      [[buffer(2)]],
                   constant uint&     out_len[[buffer(3)]],
                   uint gid [[thread_position_in_grid]]) {
    if (gid < out_len) output[gid] = input[gid] + k;
  }
  ```
  注意:**MSL の `device` バッファは長さを持たない** → `buf.len` を uniform(`out_len`)で別途渡す。今の `.len` の扱いを Metal 用に見直すこと。
- **G3 ホスト launch を GPU に**:Metal 版 `mz::launch` ── MSL を `newLibrary(source)` → `newFunction` → `newComputePipelineState`、`MTLBuffer` を set、`dispatchThreads(grid, threadgroup)`、`commit` → `waitUntilCompleted`。**まず同期**で正しさを取り、`addk.mzc` を GPU で実行して CPU と一致(`10 11 12 13`)を確認。
- **G4 設計どおりに整える**:`Device.cpu` / `Device.gpu`、`dev.launch(...) -> Job`、`job.await()`、そして **借用=同期**(SPEC のキーストーン:`await` 前に `&mut` 借用中のバッファへ CPU が触るとコンパイルエラー)。UMA では `await` はフェンスのみ(コピー無し)、ディスクリート GPU では同地点でコピーバックを挿入。

## 5. 触るファイル
- [src/emit.ts](src/emit.ts) — `emitKernel` の隣に MSL 生成、`launch` の Metal 版生成。
- [src/main.ts](src/main.ts) — `clang++`/フレームワーク対応、`--gpu`(or `--metal`)フラグ追加、`MZ_CXX`/`MZ_CXXFLAGS`。
- [runtime/mozaic_rt.h](runtime/mozaic_rt.h) — `mz::Buffer<T>` を MTLBuffer backed に(Metal 時)、`mz::launch` の Metal 版。
- [src/check.ts](src/check.ts) — 当面そのままで可(`grid.x`/`Buffer<T>`/`launch` は型付け済み)。

## 6. 検証の落としどころ
- `examples/addk.mzc` を **CPU と GPU の両方**でビルド・実行し、出力一致(`10 11 12 13`)。
- shared buffer 経路に **明示コピーが無い**ことをコードで確認(UMA ゼロコピーの実証 = 目玉)。
- 既存ゴールデン 9/9 を維持(CPU パスを壊さない)。`node tests/run.ts`。

## 7. 既知の注意
- ホスト C++ は **`-std=c++20`**(enum 構築で designated initializer を使用)。
- 整数演算は `__builtin_*_overflow`(clang も対応)。debug=trap / `--release`=wrap。
- 文字列は内部 UTF-32 / stdio で UTF-8 変換。
- 既存履歴は `git log`(M0 の各機能が機能別コミット)。**新規作業はブランチを切る**こと。
- 言語内 `T?`/`Result`・明示キャスト `as`/`as?`・総称型・完全な借用チェッカは未実装(SPEC §8 TBD / VISION 未決事項)。GPU が一段落したら着手候補。
