# mozaic ロードマップ — 言語の完成まで

> ステータス: 計画。**C++ 一本**で完成を目指す。マルチバックエンド(WASM/JS)・discrete GPU・
> 他社 UMA は**非目標**で、長期構想として [VISION.md](VISION.md) に残置する(完成の定義には含めない)。
> GPU は Apple Silicon / Metal のまま。

## 現在地（M3 完了・M4 大半・M6 着手 / branch `m3-abstraction`、ゴールデン **89/89**）
- パイプライン `lexer → parser → check → emit`(C++ 生成)+ ランタイム `runtime/mozaic_rt.h`。
- GPU/Metal バックエンド(Objective-C++、UMA ゼロコピー、`borrow=device-sync` キーストーン)。
- 借用チェッカ P1〜P4 実装済み: 単一所有 + ムーブ / 一級 `&T`・`&mut T` + struct メソッド /
  別名規則(`&mut` 排他 xor `&` 複数, device・task 統合)/ レキシカル escape(単一引数 provenance)。
- **M3 完了**: 総称型(fn+struct+メソッド) / `i128`/`u128`/`f16` / SIMD ベクタ(`f32x4` 等、host=`mz::Simd`/kernel=MSL) /
  `comptime` + トップレベル `const`(ビルド時評価器 `src/comptime.ts`)。
- **M4 大半**: `Atomic<T>`(`SeqCst` 含む全 Ordering)/ 構造化並行 `spawn`/`scope` /
  **結果返し `Task<R>.join()`**(`std::async`/`future`)/ **`Arc<T>`**(共有所有)・**`Mutex<T>`**(ガード)・**`Channel<T>`**(MPSC)。
- **M6 着手**: 可変長 **`Vec<T>`**(`push`/`pop`/`len`/`[i]`、`&mut Vec` で被呼出し変更)/
  可変 **`String` 構築**(`String.new`/`push`/`pushStr`)/ `stdin.readAll()`(全入力読込)。
- **言語コア補完**: 論理演算子 `&& || !`(短絡)、`else if` 連鎖。
- **M7 布石**: [tests/cases/lexer_mz.mzc](tests/cases/lexer_mz.mzc) = **mozaic で書いた字句解析器**(stdin を読み Vec にトークン収集 → 出力)。
  言語がコンパイラ段を記述できる表現力に達したことの実証。

## 残り(本セッション未完 / 次の着手対象)
- **M4d(GPU・実行時 device)**: カーネル `local.{x,y,z}`/`barrier()`/`shared [T;N]`(ワークグループ機構、Metal threadgroup 実装が要)、
  実行時 `Device.gpu.first() ?? Device.cpu` ディスパッチ。CPU ゴールデンでは回帰検証不能・セルフホスト前提でないため後回し。
- **M5(借用完全形)**: 格納参照の文跨ぎ別名 / NLL / disjoint-field 借用 / 明示 lifetime 注釈。
- **M6(残り)**: `import`/モジュール・名前解決・コンパイル単位、`Map<K,V>` 等の追加 stdlib、ファイル I/O(当面 `stdin.readAll()` で代替可)。
- **M7(セルフホスト ★)**: `lexer → parser → check → emit` を mozaic で書き直し、生成 C++ で既存ゴールデンを通す段階 bootstrap。
  字句解析器の布石は実証済み。残るは parser/check/emit の移植(最大の作業)。
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
| **M4** | 並行性の完成(大半 ✅) | ✅ `Mutex<T>` / `Channel<T>` / `Arc<T>` ・ ✅ 結果返し `join`(`Task<R>`)・ ✅ `Atomic` の `SeqCst`。残: `Send`/`Sync` の明示的形式化、カーネル `local.{x,y,z}` / `barrier()` / `shared [T;N]`、実行時 Device 選択(= M4d, GPU 依存) | M2(一部 M3) | 中〜大 |
| **M5** | 借用チェッカ完全形 | 格納参照の文跨ぎ別名 ・ NLL(最終使用での解放)・ disjoint-field 借用 ・ 明示 lifetime 注釈 + 多引数関係 | 現在地(独立) | 中 |
| **M6** | モジュール & 標準ライブラリ | `import` / コンパイル単位 / 名前解決 ・ 最小 stdlib(collections / math / 文字列)・ **ファイル I/O**(セルフホスト必須) | M2, M3 | 大 |
| **M7** | セルフホスト ★完成 | `lexer → parser → check → emit` を mozaic で書き直し、生成 C++ をビルドして既存ゴールデンを通す。段階 bootstrap | M2 + M3 + M6 | 最大 |

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
