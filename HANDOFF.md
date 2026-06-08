# HANDOFF

> **最新状況は [ROADMAP.md](ROADMAP.md) 「現在地」を参照**(本ファイル以下は M1/M2 当時の歴史メモ)。
> 2026-06-04 時点: **M3・M4 完了・M5 ほぼ完了・M6 完了・M7 bootstrap 実証**(branch `m3-abstraction`, ゴールデン **112/112**; GPU/非同期/オーバーフロー trap/**mozc≡参照の忠実性**は `tests/prove.sh`(5 フェーズ)で別途証明)。
> 2026-06-04: **ビット演算を完全実装**(`& | ^ ~ << >>`、参照/comptime/GPU/mozc 全対応、検査付きシフト)。詳細は ROADMAP「現在地」。
> 健全性ハードニング(2026-06-03): 差分テストで実装漏れ 2 件を修正 — 参照の **>2^64 リテラル**(`renderInt` 合成)と **mozc の検査付き算術**(`mz::chk_*`、debug trap/release wrap で参照に一致・符号付き UB 解消)。詳細は ROADMAP「現在地」。
> 追加実装: 総称型 / SIMD `f32x4` / `comptime`+`const` / `Task<R>` / `Arc`・`Mutex`・`Channel` / `SeqCst` /
> `Vec<T>` / `Map<K,V>` / 可変 `String` / `readFile`/`writeFile` / `stdin.readAll` / 論理 `&& || !` / `else if` /
> `import` / disjoint-field 借用 / **格納参照 + NLL** / `Send`/`Sync` 規則 / **`Box<T>` 再帰型** /
> **カーネル workgroup**(`shared`/`local`/`group`/`barrier`/`gridGroups`、実機 GPU 検証) / **実行時 Device 選択**。
> **M7 サブセット self-host(★自己ホスト不動点到達)**: [tests/cases/selfhost.mzc](tests/cases/selfhost.mzc) = **mozaic で書いた mozaic→C++ コンパイラ**が
> **自分自身をコンパイルして同一ソースを再生成**(gen2==gen3、`./selfhost-check.sh` で検証)。対応サブセット: 関数+再帰 / int・bool・str・char /
> struct+メソッド / enum+match / 固定配列 / `as` / 被コンパイル側 `Vec`・`Box`・`Map` / 参照 / テンプレート・`format` / コメント / `const` / `abort` / `stdin.readAll`。
> **残り(唯一)**: M7 全機能版(selfhost.mzc を generics/atomic/comptime/optional/SIMD/GPU 等へ拡張し、生成 C++ で 102 ゴールデン全件)。
> コンパイラ編集時の注意は memory `mozaic-compiler-conventions` 参照。

---

# HANDOFF — GPU/Metal + Atomic/並行 + **M2 言語コア実装中**

最終更新: 2026-06-01(Apple Silicon M4 実機)。**G0〜G4 + Atomic/並行 + M2 言語コアの大半**が実装・検証済み。
GPU/Metal バックエンド(UMA ゼロコピー + 借用=同期)が動作。以下は到達点と、次に着手する候補。

## M2 言語コア(branch `m2-language-core`、main 未マージ)
`char` + 文字リテラル(UTF-32)/ `true`/`false` / `as`・`as?` キャスト / `str` リテラルを所有 `String` 化(`U"…"_mz`) /
`abort`・`assert` / `defer`(LIFO RAII) / `T?` オプショナル(`some`/`none`/`??`/後置 `?`) /
`Result<T,E>`(`Ok`/`Err`/後置 `?`/`isOk`/`isErr`/`unwrap`/`unwrapErr`) / 固定長配列 `[T;N]`・スライス `[]T`(`slice(arr)`) /
文字列 `.len`(コードポイント数)/`+`/`[i]`→`char`・`format(x)`・テンプレート `` `…${e}…` ``。
ゴールデン **66/66**。2 回の敵対的レビュー(workflow)で健全性/コード生成バグ計 11 件を修正済み。
残: M3 以降(comptime/SIMD、並行性の完成、借用完全形、モジュール/stdlib、セルフホスト)。詳細は [ROADMAP.md](ROADMAP.md)。

## M3 抽象化(branch `m3-abstraction`、`m2-language-core` の上に積む、main 未マージ)
✅ **ユーザ総称型**: generic 関数 `function id<T>(x: T): T`(呼び出しで型推論)+ generic struct
`struct Pair<A, B> {…}`(構築時にフィールド値から型引数を推論)+ **総称 struct のメソッド**
(`&self`/`&mut self`、受け手のインスタンス引数で型引数を置換 → C++ テンプレートメンバ関数。コンテナ実装可能)。
✅ **スカラ型 `i128`/`u128`/`f16`**(`__int128`/`_Float16`、128bit は手書き to-string、f16 は float 経路)。ゴールデン **72/72**。
残: `comptime`(コンパイル時評価)、SIMD ベクタ `f32x4`。これらはセルフホストのクリティカルパス外。

## TL;DR(2026-06-01 時点で動くもの)
- `node src/main.ts run examples/addk_async.mzc --gpu` → Apple Silicon GPU(Metal)で `10 11 12 13`。CPU と完全一致。
- GPU/Metal + `Atomic<T>` + spawn/scope/join は **main にマージ済み**。**M2 言語コア**は branch `m2-language-core`(main 未マージ)。ゴールデン **66/66**(`node tests/run.ts`)。
- **採用した実装方針**:metal-cpp は使わず **Objective‑C++ + システム Metal.framework**(`clang++ -x objective-c++ -fobjc-arc -framework Metal -framework Foundation -DMZ_METAL`)。外部 DL 不要で Xcode のみで完結。MSL は `newLibraryWithSource` で実行時コンパイル。
- **借用=同期(キーストーン)達成**:`dev.launch(k, grid, &in, &mut out, …) -> Job` / `job.await()`。`await` 前に借用中バッファへ CPU が触ると **コンパイルエラー**([src/check.ts](src/check.ts) の `borrows` 追跡)。`&`=共有(CPU 並走読み可)/ `&mut`=排他。
- **UMA ゼロコピー実証**:生成 `.mm` に host↔device の `memcpy` ゼロ。`buf.contents` 直接読み書き = GPU と同一メモリ。
- **`Atomic<T>` + 最小 structured concurrency 達成**:`Atomic.new` / `load`/`store`/`fetchAdd`/`compareExchange`(`Ordering`=Relaxed/Acquire/Release/AcqRel、SeqCst なし、明示必須)。`std::atomic<T>` へ降ろし、`&Atomic<T>` は「`&` 共有でも書ける」唯一の例外(`Sync`)。`scope { spawn f(…); }`(終端で全 join)/ `let t: Task = spawn …; t.join()`(`std::thread`、join は void)。カーネル内 Atomic と `--gpu` の `Buffer<Atomic>` はコンパイルエラー。詳細は SPEC §5。

## 次フェーズ候補(未着手)
- **ランタイム Device 選択**:現状 `Device.gpu`/`Device.cpu` は値だが、実行バックエンドは `--gpu` フラグ(コンパイル時)が支配。SPEC §6 の `Device.gpu.first() ?? Device.cpu` 相当の実行時ディスパッチは未実装。
- **MSL 数値の精緻化**:飽和演算 `+|`/`-|`/`*|` は今ネイティブ(=ラップ)に潰している。`f64` は Metal 非対応で `float` にマップ。カーネル内 overflow セマンティクスの確定。
- **2D/3D グリッド**:**実装済み**(`grid2(w,h)`/`grid3(w,h,d)`、CPU=入れ子ループ / GPU=`dispatchThreads` を多次元化。例 [examples/matadd.mzc](examples/matadd.mzc))。残り:ワークグループ機能 `local.{x,y,z}`/`barrier()`/`shared [T;N]` は未実装。
- **タスク並列**(SPEC §5):**最小実装済み**(`scope`/`spawn`/`Task.join`、`std::thread`、借用追跡を流用)。残り:**結果返し `join`**(現状 void)、`Mutex<T>`/`Channel<T>`/`Arc<T>`、`Atomic` の `SeqCst`、ワークグループ機能 `local.{x,y,z}`/`barrier()`/`shared [T;N]`。
- **M2 は実装済み**(`T?`/`Result`/`as`/`as?`/配列/スライス/文字列/テンプレート/defer/char/abort/assert)。次は **M3**(`comptime`・ユーザ総称型・SIMD ベクタ)→ M4 並行完成 → M5 借用完全形 → M6 モジュール/stdlib → M7 セルフホスト。完全な借用チェッカ・モジュール・並行完成は SPEC §8 TBD のまま。

---
以下は **移行時(2026-05-31)の元メモ**。経緯の参考に残す。

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
