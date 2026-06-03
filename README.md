# mozaic

CPU と GPU を同格に扱う、速度優先のシステムプログラミング言語。TypeScript 風の構文に Rust/Zig の意味論。

- 言語仕様(規範): [SPEC.md](SPEC.md) — v1.0、実装準拠。設計思想: [VISION.md](VISION.md)、到達状況: [ROADMAP.md](ROADMAP.md)
- コンパイラ実装: TypeScript(Node が `.ts` を直接実行、`tsc`/`npm install` 不要)
- 変換ターゲット: **C++ 一本**(OS 不問: g++/clang++)。GPU は Apple Silicon/Metal。WASM/JS は将来構想([VISION.md](VISION.md))

## ステータス

**言語コア完成**(M3–M7)。`mozaic → C++(/ Metal)→ ネイティブ実行`。ゴールデン **105/105**、
**セルフホスト不動点到達**(mozaic で書いた mozaic→C++ コンパイラが自分自身を再生成)。

## 機能(実装済み)

- **厳密な型・暗黙変換なし**: `i8`–`i128` / `u8`–`u128` / `f16` `f32` `f64` / `bool` / `char`(UTF-32)/ `str`(UTF-32)。明示キャスト `as` / 検査付き `as?`。
- **制御・宣言**: `function`(再帰・**総称** `<T>`)、`let`/`const`、`if`/`else if`/`else`、`while`、`for (… of stdin.lines())`、代入。
- **集約**: `struct`+メソッド(`&self`/`&mut self`)、ペイロード付き `enum` + 網羅 `match`、固定長配列 `[T;N]`、スライス `[]T`、`Box<T>`(再帰型)。
- **エラー処理(例外なし)**: オプショナル `T?`(`some`/`none`/`??`/後置 `?`)、`Result<T,E>`(`Ok`/`Err`/`?`/`unwrap`)、`abort`/`assert`、`defer`。
- **整数オーバーフロー**: 既定 trap(debug)/ wrap(`--release`)、明示 `+%`(ラップ)/ `+|`(飽和)、ゼロ除算・`MIN/-1` は両ビルドで trap。
- **コンパイル時計算**: `comptime` + トップレベル `const`(テーブル生成・定数畳み込み)。
- **SIMD ベクタ**: `f32x4` 等(`splat`/レーン構築/レーン演算/添字)。host=`mz::Simd`、kernel=ネイティブ MSL。
- **コレクション/文字列**: `Vec<T>`、`Map<K,V>`、可変文字列ビルダ(`String.new`/`push`/`pushStr`)、`format`、テンプレート文字列。
- **並行性(初めから一級)**: `scope`/`spawn`/`Task<R>.join()`、`Atomic<T>`(全 Ordering)、`Arc<T>`/`Mutex<T>`/`Channel<T>`。借用規則がデータ競合をコンパイル時に防ぐ。
- **カーネル(データ並列)**: `kernel`、`Buffer<T>`、`launch`/`dev.launch → Job`/`await`。**CPU と Apple Silicon GPU(Metal)両対応**。グリッドは 1D/2D `grid2`/3D `grid3`、ワークグループ `shared [T;N]`/`local`/`group`/`barrier()`/`gridGroups`。
- **GPU / Metal バックエンド**(`--gpu`): 同じ `kernel` を **MSL** へ降ろし、`Buffer.shared` は `MTLBuffer`(shared)= **UMA ゼロコピー**(host と GPU が同一メモリ)。
- **借用 = デバイス/スレッド同期**(キーストーン): `await`/`join` 前に借用中バッファへ CPU が触ると **コンパイルエラー**(`&`=共有読み可 / `&mut`=排他)。
- **モジュール / ファイル I/O**: `import`(複数ファイル・diamond dedup)、`readFile`/`writeFile`、`stdin.readAll`/`stdin.lines`。

詳細・規則・文法は [SPEC.md](SPEC.md)。**未実装/既知の限界**(ビット演算・三項演算子・境界検査・GPU の数値差など)は SPEC §17。

## 必要なもの

Node 23.6+(TypeScript を直接実行)と C++ コンパイラ(g++ / clang++)。`npm install` 不要。
**GPU(`--gpu`)** は Apple Silicon + Xcode(`clang++` / Metal.framework)が必要。生成コードは Objective‑C++ として
`-framework Metal -framework Foundation` でビルドされる(metal-cpp 不要)。

## 使い方

```sh
node src/main.ts emit  examples/echo.mzc          # 生成された C++ を表示
node src/main.ts build examples/sum.mzc           # build/sum を生成
node src/main.ts run   examples/fib.mzc           # ビルドして実行
node src/main.ts build examples/x.mzc --release   # 整数オーバーフローを wrap・-O3
node src/main.ts run   examples/addk_async.mzc --gpu   # Apple Silicon GPU(Metal)で実行
```

コンパイラ/フラグは環境変数で上書き可能: `MZ_CXX`(既定: macOS=`clang++`)、`MZ_CXXFLAGS`。

```sh
printf 'hello\nquit\n' | ./build/echo
```

## テスト

```sh
node tests/run.ts     # ゴールデン一式(常に CPU パスでビルド): 正例 + 負例 42 + emit アサート、105/105
tests/prove.sh        # 3 段証明: ① CPU ゴールデン ② GPU/Metal == CPU 出力 ③ 非同期の決定性(--release で反復)
```

`node tests/run.ts` は **CPU パス専用**。GPU/Metal の正しさ(実機 Metal で CPU と一致)と並行プリミティブの
決定性(競合なし)は [tests/prove.sh](tests/prove.sh) が別途証明する(Apple Silicon 以外では GPU 段を自動 SKIP)。

## サンプル

[examples/](examples/): echo / fib / funcs / floats / struct / enums / overflow / atomic_* / spawn_join /
**addk**(カーネル)/ **addk_async**(`dev.launch`+`await`、CPU/GPU 両対応)/ **matadd**(2D `grid2`)。
[tests/cases/](tests/cases/) に全機能の正例・負例が揃う(`grid3_basic`=3D グリッド、`wide128`=真の 128bit、
`group_reduce`=ワークグループ、`selfhost`=mozaic 製 mozaic コンパイラ 等)。

## コンパイラ構成

[src/](src/): `lexer.ts` → `parser.ts`(AST 定義は `ast.ts`)→ `check.ts`(厳密な型・借用・並行検査)→
`emit.ts`(C++ / MSL 生成)→ `main.ts`(CLI ドライバ)。`comptime.ts` はビルド時評価器。
ランタイムは [runtime/mozaic_rt.h](runtime/mozaic_rt.h)。
