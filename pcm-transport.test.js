/**
 * pcm-transport.test.js - PCMトランスポート(振幅・極性マンチェスター)ロジック検証
 *
 * 実行: node web/pcm-transport.test.js
 *
 * worklet 2ファイル(pcm-encoder-worklet.js / pcm-decoder-worklet.js)は
 * AudioWorkletProcessor 依存でそのままrequireできないため、グローバルに
 * ダミーの基底クラスと registerProcessor を用意してから読み込み、
 * クラス本体(TX buildSamples / RX processSample)をテストする。
 *
 * 検証:
 *  - TX -> (理想サンプル) -> RX でペイロード一致
 *  - リサンプル模擬(最近傍で間引き/水増し + 振幅なまり)でも一致
 *  - firmware(pcm_transport.c)と同一アルゴリズムのミラーである前提の健全性確認
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// --- worklet を評価するためのサンドボックス ---
function loadWorklet(file) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const captured = {};
    const sandbox = {
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
        registerProcessor: (name, cls) => { captured[name] = cls; },
        sampleRate: 48000,
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: file });
    return captured;
}

const enc = loadWorklet('pcm-encoder-worklet.js');
const dec = loadWorklet('pcm-decoder-worklet.js');
const Encoder = enc['pcm-encoder-processor'];
const Decoder = dec['pcm-decoder-processor'];

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) pass++; else { fail++; console.log('  FAIL: ' + msg); } }

// エンコーダで frame(生ペイロード) -> Float32サンプル列
function encodeFrame(payload) {
    const e = new Encoder();
    return e.buildSamples(payload); // Float32Array
}

// デコーダにサンプル列を流し、最初に確定した frame ペイロードを返す（なければ null）
function decodeSamples(floatSamples) {
    const d = new Decoder();
    let result = null;
    d.port.postMessage = (msg) => {
        if (msg && msg.type === 'frame' && result === null) {
            result = Array.from(msg.payload);
        }
    };
    for (let i = 0; i < floatSamples.length; i++) {
        d.processSample(floatSamples[i]);
    }
    return result;
}

// リサンプル模擬: 線形補間で factor 刻み再サンプリング + gain。
// さらに実機の再生経路が持つローパス（急峻な極性反転のなまり）を1次IIRで模擬。
// alpha が大きいほどなまりが強い（実機に近い）。
function resample(floatSamples, factor, gain, lpAlpha) {
    const out = [];
    let pos = 0;
    const n = floatSamples.length;
    while (true) {
        const i0 = Math.floor(pos);
        if (i0 >= n) break;
        const i1 = Math.min(i0 + 1, n - 1);
        const frac = pos - i0;
        // 線形補間
        let v = (floatSamples[i0] * (1 - frac) + floatSamples[i1] * frac) * gain;
        if (v > 1) v = 1; if (v < -1) v = -1;
        out.push(v);
        pos += factor;
    }
    // 1次ローパス（前方向）。alpha=0で無効。
    const a = lpAlpha || 0;
    if (a > 0) {
        let y = 0;
        for (let i = 0; i < out.length; i++) {
            y = y + a * (out[i] - y);
            out[i] = y;
        }
    }
    return out;
}

function roundtrip(payload, factor, gain) {
    const samples = encodeFrame(payload);
    const rs = resample(samples, factor, gain);
    const got = decodeSamples(rs);
    if (!got) return false;
    if (got.length !== payload.length) return false;
    for (let i = 0; i < payload.length; i++) if (got[i] !== payload[i]) return false;
    return true;
}

// 連続ストリーム模擬: 前置き無音 + [フレーム + 無音ギャップ] × N を1本のDecoderに流し、
// 少なくとも1つのフレームが payload と一致するか。実機のフレーム間ギャップ/連続受信を再現。
function roundtripStream(payload, factor, gain, leadSilence, gap, repeats) {
    const one = encodeFrame(payload);
    const stream = [];
    for (let k = 0; k < (leadSilence || 0); k++) stream.push(0);
    for (let r = 0; r < (repeats || 1); r++) {
        // 各フレームは同じ内容だが Seq が進むので毎回エンコードし直す
        const f = encodeFrame(payload);
        for (let i = 0; i < f.length; i++) stream.push(f[i]);
        for (let k = 0; k < (gap || 0); k++) stream.push(0);
    }
    const rs = resample(stream, factor, gain);
    // 全フレームを集める
    const d = new Decoder();
    let matched = 0, total = 0;
    d.port.postMessage = (msg) => {
        if (msg && msg.type === 'frame') {
            total++;
            const p = Array.from(msg.payload);
            if (p.length === payload.length && p.every((v, i) => v === payload[i])) matched++;
        }
    };
    for (let i = 0; i < rs.length; i++) d.processSample(rs[i]);
    return { matched, total };
}

console.log('=== pcm-transport tests ===');

// 1) 理想ラウンドトリップ
check(roundtrip([0x01, 0x50, 0x3C, 0x00], 1.0, 1.0), 'ideal 4B game packet');
check(roundtrip([0xAA, 0x55, 0xFF, 0x00, 0x12, 0x34], 1.0, 1.0), 'ideal 6B');
check(roundtrip([0x00, 0xFF, 0x0F, 0xF0, 0xAA, 0x55, 0x80, 0x01], 1.0, 1.0), 'ideal bit patterns');

// 2) 振幅なまり
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 1.0, 0.985), 'amplitude droop 0.985');
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 1.0, 0.90), 'amplitude droop 0.90');

// 3) 軽いリサンプル
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 1.02, 0.99), 'resample 1.02');
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 0.98, 0.99), 'resample 0.98');
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 1.05, 0.98), 'resample 1.05');
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 0.95, 0.98), 'resample 0.95');
// より厳しめ（44.1k/48k = 0.91875 相当や逆方向）
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 0.9188, 0.97), 'resample 44.1/48');
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 1.0884, 0.97), 'resample 48/44.1');
// 長めのペイロード（累積ドリフト耐性）
check(roundtrip([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 0.96, 0.98), 'resample long 16B');
check(roundtrip([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], 1.04, 0.98), 'resample long 16B up');
// さらに過酷: 大きめのレート差・ジッタ相当（最近傍なのでジッタも含む）
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 0.88, 0.95), 'resample 0.88 harsh');
check(roundtrip([0x01, 0x50, 0x3C, 0x2A], 1.13, 0.95), 'resample 1.13 harsh');
// 全ゲームパケットっぽい値をいくつか
check(roundtrip([0x08, 0x9F, 0x03, 0xFE], 1.0, 1.0), 'game pkt gameover');
check(roundtrip([0x04, 0x00, 0x00, 0x7F], 0.94, 0.97), 'game pkt cfire resample');

// --- 連続ストリーム（実機再現）: 前置き無音 + 複数フレーム + ギャップ ---
{
    const r = roundtripStream([0x01, 0x50, 0x3C, 0x2A], 1.0, 1.0, 100, 100, 5);
    check(r.matched >= 4, 'stream ideal: matched ' + r.matched + '/' + r.total);
}
{
    const r = roundtripStream([0x01, 0x50, 0x3C, 0x2A], 0.97, 0.98, 137, 60, 5);
    check(r.matched >= 4, 'stream resample0.97: matched ' + r.matched + '/' + r.total);
}
{
    const r = roundtripStream([0x01, 0x50, 0x3C, 0x2A], 1.03, 0.98, 55, 200, 5);
    check(r.matched >= 4, 'stream resample1.03: matched ' + r.matched + '/' + r.total);
}
// ギャップ無し（フレーム連続）も
{
    const r = roundtripStream([0x08, 0x12, 0x34, 0x56], 1.0, 1.0, 0, 0, 4);
    check(r.matched >= 3, 'stream no-gap: matched ' + r.matched + '/' + r.total);
}

// --- ローパス（実機の再生経路のなまり）を加えた過酷ケース ---
function roundtripLP(payload, factor, gain, lpAlpha) {
    const samples = encodeFrame(payload);
    const rs = resample(samples, factor, gain, lpAlpha);
    const got = decodeSamples(rs);
    if (!got) return false;
    if (got.length !== payload.length) return false;
    return got.every((v, i) => v === payload[i]);
}
check(roundtripLP([0x01, 0x50, 0x3C, 0x2A], 1.0, 1.0, 0.5), 'lowpass a0.5');
check(roundtripLP([0x01, 0x50, 0x3C, 0x2A], 1.0, 1.0, 0.35), 'lowpass a0.35');
check(roundtripLP([0x01, 0x50, 0x3C, 0x2A], 0.97, 0.98, 0.4), 'lowpass a0.4 + resample');
check(roundtripLP([0x01, 0x50, 0x3C, 0x2A], 1.03, 0.98, 0.4), 'lowpass a0.4 + resample up');

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
