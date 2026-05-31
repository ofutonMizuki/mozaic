# mozaic

CPU と GPU を同格に扱う、速度優先のシステムプログラミング言語(設計・実装中)。

- 設計ドキュメント: [VISION.md](VISION.md) / [SPEC.md](SPEC.md)
- コンパイラ実装: TypeScript(Node がネイティブに実行、ビルド不要)
- 変換ターゲット: C++(最初) → 将来 WASM / JS

## できること(現状 / M0)

`mozaic → C++ → ネイティブ実行`。標準入出力のみの極小ランタイム。

- **型**(厳密・暗黙変換なし): `i8`..`u64` / `f32` `f64` / `bool` / `str` / `char`(UTF-32)
- **関数**: `function`(引数・戻り値・再帰)
- **変数・制御**: `let`/`const`、`if`/`else`、`while`、`for (const x of stdin.lines())`、代入
- **構造体**: `struct`、`Point { x: 1 }`、`p.x`
- **列挙型 + パターンマッチ**: ペイロード付き `enum`、網羅 `match`(網羅性をコンパイル時に検査)
- **整数オーバーフロー**: 既定 trap(debug)/ wrap(`--release`)、明示 `+%`(ラップ)/ `+|`(飽和)、`/`・`%` のゼロ除算 trap
- **カーネル(データ並列)**: `kernel`、`Buffer<T>`、`launch(k, grid, ...)`。**CPU と Apple Silicon GPU(Metal)の両対応**
- **GPU / Metal バックエンド**(`--gpu`): 同じ `kernel` を **MSL** へ降ろし、`Buffer<T>` は `MTLBuffer`(shared)backed = **UMA ゼロコピー**(host と GPU が同一メモリ)
- **借用 = デバイス同期**(キーストーン): `dev.launch(k, grid, &in, &mut out, ...) -> Job` / `job.await()`。`await` 前に借用中バッファへ CPU が触ると **コンパイルエラー**(`&`=共有読み可 / `&mut`=排他)
- 文字列は **内部 UTF-32 / 入出力で UTF-8 変換**

## 必要なもの

Node 23.6+(TypeScript を直接実行)と C++ コンパイラ(g++ / clang++)。`npm install` 不要。
**GPU(`--gpu`)** は Apple Silicon + Xcode(`clang++`・Metal.framework)が必要。生成コードは Objective‑C++ として `-framework Metal -framework Foundation` でビルドされる(metal-cpp 不要)。

## 使い方

```sh
node src/main.ts emit  examples/echo.mzc          # 生成された C++ を表示
node src/main.ts build examples/sum.mzc           # build/sum を生成
node src/main.ts run   examples/fib.mzc           # ビルドして実行
node src/main.ts build examples/x.mzc --release   # 整数オーバーフローを wrap に
node src/main.ts run   examples/addk_async.mzc --gpu   # Apple Silicon GPU(Metal)で実行
node tests/run.ts                                 # ゴールデンテスト一式
```

コンパイラ/フラグは環境変数で上書き可能:`MZ_CXX`(既定: macOS=`clang++`)、`MZ_CXXFLAGS`。

例:

```sh
printf 'hello\nquit\n' | ./build/echo
```

## サンプル

[examples/](examples/): echo / sum / fib / funcs / floats / struct / enums / overflow / addk(カーネル)/ **addk_async**(`dev.launch`+`await`、CPU/GPU 両対応)/ **borrow_err**(借用=同期のコンパイルエラー例)。

## コンパイラ構成

[src/](src/): `lexer.ts` → `parser.ts`(AST 定義は `ast.ts`)→ `check.ts`(厳密な型検査)→ `emit.ts`(C++ 生成)→ `main.ts`(CLI ドライバ)。ランタイムは [runtime/mozaic_rt.h](runtime/mozaic_rt.h)。
