# FSK Modem - ブラウザ側

USB Type-C 玩具通信 PoC のブラウザ側実装。Web Audio API + AudioWorklet で FSK 音響モデムを実現。

## ファイル構成

| ファイル | 用途 |
|---------|------|
| `paint.html` | おえかき通信UI（メイン） |
| `paint.js` | 画像エンコード/デコード、FSK送受信制御 |
| `fsk-encoder-worklet.js` | FSK変調 AudioWorklet (TX) |
| `fsk-decoder-worklet.js` | FSK復調 AudioWorklet (RX, Goertzel) |
| `index.html` | テキスト通信UI（初期テスト用） |
| `fsk-modem.js` | テキスト通信ロジック |
| `loopback-test.html` | ループバックテスト |

## 起動方法

AudioWorklet は HTTPS またはlocalhost でのみ動作するため、ローカルサーバーが必要:

```bash
# Node.js
npx serve web

# Python
cd web && python -m http.server 8000
```

ブラウザで `http://localhost:8000/paint.html` を開く。

## 使い方（おえかき通信）

1. CoreS3をUSBケーブルで接続（UAC デバイスとして認識される）
2. Audio Output ドロップダウンで UAC スピーカーデバイスを選択
3. 🎤 Connect をクリック（マイク権限を許可）
4. 左側キャンバスにおえかき（8色パレットから選択）
5. 📤 Send で CoreS3 に送信
6. CoreS3 からの画像は右側「受信画像」に表示

## 通信仕様

- FSK: Mark=1200Hz, Space=2400Hz, 2400baud
- サンプリング: 48kHz, 16bit, モノラル
- フレーム: `[0xAA][0xAA][0x7E][Len][Data][CRC-H][CRC-L]`
- 画像: 32×32, 8色, 3bit/pixel = 384バイト → 2フレーム
- ACK: ESP32がチャンク受信時に `[0x06][seq]` を返送
- リトライ: ACK未受信で最大5回再送

## デコーダー設計

24ビットスライディングシフトレジスタによるビットレベル同期検出。バイト境界に依存せず `0xAAAA7E` パターンを任意のビットオフセットで検出可能。これにより：
- フレーム間の無音で Goertzel ウィンドウがズレても次フレームを確実に検出
- 連続フレーム受信（奇数/偶数問わず）が安定動作

## 対応ブラウザ

- Chrome (デスクトップ/Android) ✅
- Safari (iOS) — getUserMedia + AudioWorklet 対応（iOS 14.5+）
- Firefox — AudioWorklet対応（setSinkId未対応の場合あり）

## 注意事項

- `setSinkId()` でUACスピーカーを選択する必要がある（デフォルト出力がPCスピーカーの場合）
- iOS Safari では AudioContext 生成にユーザージェスチャが必要
- echoCancellation, noiseSuppression, autoGainControl は全て無効化が必須
