# mozaic 言語仕様書 — v1.0

ステータス: **言語コア完成**(branch `m3-abstraction`、ゴールデン 102/102、セルフホスト不動点到達)。
本書は **実装(`src/lexer.ts → parser.ts → check.ts → emit.ts`、ランタイム `runtime/mozaic_rt.h`)の現状に準拠**した
規範文書である。設計思想は [VISION.md](VISION.md)、到達状況は [ROADMAP.md](ROADMAP.md) を参照。

> 本書は旧 v0.1 草案(M0–M2 対象)を全面改稿し、現に実装されている言語を記述する。実装と乖離していた旧記述
> (16 進/2 進リテラル `0xFF`/`0b1010`、型接尾辞 `42u8`、`for (c of s.chars())`、三項演算子 `?:` など)は
> **実装準拠に訂正**した。これらは現状**未実装**である(§16 参照)。
> 変換ターゲットは **C++ 一本**(GPU は Apple Silicon / Metal)。WASM / JS・discrete GPU は長期構想で本書の対象外。

---

## 0. 設計原則

1. **静的型付け・暗黙の型変換なし**(いかなる場合も)。型が違えば必ず明示変換が要る。
2. **GC なし / 隠れた確保なし / 値型中心 / 線形メモリ**。コストは常に目に見える。
3. **所有権と借用**でメモリ安全を実現。さらに**借用が CPU/GPU・スレッド間の同期を兼ねる**(キーストーン)。
4. **CPU と GPU を同格のデバイス**として扱う。同一カーネルが両方で動く。
5. **コンパイル時計算(`comptime`)** によりゼロコストのテーブル生成・定数畳み込み。
6. **null なし**(`T?` オプショナルと網羅 `match`)。**例外なし**(`Result` と `abort`)。
7. TypeScript 風の構文を出発点に、速度・厳密さに資するなら Rust/Zig の意味論を採る。

---

## 1. 字句構造 (Lexical)

### 1.1 空白・コメント
- 空白: 半角空白 / タブ / CR / LF(意味を持たない)。
- 行コメント: `//` から行末まで。
- ブロックコメント: `/* … */`。**ネスト不可**(最初の `*/` で閉じる)。

### 1.2 識別子
- `[A-Za-z_][A-Za-z0-9_]*`。
- 予約語(キーワード)は識別子にできない。

### 1.3 キーワード(予約語)
```
function  kernel  struct  enum  match  for  while  of  if  else
return  break  continue  const  let  mut  scope  spawn
true  false  as  defer  some  none  comptime  import
```
`mut` は `&mut` / `&mut self` の構成要素として現れる。`Ok` / `Err` / `Device` / `grid` / `local` / `group` /
`barrier` / `slice` / `format` / `assert` / `abort` / `stdin` / `stdout` / `shared` などはキーワードではなく、
**組込み名 / 文脈依存名**として扱う(`shared` はカーネル本体の文頭でのみ宣言として解釈される)。

### 1.4 リテラル

| 種類 | 例 | 備考 |
|---|---|---|
| 整数 | `0`、`42`、`1_000` | **10 進のみ**。桁区切り `_` 可(除去される)。**16 進/2 進・型接尾辞は無い**。 |
| 浮動 | `1.5`、`3.0`、`1e9`、`2.5E-3` | `.` の後に数字、または指数 `e`/`E`[`+`/`-`]。仮数部に `_` 可。 |
| 真偽 | `true` / `false` | 型 `bool`。 |
| 文字 | `'a'`、`'\n'`、`'あ'` | 型 `char`(**UTF-32**、1 コードポイント=32 ビット)。 |
| 文字列 | `"hello"`、`"a\nb"` | 型 `str`(UTF-32)。 |
| テンプレート | `` `x=${e}, y=${f}` `` | 補間 `${e}` は各値を `format` で埋め込み、`str` を生成。 |

文字エスケープ: `\n \t \r \0 \' \" \\`。それ以外の `\x` は `x` をそのまま。
文字列エスケープ: `\n \t \r \" \\`。テンプレートでは `` \` `` `\$` `\\` を解釈。

#### リテラルの型付け
整数/浮動リテラルは**未確定型**(`intlit` / `floatlit`)として生まれ、文脈の期待型へ適合する(これは*変換ではない*)。
- `let x: f32 = 1;` は可(`1` は `f32` として生まれる)。`let x: u8 = 200;` も可。
- 制約が無ければ既定で **整数 = `i32`、浮動 = `f64`**。
- 二項演算では両辺が同じ具体型へ統一される(`intlit` が相手側の型に適合)。`u8 + i32` のような**異具体型の混在はエラー**。

### 1.5 演算子・記号トークン
2 文字: `==  !=  <=  >=  =>  ??  &&  ||  +%  -%  *%  +|  -|  *|`
1 文字: `( ) { } [ ] ; : , . = + - * / % < > & ? !`

---

## 2. 型システム (Types)

### 2.1 スカラ型
| 分類 | 型 |
|---|---|
| 符号付き整数 | `i8` `i16` `i32` `i64` `i128` |
| 符号なし整数 | `u8` `u16` `u32` `u64` `u128` |
| 浮動小数 | `f16` `f32` `f64` |
| 真偽 | `bool` |
| 文字 | `char`(UTF-32 コードポイント) |
| 文字列 | `str`(UTF-32) |
| ユニット | 戻り型省略の関数の戻り型(値なし) |

### 2.2 複合型
| 構文 | 意味 |
|---|---|
| `[T; N]` | 固定長配列(`N` はリテラル) |
| `[]T` | スライス(`{ptr, len}` view、非所有) |
| `&T` / `&mut T` | 共有借用 / 排他借用 |
| `T?` | オプショナル(`null` の代替) |
| `f32x4`、`i16x8`、`u64x2` … | ベクタ(SIMD/レーン)。`<スカラ>x<レーン数>`、レーン数 ≥ 2 |
| `struct` | 値型の集約 |
| `enum` | ペイロード付き直和 |

### 2.3 ユーザ総称型
- 総称関数: `function id<T>(x: T): T { … }`(呼び出し引数から型推論)。
- 総称構造体: `struct Pair<A, B> { … }`(構築時にフィールド値から型引数を推論)、そのメソッドも総称。
- 型パラメータに**境界(bound)構文は無い**。

### 2.4 組込み総称・ライブラリ型
| 型 | 用途 | 主な生成・操作 |
|---|---|---|
| `Result<T, E>` | 回復可能エラー | `Ok(v)` / `Err(e)`、`?`、`isOk`/`isErr`/`unwrap`/`unwrapErr` |
| `Buffer<T>` | デバイス常駐配列 | `Buffer.shared(n)`、`[i]`、`.len` |
| `Vec<T>` | 伸長配列(ホスト専用) | `Vec.new()`、`push`/`pop`/`len`、`[i]` |
| `Map<K, V>` | ハッシュマップ(ホスト専用) | `Map.new()`、`insert`/`get`/`has`/`.len` |
| `Box<T>` | ヒープボックス(再帰型に必須) | `Box.new(v)`、`.get()` |
| `Arc<T>` | 共有所有(スレッド安全) | `Arc.new(v)`、`.clone()`、`.get()` |
| `Mutex<T>` | ロック付きセル(ホスト専用) | `Mutex.new(v)`、`.lock() → MutexGuard<T>`、`g.val` |
| `Channel<T>` | スレッド間キュー(ホスト専用) | `Channel.new()`、`.send(v)`/`.recv()` |
| `Atomic<T>` | ロックフリー共有セル | `Atomic.new(v)`、`load`/`store`/`fetchAdd`/`compareExchange`(§9.2) |
| `Task` / `Task<R>` | `spawn` の結果ハンドル | `.join()`(`R` または値なし) |
| `Device` / `Job` / `Grid` / `Ordering` | デバイス・起動関連(§10) | |

**予約名**: `Arc Mutex Channel MutexGuard Vec Map Box` はユーザの `struct`/`enum` 名に使えない。
`enum` のバリアント名 `Ok` / `Err` は `Result` 用に予約。

### 2.5 暗黙変換の禁止
次はすべて**コンパイルエラー**(明示変換が必要):
- 数値の拡大: `let b: i64 = i32val;` は不可 → `i32val as i64`。
- 数値の縮小、符号差、整数↔浮動、`bool`↔整数、`char`↔整数、`enum`↔整数。
- 条件式は `bool` 限定(`if (n)` 不可 → `if (n != 0)`)。truthy/falsy は無い。
- スカラ→ベクタの暗黙ブロードキャスト不可 → `v + f32x4.splat(2.0)`。
- `T` 値を `T?` に暗黙包装しない → `some(v)`。

「変換でないもの」は対象外: 数値リテラルの文脈型付け、参照の自動デリファレンス、`&mut T → &T` の縮約。

### 2.6 キャスト(明示変換)
| 構文 | 意味 |
|---|---|
| `e as T` | スカラ間変換。整数の縮小は切り捨て(ラップ)、浮動→整数は 0 方向丸め、`char`↔`u32` も可。 |
| `e as? T` | **検査付き**変換 → `T?`(`T` は整数型)。範囲外なら `none`。元は整数/浮動。 |

```typescript
const big: i32 = 300;
stdout.println(big as u8);    // 44(切り捨て)
stdout.println('A' as u32);   // 65
stdout.println(66 as char);   // B
let b = 300 as? u8;           // none(範囲外)
```

---

## 3. 宣言 (Declarations)

```typescript
// 関数(再帰可。総称は <T> を付ける)
function add(a: i32, b: i32): i32 { return a + b; }
function id<T>(x: T): T { return x; }

// 束縛: const = 不変 / let = 可変(再代入・&mut 借用が可能)
const PI: f32 = 3.1415927;
let count: i32 = 0;

// 構造体 + メソッド(受け手は self の借用形を明示)
struct Vec2 {
  x: i32;
  y: i32;
  function len2(&self): i32 { return self.x * self.x + self.y * self.y; }
  function scale(&mut self, k: i32) { self.x = self.x * k; self.y = self.y * k; }
}

// 直和 + 網羅 match
enum Shape { Circle(f64), Rect(f64, f64), Unit }

// カーネル(§10)
kernel addk(input: Buffer<u32>, output: Buffer<u32>, k: u32) { /* … */ }

// トップレベル定数 / コンパイル時計算(§11)
const SQ: [i32; 8] = comptime squares();

// モジュール取り込み(§12)
import "modules/mathmod.mzc";
```

- メソッド受け手は `self`(ムーブ) / `&self`(共有) / `&mut self`(排他)。
- 戻り型を省略した関数は値を返さない(ユニット)。`function main()` は値なし必須。
- 型注釈を省いた `let`/`const` は初期化子から型推論。

---

## 4. 式と文 (Expressions & Statements)

### 4.1 演算子と優先順位(緩い→強い)
| 段階 | 演算子 | 結合 |
|---|---|---|
| 1 | `??`(オプショナルの既定値) | 左 |
| 2 | `\|\|` | 左 |
| 3 | `&&` | 左 |
| 4 | `== != < <= > >=` | 左 |
| 5 | `+ -`、`+% -%`(ラップ)、`+\| -\|`(飽和) | 左 |
| 6 | `* / %`、`*%`(ラップ)、`*\|`(飽和) | 左 |
| 7 | `as` / `as?`(キャスト) | 左 |
| 8 | 前置 `! & &mut comptime` | 右 |
| 9 | 後置 `.field` `[i]` `f(...)` `?`(失敗伝播) | 左 |

論理 `&& \|\| !` は短絡評価で、オペランドは `bool` 必須。**三項演算子 `?:` は無い**(`if`/`match` を使う)。

### 4.2 文
- `let` / `const` 束縛、式文、代入(`lhs = rhs;`、lhs は識別子/フィールド/添字)。
- `if (cond) { … } else if (…) { … } else { … }`(`cond` は `bool`)。
- `while (cond) { … }`(`cond` は `bool`)。
- `for (const x of stdin.lines()) { … }` — **反復対象は `stdin.lines()` のみ**(`x: str`)。
  配列/`Vec`/文字列の走査は `while` + 添字で行う。
- `match`(§4.3)。
- `defer <文>` / `defer { … }` — スコープ終了時に LIFO 実行(後始末。早期 `return` でも走る)。
- `scope { … }` — 構造化並行ブロック(終端で `spawn` 全 join、§9)。
- `spawn f(args…);` — タスク起動(§9)。
- `break;` / `continue;` / `return [式];`。
- カーネル内 `shared name: [T; N];` — ワークグループ共有メモリ宣言(§10)。

### 4.3 パターンマッチ
```typescript
function size(s: Shape): f64 {
  match s {
    Circle(r)   => { return r * r; }
    Rect(w, h)  => { return w * h; }
    Unit        => { return 0.0; }
  }
  return 0.0;
}
```
- 各アームは `バリアント(束縛, …) => { ブロック }`。束縛は識別子のみ(ネストパターン無し)。
- `_` をバリアント名に書くとワイルドカード。**網羅性をコンパイル時に検査**(ワイルドカード無しで未カバーのバリアントがあればエラー)。
- `&Enum` / `&mut Enum` を透過して match できる(自動デリファレンス)。

---

## 5. 数値オーバーフロー (Integer Overflow)

整数演算のみが対象(浮動は IEEE-754 で `inf`/`NaN`)。

- **既定 `+ - *`・関連演算**: debug ビルドは**トラップ(`abort`)**、`--release` は**ラップ(2 の補数)**。
  → バグは開発時に捕え、本番は分岐なしで速い。
- **明示演算子**(ビルドに依らず確定):
  - ラップ: `a +% b` / `a -% b` / `a *% b`
  - 飽和: `a +| b` / `a -| b` / `a *| b`(型の min/max でクランプ)
- `/` `%` のゼロ除算、`MIN / -1` は**両ビルドでトラップ**(`MIN % -1` は 0)。
- 検査付き変換は `as?`(→ `T?`)。

```typescript
let a: u8 = 255;
stdout.println(a +% 1);   // 0   (ラップ)
stdout.println(a +| 1);   // 255 (飽和)
```

> バックエンド注: ホスト C++ は `__builtin_*_overflow` でトラップ/ラップを実現。Metal カーネルでは GPU の
> ネイティブ演算(ラップ)に潰れ、ゼロ除算は未定義・飽和は近似となる(§10)。

---

## 6. 文字と文字列 (char & Strings)

**内部表現は UTF-32**(`char` = 1 コードポイント = 32 ビット固定幅。実装上は `std::u32string`)。
入出力境界(stdin/stdout/ファイル)でのみ UTF-8 と相互変換する。

- `str` が文字列型。文字列リテラル `"…"` は `str`。
- `.len` は**コードポイント数**(O(1))、`s[i]: char` は O(1) 添字(中間バイト事故が無い)。
- 連結 `a + b`(新しい文字列)。テンプレート `` `…${e}…` `` は各 `e` を `format` で埋め込む。
- `format(x): str` — 任意のスカラ/`bool`/`char`/`str` を文字列化する組込み関数。
- 可変構築: `String.new()` で空文字列、`.push(c: char)` で 1 文字、`.pushStr(s: str)` で連結。
- `char` ↔ `u32` は明示キャスト(`c as u32` / `n as char`)。

```typescript
function greet(name: str, age: i32): str {
  return `Hello, ${name}! You are ${age}.`;
}
let s: str = "héllo";
stdout.println(s.len);   // 5(コードポイント数)
stdout.println(s[1]);    // é
```

---

## 7. エラー処理 (Error Handling)

例外・隠れた制御フローは持たない。

### 7.1 オプショナル `T?`
- 生成: `some(v)` / `none`。`none` 単独は文脈型が要る。
- 既定値: `opt ?? default`(`opt: T?`、結果 `T`)。
- 失敗伝播: 後置 `?`(`none` なら即 `return none`)。関数の戻り型が `U?` か `Result<U,E>` のとき使える。
- 比較: `opt == none` / `opt != none`。**`T` を `T?` に暗黙包装しない**(`some(v)` が必要)。

### 7.2 `Result<T, E>`(組込み `enum Result<T,E> { Ok(T), Err(E) }`)
- 生成: `Ok(v)` / `Err(e)`。
- 伝播: 後置 `?`(`Err(e)` なら即 `return Err(e)`)。**暗黙のエラー型変換は無い**(`?` 先と関数の `E` が一致必須)。
- 処理: `match`、`.isOk()`/`.isErr()`/`.unwrap()`/`.unwrapErr()`。`unwrap`/`unwrapErr` は不一致時に `abort`。

```typescript
function parse(x: i32): Result<i32, str> {
  if (x > 0) { return Ok(x * 10); }
  return Err("not positive");
}
function doubleParse(x: i32): Result<i32, str> {
  let v = parse(x)?;        // Err なら即 return Err
  return Ok(v + 1);
}
```

### 7.3 回復不能エラー
- `abort(msg?: str)` / 失敗した `assert(cond: bool, msg?: str)` / 添字範囲外(debug)。
- 即終了(診断は stderr)。**スタック巻き戻しなし** → `abort` 時に `defer`/デストラクタは走らない。
  対して `?` の早期 return は通常の return なので `defer` は走る。

---

## 8. 所有権・借用・ムーブ (Ownership & Borrowing)

### 8.1 Copy とムーブ
- **Copy 型**: 全スカラ(整数/浮動/`bool`/`char`)、スライス `[]T`、SIMD ベクタ、`[T; N]`(`T` が Copy のとき)。
- **ムーブ型(非 Copy)**: `str`、`struct`、ペイロード付き `enum`、`Buffer`/`Vec`/`Map`/`Box`/`Arc`/`Mutex`/`Channel`。
- `Atomic<T>` は**非 Copy かつ非ムーブ**(束縛/フィールド/`Buffer` 要素としてその場に固定)。

### 8.2 ムーブ検査
- 値渡し/再束縛(`let q = p`)で非 Copy 型はムーブ。以後 `p` の使用は **use-after-move エラー**。
- 再代入(`p = q;`)はムーブ済みフラグを解除(復活)。
- **ループ内で外側束縛をムーブするのは不可**(`cannot move … inside a loop`)。

### 8.3 参照と別名規則
- `&T`(共有・複数可) / `&mut T`(排他・同時に 1 つ)。借用は所有者より長生きできない。自動デリファレンス。
- `&mut` は `let` 可変束縛のみ(`const` 束縛への `&mut` はエラー)。共有参照越し / 不変束縛のフィールド代入は不可。
- **1 つの呼び出し**の引数で、同じ経路を `&mut` と他(`&`/`&mut`)に同時借用するのは不可(`&` 複数は可)。
- **disjoint フィールド借用**: `p.x` と `p.y` は別経路として同時に `&mut` 借用できる(同一フィールド二重は不可)。

### 8.4 生存期間と escape
- 参照/スライスを返す関数(`: &T` / `: []T`)は、**引数由来のものだけ返せる**。
  `return &local` / `return slice(localArray)` は dangling になるため拒否。
- 格納参照 `let r = &x` / `let r = &mut x` は **NLL**(非レキシカル生存期間)で `r` の**最終使用まで** `x` を借用。
  その間 `x` の読み書き・再借用は制限される(`&` 中は書込/`&mut`借用不可、`&mut` 中は読書/再借用不可)。

### 8.5 Send / Sync
- `&` 共有でスレッド境界(`spawn`)を越えられるのは **Sync 型**のみ(`Buffer`/`Atomic`/`Mutex`/`Channel`/`Arc` を保守的に Sync 扱い)。
- 非 Sync 型への参照を `spawn` 引数にするとエラー(`cannot cross a thread boundary`)。
- **`Atomic<T>` は `&` 共有のまま書ける唯一の例外**(§9.2)。

---

## 9. 並行性 (Concurrency)

マルチスレッドは一級機能。所有権・借用がスレッド間データ競合をコンパイル時に防ぐ。
並行な仕事は「**完了まで借用を保持し、合流点が唯一の同期境界**」で統一される。

| 形態 | 構文 | 合流(借用返却) | 走る場所 |
|---|---|---|---|
| データ並列 | `dev.launch(k, grid, …) → Job` | `job.await()` | CPU プール / GPU |
| タスク並列 | `scope { spawn f(…); }` / `let t = spawn f(…)` | scope 終端 / `t.join()` | CPU スレッド |

### 9.1 構造化並行 (scope / spawn / Task)
```typescript
scope {
  spawn worker(&counter, iters);   // & 借用を保持
  spawn worker(&counter, iters);
}                                  // 終端で全 join、借用返却

let t: Task<u64> = spawn sumTo(1000);   // 結果付きタスク
let r: u64 = t.join();                  // 合流して結果取得
```
- `spawn f(args…)` は関数呼び出し形(クロージャ不要)。`scope` 外の裸 `spawn` はエラー。
- 値なしは `Task`、結果付きは `Task<R>`(`join` が `R` を返す)。**`join` されない `Task` はエラー**。

### 9.2 `Atomic<T>` — ロックフリー共有セル
通常メモリの競合は禁止される一方、`Atomic<T>` は**データ競合自由だけ**を狭く外す唯一の口
(各アクセスはハードウェアの不可分命令)。

- 型 `T` は **`u32` / `i32` / `u64` / `i64`** のみ。生成は `Atomic.new(v)`(束縛に型注釈が必要)。
- `&Atomic<T>` は複数スレッドが同時に持て、`&` 共有のまま書ける(Sync の例外)。値として読む(`a + 1` 等)のは不可。
- 操作(すべて `&Atomic<T>` レシーバ):

| 操作 | 意味 |
|---|---|
| `load(order): T` | 読み出し |
| `store(value: T, order)` | 書き込み |
| `fetchAdd(value: T, order): T` | 加算して**旧値**を返す |
| `compareExchange(expected, desired, success, failure): bool` | 一致時に書いて `true`、違えば `false` |

- メモリ順序 `Ordering`: `Relaxed` / `Acquire` / `Release` / `AcqRel` / `SeqCst`。**既定なし・呼び出しごとに明示必須**。
  順序の妥当性:

| 操作 | 許される順序 |
|---|---|
| `load` | Relaxed, Acquire, SeqCst |
| `store` | Relaxed, Release, SeqCst |
| `fetchAdd` | Relaxed, Acquire, Release, AcqRel, SeqCst |
| `compareExchange` success | Relaxed, Acquire, Release, AcqRel, SeqCst |
| `compareExchange` failure | Relaxed, Acquire, SeqCst |

```typescript
function worker(c: Atomic<u32>, iters: u32) {
  let i: u32 = 0;
  while (i < iters) { c.fetchAdd(1, Relaxed); i = i + 1; }
}
function main() {
  let counter: Atomic<u32> = Atomic.new(0);
  scope { spawn worker(&counter, 100000); spawn worker(&counter, 100000); }
  stdout.println(counter.load(Relaxed));   // 200000(競合下でも決定的)
}
```

### 9.3 `Arc<T>` / `Mutex<T>` / `Channel<T>`
```typescript
let shared: Arc<[i32; 8]> = Arc.new(table);
let t1 = spawn sumRange(shared.clone(), 0, 4);   // .clone() で所有を共有

let m: Mutex<i64> = Mutex.new(0);
let g = m.lock(); g.val = g.val +% 1;            // ロック下で読み書き

let c: Channel<i32> = Channel.new();
c.send(1); let x = c.recv();                      // スレッド間キュー
```
- `Arc<T>` は不変共有所有(`.clone()`/`.get()`)。`Mutex`/`Channel` は非 Copy・非ムーブ(`&` で渡す)。
- `Arc`/`Mutex` の中身に `Atomic` は不可。`Mutex`/`Channel`/`Vec`/`Map`/`Box` はカーネル内で使えない。

---

## 10. デバイスとカーネル (Devices & Kernels)

### 10.1 起動と借用=同期
```typescript
kernel addk(input: Buffer<u32>, output: Buffer<u32>, k: u32) {
  let i: u32 = grid.x;
  if (i < output.len) { output[i] = input[i] + k; }
}
function main() {
  let n: u32 = 4;
  let buf: Buffer<u32> = Buffer.shared(n);
  let out: Buffer<u32> = Buffer.shared(n);
  // …buf を埋める…
  let dev: Device = Device.gpu;
  let job: Job = dev.launch(addk, n, &buf, &mut out, 10);
  // ここで out に触るとコンパイルエラー(in-flight job が &mut 借用中)
  job.await();                       // 同期境界。UMA はフェンスのみ
  // 以後 out を読める
}
```
- **借用=同期(キーストーン)**: `launch` は引数バッファを借用し `Job` が保持。`await` 前に `&mut` 借用中の
  バッファに CPU が触ると**コンパイルエラー**(`&` 借用は CPU 並走読み可)。
- 同期 sugar として自由関数 `launch(k, grid, args…)`(即ブロック)もある。
- `Device.cpu` / `Device.gpu`、実行時選択は `Device.gpu.first() ?? Device.cpu`(`.first(): Device?`)。

### 10.2 バッファとグリッド
- `Buffer.shared(n)` — UMA でゼロコピー(host/GPU 同一メモリ)。`[i]` / `.len`(`u32`)。
  (GPU 専有の `Buffer.device` は設計概念だが現状未実装、§17。)
- グリッド: 1D は整数、2D は `grid2(w, h)`、3D は `grid3(w, h, d)`。ワークグループ指定は `gridGroups(numGroups, groupSize)`。
- カーネル組込み: `grid.{x,y,z}`(全体位置)、`local.{x,y,z}`(グループ内 ID)、`group.{x,y,z}`(グループ ID)、
  `barrier()`(グループ同期)、`shared name: [T; N];`(ワークグループ共有メモリ)。

```typescript
kernel groupSum(input: Buffer<i32>, output: Buffer<i32>) {
  shared scratch: [i32; 64];
  let lid: u32 = local.x;
  if (grid.x < input.len) { scratch[lid] = input[grid.x]; } else { scratch[lid] = 0; }
  barrier();
  let stride: u32 = 32;
  while (stride > 0) {
    if (lid < stride) { scratch[lid] = scratch[lid] +% scratch[lid +% stride]; }
    barrier();
    stride = stride / 2;
  }
  if (lid == 0) { output[group.x] = scratch[0]; }
}
// launch(groupSum, gridGroups(4, 64), input, output);
```

### 10.3 カーネルサブセット
- **許可**: スカラ/ベクタ演算、`struct`、固定長配列、分岐、有界ループ、`Buffer` 添字、`grid`/`local`/`group`/`barrier`/`shared`。
- **禁止**: 参照/オプショナル/`Result`/配列・スライスの**引数**(`Buffer<T>` を使う)、`Atomic`、`Mutex`/`Channel`/`Vec`/`Map`/`Box`、
  `spawn`、トップレベル `const` 参照、再帰・動的確保・I/O。

### 10.4 コード生成(CPU / Metal)
- **CPU**: カーネルは C++ 関数になり、`launch` がグリッドをワーカープールで実行。ワークグループは `std::thread`+`std::barrier` で模倣。
- **Metal(`--gpu`)**: 同じカーネルを **MSL** に降ろし、`Buffer<T>` を `MTLStorageModeShared` の `MTLBuffer` に。
  `device` バッファは長さを持たないため `.len` は uniform で別途渡る。`grid.x`→`thread_position_in_grid` 等にマップ。
  MSL は実行時 `newLibraryWithSource` でコンパイル(Objective-C++ + システム Metal.framework、metal-cpp 不要)。

---

## 11. コンパイル時計算 (comptime)

- `comptime <式>` と トップレベル `const` をビルド時に評価(`src/comptime.ts` の木構造インタプリタ。C++ constexpr ではない)。
- ルックアップ表生成・定数畳み込み・ゼロコスト特殊化に使う。
- 対応: リテラル、`const`/局所値の参照、配列/構造体リテラル、添字、`.len`/フィールド、算術(ラップ/飽和含む)、
  比較・論理(短絡)、`as`、非総称関数呼び出し、`if`/`while`/`return`/`break`/`continue`。
- 非対応: 総称関数呼び出し、`as?`、`?`、借用、`comptime` の入れ子、ランタイム値の読み出し。
- 検査: ランタイム値を読むとエラー、整数オーバーフロー/ゼロ除算はコンパイルエラー、評価ステップ上限あり。

```typescript
const N: i32 = 5;
const DOUBLE_N: i32 = comptime N + N;     // 10
function squares(): [i32; 8] { /* … */ }
const SQ: [i32; 8] = comptime squares();  // {0,1,4,…,49} をバイナリに焼き込む
```

---

## 12. モジュール (Modules)

```typescript
import "modules/mathmod.mzc";   // インポート元からの相対パス
```
- `import "パス";` で別ファイルのトップレベル宣言を取り込む。インポートはインポート元ファイルからの相対解決。
- ダイヤモンド依存は重複除去(同一ファイルは 1 度だけ取り込む)。

---

## 13. 標準ランタイム / 組込み API

### 13.1 入出力
| API | 型 | 意味 |
|---|---|---|
| `stdin.lines()` | 反復(`for…of` 専用) | 行を UTF-32 で読み、`str` を産む |
| `stdin.readAll()` | `str` | 標準入力全体を UTF-32 で読む |
| `stdout.println(x)` | — | スカラ/`bool`/`char`/`str` を 1 行出力 |
| `readFile(path: str)` | `str?` | ファイル全体を読む(失敗で `none`) |
| `writeFile(path: str, content: str)` | `bool` | 書き込み(成功で `true`) |

### 13.2 自由関数
| API | 意味 |
|---|---|
| `format(x): str` | 任意のスカラ/`bool`/`char`/`str` を文字列化 |
| `slice(arr: [T; N]): []T` | 固定配列のスライス view(引数は名前付き配列変数) |
| `abort(msg?: str)` | 即終了 |
| `assert(cond: bool, msg?: str)` | 偽なら `abort`(常に検査) |
| `grid2(w, h)` / `grid3(w, h, d)` / `gridGroups(ng, gs)` | グリッド構築(§10) |
| `barrier()` | カーネル内グループ同期(§10) |
| `launch(k, grid, …)` | 同期カーネル起動(§10) |

### 13.3 型ごとの主なメソッド(再掲)
- `str`: `.len`、`[i]`、`+`、テンプレート / `String.new()`・`.push(char)`・`.pushStr(str)`。
- `Vec<T>`: `.push(v)`、`.pop(): T?`、`.len`、`[i]`。
- `Map<K,V>`: `.insert(k, v)`、`.get(k): V?`、`.has(k): bool`、`.len`。
- `Box<T>`: `Box.new(v)`、`.get(): &T`(再帰型のフィールドに使う)。
- `Arc<T>`: `Arc.new(v)`、`.clone()`、`.get(): &T`。
- `Mutex<T>`: `Mutex.new(v)`、`.lock(): MutexGuard<T>`、`MutexGuard.val`。
- `Channel<T>`: `Channel.new()`、`.send(v)`、`.recv(): T`。
- `Atomic<T>`: §9.2。`Buffer<T>`: §10。`Result`/`T?`: §7。`Task`: §9。

---

## 14. 静的検査(拒否される構文)カタログ

検査器(`src/check.ts`)が拒否する主なカテゴリ。各 `.err` ゴールデンに対応。

- **型**: 暗黙変換(拡大/縮小/`bool`↔int/`enum`↔int)、`bool` でない条件、非 `bool` の `&& \|\| !`、ベクタの暗黙ブロードキャスト、引数/戻り/フィールド/代入の型不一致、総称型の推論衝突・推論不能。
- **オプショナル/Result**: `T` を `T?` に暗黙包装、`?` の戻り型不整合、`?` のエラー型不一致、`??` の非オプショナル。
- **ムーブ/借用**: use-after-move、ループ内ムーブ、`&mut`×2 / `&`+`&mut` の同一呼び出し別名、`const` 束縛の `&mut`・フィールド代入、共有参照越しの変更メソッド、ローカル参照/スライスの escape、格納参照が生きている間の使用。
- **並行/デバイス**: `await` 前の `&mut` 借用バッファ参照、`launch` のバッファ別名・引数規約、`spawn` の非 call/非 Sync 参照、`Task` の join 漏れ、裸 `spawn`。
- **Atomic**: `T` が `u32/i32/u64/i64` 以外、Copy/ムーブ、値として使用、順序不正、`Atomic` を含む型の値返し、`Ok`/`Mutex`/`Arc` への入れ子。
- **カーネル**: 参照/オプショナル/`Result`/配列・スライスの引数、`Atomic`、`Mutex`/`Channel`/`Vec`/`Map`/`Box`、`spawn`、`shared`/`barrier`/`grid` のカーネル外使用。
- **その他**: 非網羅 match・未知バリアント・アリティ不一致、予約名(`Ok`/`Err`/ライブラリ総称名)の再定義、`main` の不在/非空シグネチャ、`comptime` でのランタイム値読み・オーバーフロー、テンプレートに非整形可能値、`stdin.lines()` 以外の `for…of`。

---

## 15. 文法 (EBNF, 抜粋)

```ebnf
Program    = { Item } ;
Item       = ImportDecl | FnDecl | StructDecl | EnumDecl | KernelDecl | ConstDecl ;

ImportDecl = "import" String ";" ;
FnDecl     = "function" Ident [ TypeParams ] "(" [ Params ] ")" [ ":" Type ] Block ;
TypeParams = "<" Ident { "," Ident } ">" ;
Params     = Param { "," Param } ;
Param      = Ident ":" Type ;

StructDecl = "struct" Ident [ TypeParams ] "{" { Field | Method } "}" ;
Field      = Ident ":" Type ";" ;
Method     = "function" Ident "(" [ Recv [ "," Params ] ] ")" [ ":" Type ] Block ;
Recv       = "self" | "&" "self" | "&" "mut" "self" ;

EnumDecl   = "enum" Ident "{" { Variant [ "," ] } "}" ;
Variant    = Ident [ "(" Type { "," Type } ")" ] ;

KernelDecl = "kernel" Ident "(" [ Params ] ")" Block ;
ConstDecl  = "const" Ident ":" Type "=" Expr ";" ;

Block      = "{" { Stmt } "}" ;
Stmt       = ( "let" | "const" ) Ident [ ":" Type ] "=" Expr ";"
           | "return" [ Expr ] ";"
           | "if" "(" Expr ")" Block [ "else" ( IfStmt | Block ) ]
           | "while" "(" Expr ")" Block
           | "for" "(" [ "let" | "const" ] Ident "of" Expr ")" Block
           | "match" Expr "{" { Ident [ "(" Ident { "," Ident } ")" ] "=>" Block } "}"
           | "defer" ( Block | Stmt )
           | "scope" Block
           | "spawn" Expr ";"
           | "shared" Ident ":" Type ";"
           | "break" ";" | "continue" ";"
           | LValue "=" Expr ";"
           | Expr ";" ;

Type       = Scalar | Vector | Ident [ "<" Type { "," Type } ">" ]
           | "[" Type ";" Expr "]" | "[" "]" Type
           | "&" [ "mut" ] Type | Type "?" ;
Vector     = Scalar "x" Int ;

Expr       = OrElse ;
OrElse     = LogicalOr { "??" LogicalOr } ;
LogicalOr  = LogicalAnd { "||" LogicalAnd } ;
LogicalAnd = Comparison { "&&" Comparison } ;
Comparison = Additive { ( "==" | "!=" | "<" | "<=" | ">" | ">=" ) Additive } ;
Additive   = Mul { ( "+" | "-" | "+%" | "-%" | "+|" | "-|" ) Mul } ;
Mul        = Cast { ( "*" | "/" | "%" | "*%" | "*|" ) Cast } ;
Cast       = Unary { ( "as" | "as?" ) Type } ;
Unary      = ( "&" [ "mut" ] | "!" | "comptime" ) Unary | Postfix ;
Postfix    = Primary { "." Ident | "[" Expr "]" | "(" [ Args ] ")" | "?" } ;
Primary    = Num | Float | Str | Char | Bool | Template
           | "some" "(" Expr ")" | "none" | Ident "(" Expr ")"   (* Ok/Err *)
           | "spawn" Ident "(" [ Args ] ")"
           | "[" [ Expr { "," Expr } ] "]"
           | Ident [ "{" { Ident ":" Expr [ "," ] } "}" ]        (* struct literal *)
           | "(" Expr ")" ;
```

---

## 16. ツールチェーン

`.ts` は Node が型ストリップで直接実行(`tsc`/`node_modules`/ビルド不要)。

```sh
node src/main.ts emit  examples/echo.mzc            # 生成 C++ を表示
node src/main.ts build examples/sum.mzc             # build/ に生成
node src/main.ts run   examples/fib.mzc             # ビルドして実行
node src/main.ts build x.mzc --release              # 整数オーバーフローを wrap・-O3
node src/main.ts run   examples/addk_async.mzc --gpu  # Apple Silicon GPU(Metal)
node tests/run.ts                                   # ゴールデンテスト一式(102/102)
```
- フラグ: `--release`(最適化・ラップ)、`--gpu`/`--metal`(Metal バックエンド)。
- 環境変数: `MZ_CXX`(既定 macOS=`clang++`)、`MZ_CXXFLAGS`。
- ホスト C++ は `-std=c++20`。GPU は Objective-C++ + `-framework Metal -framework Foundation`。

---

## 17. 未実装 / 将来構想

本書は実装済みの言語を規範とする。次は**現状未実装**または長期構想:

- 旧 v0.1 草案にあった構文糖のうち未実装: **16 進/2 進リテラル・型接尾辞**、**三項演算子 `?:`**、
  `for (c of s.chars())` 等の汎用 `for…of`、`Result` の `.map`/`.map_err`/`.ok` コンビネータ、
  検査付き算術メソッド(`.checkedAdd` 等)、配列/スライスの実行時境界検査。
- 借用: 明示 lifetime 注釈構文、多引数間の lifetime 関係(現状は単一引数 provenance + NLL で安全性を担保)。
- 並行/デバイス: GPU 専有バッファ `Buffer.device`、単一バイナリ内の CPU/GPU 動的切替(現状 `--gpu` でコンパイル時固定)、GPU 上の atomic、MSL の飽和/f64 精緻化。
- バックエンド: **WASM / JS、discrete GPU(コピーバック)、他社 UMA** — 設計上の方向性として [VISION.md](VISION.md) に保留。
- セルフホスト: サブセットで自己ホスト不動点に到達済み([tests/cases/selfhost.mzc](tests/cases/selfhost.mzc))。全機能版コンパイラの mozaic 記述が残課題(§ROADMAP)。
```
