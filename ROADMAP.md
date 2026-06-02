# mozaic ロードマップ — 言語の完成まで

> ステータス: 計画。**C++ 一本**で完成を目指す。マルチバックエンド(WASM/JS)・discrete GPU・
> 他社 UMA は**非目標**で、長期構想として [VISION.md](VISION.md) に残置する(完成の定義には含めない)。
> GPU は Apple Silicon / Metal のまま。

## 現在地（M3・M4 完了・M5 ほぼ完了・M6 完了・M7 bootstrap 実証 / branch `m3-abstraction`、ゴールデン **102/102**）
- パイプライン `lexer → parser → check → emit`(C++ 生成)+ ランタイム `runtime/mozaic_rt.h`。
- GPU/Metal バックエンド(Objective-C++、UMA ゼロコピー、`borrow=device-sync` キーストーン)。
- **M3 完了**: 総称型(fn+struct+メソッド) / `i128`/`u128`/`f16` / SIMD ベクタ(`f32x4` 等、host=`mz::Simd`/kernel=MSL) /
  `comptime` + トップレベル `const`(ビルド時評価器 `src/comptime.ts`)。
- **M4 完了**: `Atomic<T>`(`SeqCst` 含む全 Ordering)/ 構造化並行 `spawn`/`scope` /
  結果返し `Task<R>.join()`(`std::async`/`future`)/ `Arc<T>`・`Mutex<T>`・`Channel<T>` /
  **カーネルのワークグループ機構**(`shared [T;N]`/`local`/`group`/`barrier()`/`gridGroups`、GPU=MSL threadgroup・
  CPU=std::thread+std::barrier、[group_reduce.mzc](tests/cases/group_reduce.mzc) を**実機 Apple Silicon GPU で検証**)/
  **実行時 Device 選択** `Device.gpu.first() ?? Device.cpu`。
- **M5 ほぼ完了**: disjoint-field 借用 / **格納参照の文跨ぎ別名 + NLL**(`let r = &mut x` は r の最終使用まで x を借用、最終使用で解放)/ **`Send`/`Sync` 明示規則**(非 Sync 型への参照は spawn 引数にできない)。
- **M6 完了**: `import`(複数ファイル解決・diamond dedup)/ 可変長 `Vec<T>` / `Map<K,V>`(ハッシュマップ)/
  可変 `String` 構築(`String.new`/`push`/`pushStr`)/ ファイル I/O(`readFile`/`writeFile`)/ `stdin.readAll()`。
- **言語コア補完**: 論理演算子 `&& || !`(短絡)、`else if` 連鎖。
- **M7 bootstrap 実証**: 再帰データの要 **`Box<T>`** + `match` の `&Enum` 透過。
  **[tests/cases/selfhost.mzc](tests/cases/selfhost.mzc) = mozaic で書いた mozaic→C++ コンパイラ**(lex→再帰下降
  parse(`Box` 再帰 AST)→C++ emit)。再帰プログラム(fib/sumTo)を **clang++ で通る C++ に変換 → 実行 → 正答**を実機確認。
  関連実証: [calc_mz.mzc](tests/cases/calc_mz.mzc)(式評価器)/ [lexer_mz.mzc](tests/cases/lexer_mz.mzc) / [ast_eval.mzc](tests/cases/ast_eval.mzc)。

## 残り(次セッションの着手対象)
- **M7 全機能セルフホスト ★(最大の残作業)**: bootstrap は実証済み。残るは selfhost.mzc のサブセットを
  全言語機能(generics / atomic / comptime / 文字列 / GPU 等)へ拡張し、`src/*.ts`(約 2700 行)相当を mozaic で書き切って
  生成 C++ で既存 102 ゴールデン全件を通すこと。アーキテクチャは実証済みで、残るは網羅実装(数千行規模)。
- **M5(借用完全形の残り)**: NLL(最終使用での解放)・格納参照の文跨ぎフロー解析・明示 lifetime 注釈。
  データフロー解析が要で、過剰な制約はセルフホストの記述を妨げうるため慎重に。
- **M4 任意残**: `Send`/`Sync` の明示的形式化(現状は Buffer/Atomic/Mutex/Channel を by-ref Sync として保守的に扱う実装で代替)。
- **実行時 Device 選択の制約**: device の*選択*はビルド毎に正しく解決するが、実際の*計算バックエンド*はコンパイル時(`--gpu`)固定。
  単一バイナリ内での CPU/GPU 動的切替(両バックエンド同梱)は将来課題。
- **M2 言語コア実装済み**(branch `m2-language-core`): `char`+文字リテラル / `true`/`false` / `as`・`as?` /
  `str` リテラルを所有 `String` 化 / `abort`・`assert` / `defer` / `T?`(`some`/`none`/`??`/後置 `?`) /
  `Result<T,E>`(`Ok`/`Err`/`?`/`isOk`/`isErr`/`unwrap`/`unwrapErr`) / `[T;N]`・`[]T`(`slice`) /
  文字列 `.len`/`+`/`[i]`・`format`・テンプレート `` `…${e}…` ``。敵対的レビュー 2 回で健全性/コード生成バグ 11 件修正。
- ゴールデンテスト **66/66 pass**。
- M2 の残り(将来の磨き込み): `Result` コンビネータ、可変 `String` 構築 API(`push` 等)、配列/スライスの境界検査、`slice` の生存期間検査(M5)、単項マイナス。

## 完成の定義
1. **SPEC の(ホスト C++ に関わる)全項目を実装**し、§8 TBD を解消する。
2. **セルフホスト** — mozaic コンパイラを mozaic 自身で書き直し、生成 C++ が既存ゴールデンを 100% 通す。

北極星は 2。マルチバックエンドは完成条件に含めない。

---

## マイルストーン

| M | テーマ | 主な中身 | 依存 | 規模 |
|---|---|---|---|---|
| ~~**M2**~~ ✅ | 言語コア充実(**実装済み**) | `as`/`as?` ・ `T?` ・ `Result<T,E>` ・ `defer` ・ `[T;N]` / `[]T` ・ `char`+文字リテラル ・ `str`/`String`(`.len`/`+`/`[i]`/`format`)+ テンプレート `` `…${e}…` `` ・ `abort`/`assert`。残: `Result` コンビネータ、可変 `String` API、境界検査、単項マイナス | — | 完了 |
| ~~**M3**~~ ✅ | 抽象化(**実装済み**) | ✅ ユーザ総称型: generic fn（型推論）+ generic struct + **総称 struct のメソッド**（C++ テンプレートへ降ろし、コンテナ実装可能）。✅ `i128`/`u128`/`f16`。✅ ベクタ/SIMD(`f32x4` 等: splat/レーン構築/レーン演算/添字、host=`mz::Vec` / kernel=MSL native)。✅ `comptime` + トップレベル `const`(ビルド時評価器でテーブル生成) | M2 | 完了 |
| ~~**M4**~~ ✅ | 並行性の完成(**実装済み**) | ✅ `Mutex<T>` / `Channel<T>` / `Arc<T>` ・ 結果返し `join`(`Task<R>`)・ `Atomic` の `SeqCst` ・ **カーネル `local.{x,y,z}` / `group.{x,y,z}` / `barrier()` / `shared [T;N]`**(`gridGroups`、GPU=native MSL threadgroup・CPU=std::thread+std::barrier 模倣、実機 GPU で検証)・ **実行時 Device 選択**(`Device.gpu.first() ?? Device.cpu`)。残(任意): `Send`/`Sync` の明示的形式化 | M2(一部 M3) | 中〜大 |
| **M5** | 借用チェッカ完全形(ほぼ ✅) | ✅ disjoint-field 借用 ・ ✅ 格納参照の文跨ぎ別名 + NLL(最終使用で解放)・ ✅ `Send`/`Sync` 明示規則。残(任意): 明示 lifetime 注釈構文(provenance escape + NLL で安全性は担保済のため設計上省略) | 現在地(独立) | 中 |
| ~~**M6**~~ ✅ | モジュール & 標準ライブラリ(**実装済み**) | ✅ `import`(複数ファイル解決) ・ `Vec<T>` / `Map<K,V>` collections ・ 可変 `String` 構築 ・ **ファイル I/O** `readFile`/`writeFile` ・ `stdin.readAll` | M2, M3 | 大 |
| **M7** | セルフホスト ★完成(bootstrap 実証 ✅ / 全機能版残) | ✅ **mozaic で書いた mozaic→C++ コンパイラ** [selfhost.mzc](tests/cases/selfhost.mzc)(lex→再帰下降 parse→C++ emit)が再帰プログラムを **clang++ で通る C++ に変換し正しく実行**(fib/sumTo を実機検証)。残: 対応サブセットを全言語(generics/atomic/comptime/GPU 等)へ拡張し、生成 C++ で既存ゴールデン全件を通す | M2 + M3 + M6 | 最大 |

## クリティカルパス
**M2(文字列・collections・エラー処理)→ M3(総称型・comptime)→ M6(モジュール + ファイル I/O)→ M7(自己記述)★**

```
        ┌─ M5 借用完全形 ─────────────────────────┐ （並行・独立）
現在地 ─┼─ M2 コア ─ M3 抽象化 ─ M6 モジュール/stdlib/fileI/O ─ M7 セルフホスト ★
        └─ M4 並行完成 ─┘
```

M4(並行完成)と M5(借用完全形)は**並行トラック**。どちらもセルフホストの必須前提ではなく、
品質と到達範囲を上げる軸。

## 推奨着手順
1. **M2 最優先** — 特に未実装の `char` 型と `Result`/`?`。文字列処理はコンパイラの中核なので最初に固める。
2. **M5 を並行で** — 借用チェッカは独立トラック。文跨ぎ別名 → NLL → disjoint-field → 明示 lifetime の順。
3. **M3 → M6** — 総称型・`comptime` → モジュール + stdlib。ファイル I/O は「極小ランタイム」方針と緊張するため、
   当面は `mozaic build < src`(stdin 駆動)で回避するか、最小のファイル読みを足すかを M6 で確定する。
4. **M7 セルフホスト**で完成。lexer から段階 bootstrap し、各段で既存 40 ゴールデンを回帰ネットにする。

## 完了判定（目安）
- **M2**: `Result`/`?`・文字列処理・配列を使う実プログラムが通る。
- **M3**: `comptime` 生成テーブル + ユーザ generic fn が通る。
- **M4**: 複数スレッド + `Mutex`/`Channel` の決定的テスト、GPU `barrier()`/`shared` の例が通る。
- **M5**: 借用中の変更 / ローカル参照エスケープを全拒否、NLL 正例が通る。
- **M6**: 複数ファイルが `import` で解決・ビルドできる。
- **M7**: mozaic 製コンパイラが既存テストを 100% 通す。

---

## 借用チェッカ完全形（M5）の内訳
P1〜P4 のレキシカル借用検査は実装済み。M5 は SPEC §8 に残る以下を埋める:
- 格納参照(`let r: &T = &x`)の文跨ぎ別名解析
- NLL(レキシカルスコープ終端ではなく最終使用での借用解放)
- disjoint-field 借用(`v.x` と `v.y` を同時に別々に借りる)
- 明示 lifetime 注釈構文と多引数間の関係(単一引数 provenance を超える返り値)

## 残る §8 TBD（完成後も任意）
本ロードマップで完成扱いとしない、将来構想として保留する項目:
- マルチバックエンド(WASM / JS)、discrete GPU、他社 UMA — [VISION.md](VISION.md) の長期構想。
- 総称型と借用・並行性のより深い相互作用。
- 再代入可能 ref local など、上記 M5 を超える借用機能。
