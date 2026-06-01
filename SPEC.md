# mozaic Language Specification — v0.1 (sketch)

ステータス:**草案**。[VISION.md](VISION.md) の方針を具体構文へ落としたもの。M0–M2 を実装できる範囲を対象とし、
未確定箇所は §8 に TBD として明記する。構文は実装(M0)で確定する。

> **実装状況(M2 完了、branch `m2-language-core`)**: §1–§2 の `char`+文字リテラル / `as`・`as?` /
> `T?`(`some`/`none`/`??`/後置 `?`)/ `Result<T,E>`(`Ok`/`Err`/後置 `?`/`isOk`/`isErr`/`unwrap`/`unwrapErr`)/
> 固定長配列 `[T;N]` / スライス `[]T`(`slice(arr)`)/ `str`・`String`(`.len`/`+`/`[i]`/`format`)/
> テンプレート文字列 `` `…${e}…` `` / `defer` / `abort`・`assert` は**実装済み**。
> 未実装(§8 TBD / 後続 M): `i128`/`u128`/`f16`、ベクタ型 `f32x4` 等、`comptime`、ユーザ総称型、
> 可変 `String` 構築 API、配列/スライスの境界検査、単項マイナス、`Result` コンビネータ。

## 0. 設計原則(要約)

- 静的型付け。**暗黙の型変換はいかなる場合も無い**。
- GC 無し / 隠れた確保無し / 値型中心 / 線形メモリ。
- 所有権と借用。**借用が CPU/GPU 同期を兼ねる**。
- TypeScript 風の構文を出発点に、目的に資するなら他言語の構文を採る。

## 1. 字句 (Lexical)

- コメント:`// 行` と `/* ブロック */`(ネスト可)。
- 識別子:`[A-Za-z_][A-Za-z0-9_]*`。
- キーワード(暫定):`function const let struct enum kernel scope spawn match if else for while of return break continue defer as comptime self true false none some import`
- リテラル:
  - 整数:`42`, `0xFF`, `0b1010`, `1_000`。接尾辞で型固定:`42u8`, `100i64`。
  - 浮動:`1.5`, `1e9`, `3.0f32`。
  - 真偽:`true` / `false`。
  - 文字:`'a'`, `'\n'`, `'あ'` — 型 `char`(**UTF-32**:1 コードポイント = 32 ビット)。
  - 文字列:`"..."`(型 `str`)、テンプレート `` `...${e}...` ``(型 `String`、補間 `${e}` は各値の `format` を呼ぶ)。
- **リテラル型付け**(フォーク決定):整数/浮動リテラルは「未確定型」で生まれ、文脈の期待型を取る
  (これは*変換ではない*)。制約が無ければ既定で整数=`i32`、浮動=`f64`。

## 2. 型 (Types)

| 分類 | 例 |
|---|---|
| スカラ | `i8 i16 i32 i64 i128` / `u8 u16 u32 u64 u128` / `f16 f32 f64` / `bool` / `char` |
| ベクタ | `f32x4`, `i16x8`, `u64x2`(`<スカラ>x<レーン数>`) |
| 構造体 | `struct`(値型) |
| 直和 | `enum`(ペイロード可) |
| 固定長配列 | `[T; N]`(`N` は comptime) |
| スライス | `[]T`(長さ付き view) |
| 文字列 | `str`(不変 UTF-32 view、≈ `[]char`)/ `String`(所有・可変 UTF-32) |
| バッファ | `Buffer<T>`(デバイス常駐) |
| 参照 | `&T`(共有) / `&mut T`(排他) |
| オプショナル | `T?`(`null` 無し) |
| 関数 | `function(A, B): R` |

戻り型を省略した関数は値を返さない(ユニット)。

### 文字 / 文字列 (char & Strings)

**内部表現は UTF-32**(1 コードポイント = `char` = 32 ビット固定幅)。線形メモリ上に `char` の列として持つ(**現状の変換ターゲットは C++**。線形メモリ上で一様なので、将来 WASM/JS へ移植してもこの表現は崩れない)。文字列は実質 `char` の列で、**`str` ≈ `[]char`**。所有権に合わせて 2 型:

- **`str`** — 不変な UTF-32 **view**(ptr + コードポイント数)。所有しない借用で、生存期間は所有者に縛られる
  (文面は §8 TBD、当面レキシカル推論)。文字列リテラル `"..."` は `str`。
- **`String`** — 所有・可変・伸長可能な UTF-32 バッファ(`char` の伸長列。ヒープ確保、スコープ終了で解放)。
  `String.new()` / `s.push(c: char)` / `s.pushStr(v: str)` / `a + b`(新 `String`)/ テンプレート。

固定幅ゆえの利点と規則:

- `String` → `str` は**明示** `s.view(): str`(暗黙変換は無い)。
- バイト列からの構築は UTF-8 検査つき → `Result`:`String.fromUtf8(bytes: []u8): Result<String, Utf8Error>`。生バイトは `[]u8` で扱う。
- **`s[i]: char` は O(1) で可**(UTF-32 固定幅、中間バイト事故が無い)。`s.len` は**コードポイント数**。`s.chars()`(`char` 反復)/ `s.split(sep)` / 連結 `+`。生バイトは `s.bytes(): []u8`(len×4、エンディアン注意)。
- `char` も文字列も **UTF-32**。`char`↔`u32` は明示キャスト(`c as u32` / `u32 as? char`)。
- **入出力は UTF-8 境界**:外界(stdin/stdout)は UTF-8。ランタイムが境界で変換 ── 読込 UTF-8→UTF-32(不正 UTF-8 は検査 → `Result`)、書出 UTF-32→UTF-8。内部は常に UTF-32。
- `String` はホスト層専用(所有ヒープ型)。カーネルは文字列ではなくバイトバッファを扱う。

> 代償:1 文字 4 バイト固定(ASCII 主体で UTF-8 比 4 倍のメモリ)。見返りに固定幅の単純さ・O(1) 添字・復号不要を得る。

```typescript
function greet(name: str): String {
  return `hello, ${name}!`;          // String を確保して返す
}

function countDigits(s: str): u32 {
  let n: u32 = 0;
  for (let c of s.chars()) {
    if (c >= '0' && c <= '9') { n = n + 1; }   // char 同士の比較
  }
  return n;
}
```

## 3. 宣言 (Declarations)

```typescript
// 関数
function add(a: i32, b: i32): i32 { return a + b; }

// 束縛: const=不変 / let=可変(再代入可)。&mut 借用は let 束縛にのみ可。
const PI: f32 = 3.1415927;
let count: i32 = 0;

// 構造体 + メソッド(受け手は self の借用形で明示)
struct Vec2 {
  x: f32;
  y: f32;
  function len2(&self): f32 { return self.x * self.x + self.y * self.y; }
  function scale(&mut self, k: f32) { self.x = self.x * k; self.y = self.y * k; }
}

// 直和 + 網羅 match
enum Shape {
  Circle(f32),
  Rect { w: f32, h: f32 },
  Empty,
}
function area(s: &Shape): f32 {
  match s {
    Circle(r)     => return 3.1415927f32 * r * r,
    Rect { w, h } => return w * h,
    Empty         => return 0.0,
  }
}

// コンパイル時定数 / 計算
const TABLE: [f32; 256] = comptime buildTable();
```

## 4. 文と式 (Statements & Expressions)

- 文:`let`/`const`、式文、`return`、`if`、`match`、`for … of`、`while`、`defer { }`、`break`、`continue`。
- `if (cond)` / `while (cond)` の `cond` は **`bool` 必須**(truthy/falsy 無し)。
- 演算子:算術 `+ - * / %`、ビット `& | ^ ~ << >>`、比較 `== != < <= > >=`、論理 `&& || !`(オペランドは `bool`)。
- 二項演算は**両辺が同型**(未確定リテラルは相手側へ適合)。`u8 + i32` はエラー。
- オプショナル / 失敗伝播:`some(v)` / `none`、`a ?? b`(既定値)。後置 `?` は `T?` と `Result` の両方の失敗を持ち上げる(→ エラー処理)。
- `defer { … }` はスコープ終了時に実行(後始末)。

### 数値オーバーフロー (Integer Overflow)

整数演算のみが対象(浮動小数は IEEE-754:`inf` / `NaN` を生む)。

- **既定 `+ - *`・シフト等**:debug ビルドは**トラップ(`abort`)**、release ビルドは**ラップ(2 の補数)**。
  → バグは開発時に捕まえ、本番は分岐なしで速い(Rust と同方針)。
- **明示演算子**(ビルドに依らず確定。Zig 流):
  - ラップ:`a +% b` / `a -% b` / `a *% b`
  - 飽和:`a +| b` / `a -| b` / `a *| b`(型の min/max でクランプ)
- **検査付き**:`a.checkedAdd(b): T?` 等 → 溢れたら `none`(エラー処理と一貫)。
- `/` `%` のゼロ除算、および `MIN / -1` は**両ビルドでトラップ**。`a.checkedDiv(b): T?` で回避。
- 対称性:キャストの `as`(切り捨て ≒ ラップ)と `as?`(検査 = `none`)は、この `+%`(ラップ)と `checked`(検査)に対応する。

> バックエンド注意(現状ターゲット = C++):C++ は符号付き溢れが UB なので定義済み挙動になるコードを吐く(ラップは符号なし経由、トラップは `__builtin_*_overflow`)。
>
> 将来ターゲットでの留意点(当面未実装):WASM は整数演算が元々ラップなので release が自然。JS は ≤32bit はビット演算で済むが、**64bit 整数は BigInt か 2×32bit 模倣**でコスト高(JS が速度面で最弱な所以)。

### キャスト(明示変換)

| 構文 | 意味 |
|---|---|
| `e as T` | 明示変換。整数の縮小は切り捨て(ラップ)、浮動は丸め。 |
| `e as? T` | 検査付き変換 → `T?`。範囲外/精度損失なら `none`。 |
| `vN.splat(s)` | スカラ→ベクタは明示(暗黙ブロードキャスト無し)。例:`v * f32x4.splat(2.0)` |

```typescript
let a: i32 = readN();
let b: i64 = a as i64;        // 拡大も明示
let s: i16? = a as? i16;      // 範囲外なら none
```

### エラー処理 (Error Handling)

例外は持たない(隠れた制御フロー無し)。エラーは2系統に分ける。

**回復可能** — `Result<T, E>`(組込み:`enum Result<T, E> { Ok(T), Err(E) }`)。
- 生成:`Ok(v)` / `Err(e)`。`E` は通常ペイロード付き `enum`。
- 伝播:後置 `?`。`Err(e)` なら即 `return Err(e)`、`Ok(v)` なら `v` を取り出す。
  同じ `?` は `T?` にも効く(`none` を伝播)。`?` が唯一の「失敗を持ち上げる」演算子。
- **暗黙のエラー変換は無い**(規則どおり。Rust の `From` 自動変換は採らない)。
  エラー型を変えるなら `expr.map_err(toMyErr)?` と明示する。
- 処理:`match`、または `.unwrap()` / `.expect(msg)` / `.unwrap_or(d)` / `.ok(): T?` / `.map(f)` / `.map_err(f)`。

```typescript
enum MathError { DivByZero, Overflow }

function checkedDiv(a: i32, b: i32): Result<i32, MathError> {
  if (b == 0) return Err(DivByZero);
  return Ok(a / b);
}

function ratioSum(xs: &[]i32, d: i32): Result<i32, MathError> {
  let total: i32 = 0;
  for (let x of xs) {
    total = total + checkedDiv(x, d)?;   // Err なら即この関数から Err を返す
  }
  return Ok(total);
}
```

**回復不能** — `abort(msg)` / 失敗した `assert(cond)` / 添字範囲外(debug ビルド)。
- 即終了(診断は stderr)。**スタック巻き戻しは無い** → `abort` 時 `defer`・デストラクタは走らない(速度と C++/WASM/JS 一様化のため)。
- 対して `?` の早期 return は*通常の return* なので `defer` は走る。
- `.unwrap()` / `.expect()` が `Err` / `none` に当たると `abort`。

`function main()` は値なし、または `Result<(), E>` を返せる(後者なら本体で `?` を使える)。

## 5. 所有権と借用 (Ownership & Borrowing)

- 各値の所有者は1つ。値渡し/代入はムーブ(スカラ等の小さな `Copy` 型はコピー)。
- `&T` 共有借用(複数可)/ `&mut T` 排他借用(同時に1つ)。借用は所有者より長生きできない。
- 所有者はスコープ終了で解放。`defer` で明示的後始末。
- v0.1 は**レキシカルな借用検査**から始める(高度な生存期間注釈は §8 TBD)。
- **実装状況(v0.1、借用チェッカを段階確定)**:
  - **所有権/ムーブ**:再束縛(`let q = p` / `p = q`)で**ムーブ + use-after-move 検査**。`Copy` = スカラ/`bool`、それ以外(`str`/`Buffer<T>`/`struct`/ペイロード付き `enum`/`Atomic`)はムーブ。`Atomic` はムーブ不可。
  - **一級参照 `&T`/`&mut T`**:関数引数・メソッド受け手(`&self`/`&mut self`)で使える。自動デリファレンス。`&mut` は `let` 可変束縛のみ。共有参照越し / 不変束縛へのフィールド代入は不可。
  - **別名規則**:1 つの呼び出しの引数で、ある変数を `&mut` と他(`&`/`&mut`)に同時借用するのは不可(`&` 複数は可)。デバイス/タスクの borrow=sync(launch/spawn が `await`/`join` まで借用保持)が文をまたぐ借用を担う。
  - **生存期間/escape**:参照を返す関数(`: &T`)は、**引数由来の参照のみ返せる**(`return &local` は dangling になるため拒否、単一引数 provenance)。格納可能な参照ローカル `let r = &x` も可(引数由来かを追跡)。レキシカル領域推論で、明示 lifetime 注釈は不要。
  - 後続(§8 TBD):格納参照の文跨ぎ別名(借用中の変更/ムーブ禁止)・NLL(最終使用での解放)・disjoint-field 借用・明示 lifetime 注釈・多引数 lifetime 関係。

### 並行性(スレッド)— 初めから一級

マルチスレッドは初期からの一級機能。**所有権・借用がそのままスレッド間データ競合をコンパイル時に防ぐ**
(デバイス借用と同じ仕組み)。並行な仕事は「完了まで借用を保持し、合流点が同期境界」で統一される:

| 形態 | 構文 | 合流(借用返却) |
|---|---|---|
| データ並列 | `dev.launch(k, …)` → `Job` | `job.await()` |
| タスク並列 | `scope { spawn f(…); }` → `Task` | `task.join()` / scope 終端 |

データ並列は**カーネル層がそのまま担う**(`Device.cpu` への launch = CPU ワーカープール実行、GPU と同格)。
タスク並列は構造化並行で表す:

```typescript
scope {
  spawn process(&input, &mut left,  0,   mid);   // &mut left を借用
  spawn process(&input, &mut right, mid, n);     // &mut right を借用
}   // 両タスクはここで join。借用も返る(&input は共有借用なので両方が持てる)

let h = spawn compute(&data);   // 結果付きタスク
let r = h.join();               // 早期に合流して結果取得
```

- `spawn f(args…)` は `launch` と同形(クロージャ不要、関数 + 引数)。**v0.1 実装範囲**:`scope { spawn f(…); }`(終端で全 join)と `let t: Task = spawn f(…); t.join();`(named)。`join` は値を返さない(結果返しは §8 TBD)。
- 共有可変状態:**`Atomic<T>` は確定済み(下記「Atomic<T>」)**。`Mutex<T>` / `Channel<T>` / スレッドをまたぐ共有所有 `Arc<T>` は §8 TBD。
- 安全性:`&mut` を持てるスレッドは同時に1つ、という借用規則が競合を封じる。`&` 共有はスレッド安全な型に限る(`Sync` 相当・自動判定)。**`Atomic<T>` はこの `Sync` な型**であり、`&Atomic<T>` は複数スレッドが同時に持て、**`&` 共有のまま書き込める唯一の例外**。
- バックエンド(現状ターゲット = C++):`std::thread` / atomics。
  > 将来ターゲット(当面未実装):WASM=スレッド+共有線形メモリ+atomics、JS=`SharedArrayBuffer`(線形メモリ全体)+Web Workers+`Atomics`(要 cross-origin isolation)。線形メモリ採用ゆえ、将来も3者に一様に乗る。

### Atomic\<T\> — ロックフリー共有セル(確定)

通常メモリのデータ競合はコンパイル時に禁止される(§0)。`Atomic<T>` は、メモリ安全(UB・torn read 無し)を保ったまま **データ競合自由だけ**を狭く外す唯一の口(例:Lazy SMP 並列探索の置換表を無同期で共有更新)。各アクセスはハードウェアの不可分命令なので、読めるのは常にその幅の妥当な値。失われ得るのは「上書きで消えた書き込み」だけ ── 呼び出し側が許容する論理。

- **型**:`Atomic<T>`、`T` は word サイズ整数 **`u32` / `i32` / `u64` / `i64`** のみ(他はコンパイルエラー)。**非 Copy・非ムーブ**で、束縛・構造体フィールド・`Buffer` 要素としてその場に固定される。共有はすべて `&Atomic<T>` 経由で、セル中身への `&T` / `&mut T` は取得不可(触り方は下記メソッドのみ)。
- **生成**:`Atomic.new(v: T): Atomic<T>`(`Buffer.shared` と同じ生成スタイル)。`Buffer<Atomic<T>>` も作れる(**ホスト/CPU のみ**。GPU/Metal では不可)。
- **操作**(すべて `&Atomic<T>` レシーバ。通常の代入・読み出し構文では触れない):

| 操作 | 意味 |
|---|---|
| `load(order): T` | 読み出し |
| `store(value: T, order)` | 書き込み |
| `fetchAdd(value: T, order): T` | 加算して **旧値** を返す |
| `compareExchange(expected: T, desired: T, success, failure): bool` | 現在値が `expected` なら `desired` を書いて `true`、違えば `false` |

- **メモリ順序** `Ordering`:`Relaxed` / `Acquire` / `Release` / `AcqRel`(**SeqCst は持たない**)。**既定値なし・呼び出しごとに明示必須**(§0「暗黙変換は無い」と一貫)。整合性検査:`load` に `Release`/`AcqRel` 不可、`store` に `Acquire`/`AcqRel` 不可、`compareExchange` の `failure` に `Release`/`AcqRel` 不可。order 引数はリテラルの `Ordering` 値のみ。
- **層**:ホスト層(CPU)専用。カーネル内 `Atomic` は不可(§6・§7)。バックエンド:C++ `std::atomic<T>` / `std::memory_order_*`。

```typescript
function worker(c: Atomic<u32>, iters: u32) {
  let i: u32 = 0;
  while (i < iters) { c.fetchAdd(1, Relaxed); i = i + 1; }   // & 共有のまま書ける(Sync)
}
function main() {
  let counter: Atomic<u32> = Atomic.new(0);
  scope {
    spawn worker(&counter, 100000);
    spawn worker(&counter, 100000);
  }                                          // 終端で全 join、借用返却
  stdout.println(counter.load(Relaxed));     // 200000(競合下でも決定的)
}
```

> `fetchAdd` は読み書き一体なので、論理的競合があっても合計は決定的になる。これが「データ競合自由を狭く外す」の意味。

## 6. デバイスとカーネル (Devices & Kernels)

```typescript
const dev: Device = Device.gpu.first() ?? Device.cpu;

kernel scale(input: Buffer<f32>, output: Buffer<f32>, k: f32) {
  let i: u32 = grid.x;
  if (i < output.len) { output[i] = input[i] * k; }
}

let input:  Buffer<f32> = Buffer.shared(N);
let output: Buffer<f32> = Buffer.shared(N);
const job = dev.launch(scale, N, &input, &mut output, 2.0);   // grid は整数 / grid2(w,h) / grid3(w,h,d)
job.await();          // 借用返却。UMA=フェンスのみ / discrete=コピーバック
```

- **デバイス借用 = 同期**:`launch` は引数バッファを借用し、`Job` が保持する。
  `await` 前に `&mut` 借用中のバッファへ触れると**コンパイルエラー**。
- **バッファ常駐**:`Buffer.shared<T>`(UMA でゼロコピー)/ `Buffer.device<T>`(GPU 専有)。
- **カーネル組込み**:`grid.{x,y,z}`、`local.{x,y,z}`、`barrier()`、ワークグループ共有 `shared [T; N]`。

> 本節は **UMA(ユニファイドメモリ)を持つデバイス**を前提に、実装非依存の言葉で書く。UMA は特定ハードの機能ではなく業界が向かう方向であり、特定の GPU API 名は仕様本文に焼き込まない。**現状の GPU バックエンドは Apple Silicon/Metal のみ**だが、将来 統合 GPU・APU・CPU-GPU コヒーレント構成などへ拡張しうる。`discrete=コピーバック` は**非 UMA デバイス向けの将来の振る舞い規定**(当面未実装)。
- **カーネル部分集合**:
  - 許可:スカラ/ベクタ演算、`struct`、固定長配列、分岐、有界ループ、`Buffer` 添字。
  - 禁止:再帰・動的確保・クロージャ・ホストデータ参照・I/O・所有ヒープ型・**`Atomic` / 共有可変状態**(GPU アトミックは TBD。将来 UMA バックエンドごとに atomic 命令の写し方が変わりうる)。

## 7. 文法 (EBNF, 抜粋)

```ebnf
Program    = { Item } ;
Item       = FnDecl | StructDecl | EnumDecl | KernelDecl | ConstDecl ;

FnDecl     = "function" Ident "(" [ Params ] ")" [ ":" Type ] Block ;
Params     = Param { "," Param } ;
Param      = Ident ":" Type ;

StructDecl = "struct" Ident "{" { Field } { Method } "}" ;
Field      = Ident ":" Type ";" ;
Method     = "function" Ident "(" [ Recv [ "," Params ] ] ")" [ ":" Type ] Block ;
Recv       = "self" | "&self" | "&mut self" ;

EnumDecl   = "enum" Ident "{" { Variant "," } "}" ;
Variant    = Ident [ "(" Type { "," Type } ")" | "{" Field { Field } "}" ] ;

KernelDecl = "kernel" Ident "(" [ Params ] ")" Block ;
ConstDecl  = "const" Ident ":" Type "=" Expr ";" ;

Block      = "{" { Stmt } "}" ;
Stmt       = ( "let" | "const" ) Ident [ ":" Type ] "=" Expr ";"
           | "return" [ Expr ] ";"
           | "if" "(" Expr ")" Block [ "else" ( Block | IfStmt ) ]
           | "match" Expr "{" { Pattern "=>" ( Expr "," | Block ) } "}"
           | "for" "(" "let" Ident "of" Expr ")" Block
           | "while" "(" Expr ")" Block
           | "defer" Block
           | "break" ";" | "continue" ";"
           | "scope" Block
           | "spawn" Expr ";"
           | Expr ";" ;

Type       = Scalar | Vector | Ident [ "<" Type { "," Type } ">" ]
           | "[" Type ";" Expr "]" | "[" "]" Type
           | "&" Type | "&mut" Type | Type "?" ;
Vector     = Scalar "x" Int ;

Expr       = (* 優先順位つき二項/単項、as / as? キャスト、呼び出し、添字、
                フィールド/メソッド、リテラル、`spawn` 前置(関数呼び出し→`Task`。
                `let t: Task = spawn f(…)` で束縛可)。クロージャは無し *) ;
```

## 8. 未確定 (TBD)

- 生存期間注釈の文面、借用検査の完全形。
- モジュール / `import` の解決規則とコンパイル単位。
- `Job` の依存関係・複数同時起動 API。
- 並行性:`Sync` / `Send` 相当の表面構文、`Arc` / `Channel` / `Mutex` の API 詳細、`Atomic` の `SeqCst` と結果返し `join`、カーネル内 atomic。(`Atomic<T>` のメモリ順序と基本 API・`scope`/`spawn`/`join` の最小実装は §5 で確定済み。)
- 将来構想(実装予定ではなく方向性):他の UMA ハードウェアへのバックエンド拡張、discrete GPU(非 UMA・コピーバック経路)の実装、WASM / JS ターゲットの実装。
