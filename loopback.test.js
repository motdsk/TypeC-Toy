/**
 * loopback.test.js - PCM搬送 × ゲーム状態同期の統合ループバックテスト。
 *
 * 実行: node web/loopback.test.js
 *
 * 目的:
 *   実機/ブラウザ/実オーディオを使わず、1プロセス内で
 *     ゲームA が送信するパケット
 *       → encoder worklet でPCMサンプル列に変換
 *       → (任意でリサンプル/なまりを模擬)
 *       → decoder worklet でペイロードに復元
 *       → ゲームB の gameOnRx に投入
 *   という「完全な往復」を回し、状態同期(位置/発射/HP)が正しく伝わるか検証する。
 *
 *   これにより、復調ロジック・パケット仕様・ゲーム状態同期を、Kiro が実機なしで
 *   自動回帰検証できる。※実機経路のリサンプル/なまり耐性そのものは
 *   pcm-transport.test.js のモデルで別途カバー。ここは「仕様の往復整合」を見る。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorklet(file) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const captured = {};
    const sandbox = {
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
        registerProcessor: (name, cls) => { captured[name] = cls; },
        sampleRate: 48000, console,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: file });
    return captured;
}

const Encoder = loadWorklet('pcm-encoder-worklet.js')['pcm-encoder-processor'];
const Decoder = loadWorklet('pcm-decoder-worklet.js')['pcm-decoder-processor'];

// game.js はモジュールとしてロード（DOM非依存ガードあり）
const game = require('./game.js');

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL: ' + msg); } }

// optional リサンプル模擬（最近傍 + gain）。factor=1,gain=1 で素通し。
function resample(samples, factor, gain) {
    if ((factor === 1 || !factor) && (gain === 1 || gain === undefined)) {
        return Array.from(samples);
    }
    const out = []; let pos = 0;
    while (true) {
        const i = Math.floor(pos);
        if (i >= samples.length) break;
        let v = samples[i] * gain;
        if (v > 1) v = 1; if (v < -1) v = -1;
        out.push(v); pos += factor;
    }
    return out;
}

// 1フレーム(ゲームパケット)を encoder→(resample)→decoder に通し、復元payloadを返す。
function loopFrame(encoder, decoder, pkt, factor, gain) {
    const samples = encoder.buildSamples(pkt);
    const rs = resample(samples, factor, gain);
    let got = null;
    decoder.port.postMessage = (m) => { if (m && m.type === 'frame' && !got) got = Array.from(m.payload); };
    for (let i = 0; i < rs.length; i++) decoder.processSample(rs[i]);
    return got;
}

// ============================================================================
// Test 1: パケット往復のバイト整合（encoder→decoder）
// ============================================================================
function testPacketRoundtrip() {
    const enc = new Encoder();
    const dec = new Decoder();
    // ゲームパケット例: [x][y][fire_cnt][hp][flags][seq]
    const samples = [
        [40, 30, 0, 5, 0, 0],
        [41, 30, 1, 5, 0, 1],      // 発射1
        [42, 30, (0x80 | 2), 4, 0, 2], // 大弾フラグ+発射2, HP4
        [43, 30, 2, 0, 0x01, 3],   // HP0 + gameover
    ];
    for (const p of samples) {
        const got = loopFrame(enc, dec, p, 1, 1);
        check(got && got.length === p.length && got.every((v, i) => v === p[i]),
            'roundtrip ' + JSON.stringify(p) + ' got ' + JSON.stringify(got));
    }
}

// ============================================================================
// Test 2: ゲーム状態同期の往復。
//   B(受信側=ブラウザP2相当)が、A が送ってくる状態パケットを受けて
//   位置・発射スポーン・HPから算出した score が正しく反映されるか。
// ============================================================================
function testGameStateSync(factor, gain, label) {
    const enc = new Encoder();
    const dec = new Decoder();

    // 受信側ゲームB を初期化し、PLAYING へ。
    game.gameInit();
    // B を MATCHING 突破させるため、A から最初のパケットを1つ送る。
    let seq = 0;
    const send = (p) => {
        const got = loopFrame(enc, dec, p, factor, gain);
        if (got) game.gameOnRx(got);
        return got;
    };
    // A の状態を作る: x=50,y=100,fire=0,hp=5
    send([50, 100, 0, 5, 0, seq++]);
    game.gameTick(100);                 // MATCHING -> COUNTDOWN
    game.gameTick(100 + 3000);          // COUNTDOWN -> PLAYING

    // A が位置を動かし発射し、被弾してHPが減る様子を順に送る。
    send([60, 100, 0, 5, 0, seq++]);    // 位置更新
    check(game.G.remote.x === 60, label + ': remote x synced to 60');

    const before = game.G.remote.bullets.filter(b => b.active).length;
    send([60, 100, 1, 5, 0, seq++]);    // 発射(fire_cnt 0->1)
    const after = game.G.remote.bullets.filter(b => b.active).length;
    check(after === before + 1, label + ': remote fire spawns a bullet');

    // A の HP が 5->2 に（Bから見て score=3 になるはず）
    send([60, 100, 1, 2, 0, seq++]);
    check(game.G.local.score === 3, label + ': score = MAX_HP - opp hp (=3)');

    // A が gameover(WIN) を通知 -> B は LOSE で終了
    const flags = game.GAME_PKT_FLAG_GAMEOVER |
        ((game.GAME_RES_WIN << game.GAME_PKT_RESULT_SHIFT) & game.GAME_PKT_RESULT_MASK);
    send([60, 100, 1, 0, flags, seq++]);
    check(game.G.state === game.GAME_STATE_RESULT, label + ': reached RESULT');
    check(game.G.result === game.GAME_RESULT_LOSE, label + ': opponent WIN -> my LOSE');
}

console.log('=== loopback integration tests ===');
testPacketRoundtrip();
testGameStateSync(1, 1, 'ideal');
testGameStateSync(0.97, 0.98, 'resample0.97');
testGameStateSync(1.03, 0.98, 'resample1.03');

console.log(`\n=== loopback: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
