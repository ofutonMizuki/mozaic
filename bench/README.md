# mozaic ベンチマーク — ネイティブ C++ vs mozaic CPU vs GPU、UMA の効果

**どれも Apple Silicon 前提**。

| ベンチ | 何を測るか | 比較対象 |
|---|---|---|
| **`compare.sh`** | **多面ワンショット比較**(下の「総合比較」) | ネイティブ C++(手書き)/ mozaic CPU(並列)/ mozaic GPU(Metal)/ スカラ整数 / front-end 速度 |
| `run-mozaic.sh` | mozaic がコンパイルしたカーネルの CPU vs GPU(1 launch 時間) | mozaic(`bench/*.mzc`) |
| `bench.mm`(`run.sh`) | CPU / GPU-UMA(shared) / GPU-private(コピー有) = **UMA の効果** | 手書き MSL(mozaic の shared パスと同形) |
| `native.cpp` / `scalar_native.cpp` | `compare.sh` が使う**手書きネイティブ C++ の双子**(heavy/vadd/スカラ、真の f32) | — |

## 総合比較（Apple M4・10 スレッド、`sh bench/compare.sh` 実測）

| ワークロード | ネイティブ C++ | mozaic CPU | mozaic GPU | 備考 |
|---|---|---|---|---|
| **heavy**(計算律速 f32, 1M×256) | 33,821 µs(並列) / 153,604(逐次) | **33,250 µs**(並列) | **1,402 µs** | mozaic CPU は手書き並列とほぼ同速。GPU は CPU 比 23.7× |
| **vadd**(メモリ律速 f32, 16M) | 2,194 µs | 2,637 µs | 2,286 µs | 全経路ほぼ同速(帯域律速)。GPU は僅差で勝ち |
| **scalar**(整数 LCG, 20M×40, release) | 20.5 ms/rep | **20.9 ms/rep** | — | **チェックサム一致**・1.02× = 検査付き算術は release でネイティブ同等(ゼロオーバヘッド) |

**f32 コード生成の修正(2026-06-03)**:従来 `f32` 変数 × `double` リテラル(`1.0000001`、`f` 接尾辞なし)が
式全体を `double` へ昇格させ、CPU で f32 演算を f64 で計算していた(精度も誤り・約 3 倍遅い)。
emit を「`f32`/`f16` の算術はオペランドを結果型へキャスト」するよう修正し、`heavy` の mozaic CPU が
**91,178 → 33,250 µs(2.9× 高速)** になり手書きネイティブ C++ 並列と同速に。ゴールデン 107/107・忠実性 64/64 とも不変。
(GPU/MSL 経路は元々ネイティブ float なので影響なし。mozc 自己ホスト側は型情報を持たないため f32 リテラルは従来どおり
double 昇格 — 128bit リテラルと同じ既知の subset 限界。)

`bench.mm` を手書きにしているのは、**private バッファ(discrete GPU 相当のコピー経路)が言語からは作れない**ため(mozaic の `Buffer.shared` は常に UMA)。UMA が省いているコストを定量化するには、敢えてコピーする経路と並べる必要がある。

---

## 1. mozaic コンパイル版(CPU vs GPU)

```sh
sh bench/run-mozaic.sh
```

`bench/heavy.mzc`(計算律速)と `bench/vadd.mzc`(メモリ律速)を **同じソースから CPU と `--gpu` の両方にビルド**し、1 launch あたりマイクロ秒を比較する。カーネル・`dev.launch`・`await`・ランタイムすべて mozaic の生成物。

計時は言語の `clock.now(): u64`(ナノ秒・単調時計)。各 rep の前に入力を 1 要素だけ撹乱し、出力をチェックサムに畳み込むことで、最適化器が「同一 launch の繰り返し」を畳み込めないようにしている。

**実測例(Apple M4)**
```
kernel  |       CPU (serial) |        GPU (Metal) | speedup
--------+--------------------+--------------------+--------
heavy   | CPU   642883.1  us | GPU      1143.4 us |   562.3x
vadd    | CPU     2103.1  us | GPU      2214.4 us |     0.9x
```

- **計算律速(heavy)**:GPU 圧勝(数百倍)。GPU の launch オーバーヘッドを償却できるだけの演算量があれば、データ並列は GPU の独擅場。
- **メモリ律速(vadd, 16M)**:ほぼ互角(~1x)。1 回の流し読み程度では、M4 の広い CPU メモリ帯域 + GPU の launch オーバーヘッドで相殺される。
- **(2026-06-03 修正済)** 以前は `heavy` の CPU が遅かった: **f32 リテラルが C++ の `double` で出力され二重昇格**
  していた(`1.0000001` に `f` 接尾辞なし → 手書き C++ 比で約 4 倍遅い)。emit を「f32/f16 算術はオペランドを結果型へ
  キャスト」するよう修正し、手書きネイティブ C++ と同速になった。上の「総合比較」を参照。

---

## 2. UMA 効果(CPU / GPU-UMA / GPU-private)

```sh
bench/run.sh                 # 既定スイープ(N = 2^16 .. 2^22)
bench/run.sh 23 26 7 128     # 引数: log2N_min log2N_max reps heavy_iters
```

3 経路を同条件で比較:

- **CPU** — 単一スレッド逐次(mozaic の CPU バックエンドと同じ)
- **GPU shared(UMA)** — `MTLStorageModeShared`。`buf.contents` を直接読み書き、**host↔device コピー無し**。mozaic の `--gpu` パスそのもの。
- **GPU private** — `MTLStorageModePrivate`。staging から blit で**コピーイン → dispatch → コピーアウト**。discrete GPU 相当。**この差分が UMA の節約分**。

**実測例(Apple M4, `bench/run.sh 23 26 7 128`)**
```
== vadd (memory-bound) ==
         N |   CPU ms | GPU-UMA ms | GPUpriv ms |  vs CPU | UMA win
  16777216 |    4.564 |      2.635 |     10.932 |    1.7x |   4.15x
  67108864 |    9.309 |      8.618 |     44.271 |    1.1x |   5.14x
== heavy (compute-bound) ==
  16777216 | 1152.256 |      6.472 |     11.690 |  178.0x |   1.81x
  67108864 | 4885.069 |     25.103 |     43.373 |  194.6x |   1.73x
```

- `vs CPU = CPU / GPU-UMA`(>1 で GPU が速い)
- `UMA win = GPUpriv / GPU-UMA`(>1 で「コピーを挟む discrete 流」がどれだけ損か)

**読み取り**
- **UMA の効果はメモリ律速/コピー多めのワークに集中**:`vadd` では private 経路が **4〜5 倍**遅い(N が大きいほどコピーバイト増で拡大)。`Buffer.shared` のゼロコピーがそのまま効く。
- **計算律速ではコピーは誤差**:`heavy` の UMA win は ~1.7x 止まり(演算時間が支配的で、コピーの有無は霞む)。
- **GPU offload の損益分岐**:`vadd` は小 N では GPU が負け(launch オーバーヘッド)、16M 付近で逆転。`heavy` は小さくても GPU が勝つ。

---

## まとめ

GPU が効くのは「**1 要素あたりの計算が重い**」か「**データが十分大きい**」とき。Apple Silicon の UMA は、**メモリ律速/転送が支配的なワークほど** discrete GPU に対する優位(コピー削減 4〜5x)が大きく、計算律速では差が出にくい。mozaic の `Buffer.shared` はこのゼロコピー経路を既定で踏んでいる。
