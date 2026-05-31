# mozaic

CPU と GPU を同格に扱う、速度優先のシステムプログラミング言語(設計・実装中)。

- 設計ドキュメント: [VISION.md](VISION.md) / [SPEC.md](SPEC.md)
- コンパイラ実装: TypeScript(Node がネイティブに実行、ビルド不要)
- 変換ターゲット: C++(最初) → 将来 WASM / JS

## M0(現状)

ホストのみの最小縦割り: `mozaic → C++ → ネイティブ実行`。標準入出力のみ。
対応構文: `function main`、`for (const x of stdin.lines())`、`if` / `==` / `!=`、`stdout.println(...)`、`return` / `break` / `continue`。
文字列はランタイムで **内部 UTF-32 / 入出力 UTF-8 変換**。

## 必要なもの

Node 23.6+(TypeScript 直接実行)と C++ コンパイラ(g++ または clang++)。npm install は不要。

## 使い方

```sh
node src/main.ts emit  examples/echo.mzc   # 生成された C++ を表示
node src/main.ts build examples/echo.mzc   # build/echo を生成
node src/main.ts run   examples/echo.mzc   # ビルドして実行
```

例:

```sh
printf 'hello\nこんにちは\nquit\nignored\n' | ./build/echo
# => hello / こんにちは を出力し、quit で終了(ignored は出ない)
```
