/**
 * channel.test.js - 「実機経路を模した」チャネルでの PCM搬送×状態同期 検証。
 *
 * 実行: node web/channel.test.js
 *
 * これまでの実機実測で判明した経路特性を合成して模擬する:
 *   (a) 線形補間リサンプル（非整数レート比。最近傍でなく補間でなまる）
 *   (b) 1次ローパス（急峻な極性反転の鈍り。run=63 問題の原因）
 *   (c) 振幅低下（PK≈32300 の軽い減衰）
 *   (d) 微小ノイズ
 *   (e) パケット欠落（双方向衝突で時々ロスする）
 *
 * 検証:
 *   - 搬送フレームが(a)-(d)の歪み下でも CRC 一致で復元できるフレームが十分あること
 *   - 欠落(e)があっても、状態同期パケットなら「最新が1つ届けば」
 *     位置・発射数・HP(=score) が最終的に正しい値へ収束すること
 *
 * ※ 実機そのものの歪みを完全再現はできない（OS/UAC固有）。ここは
 *    「状態同期が欠落・なまりに強い」ことの定量確認。
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
const game = require('./game.js');

let pass = 0, fail = 0;
function check(cond, msg) { if (cond) pass++; else { fail++; console.log('FAIL: ' + msg); } }

// 実機経路を模したチャネル: 線形補間リサンプル + ローパス + 振幅 + ノイズ。
function hwChannel(samples, opt) {
    const factor = opt.factor || 1.0;
    const gain = opt.gain !== undefined ? opt.gain : 1.0;
    const lp = opt.lp || 0;        // 1次ローパス係数(0..1)。大きいほど鈍る
    const noise = opt.noise || 0;  // 振幅ノイズ(±)
    const n = samples.length;
    const out = [];
    let pos = 0;
    while (true) {
        const i0 = Math.floor(pos);
        if (i0 >= n) break;
        const i1 = Math.min(i0 + 1, n - 1);
        const fr = pos - i0;
        let v = (samples[i0] * (1 - fr) + samples[i1] * fr) * gain;
        if (noise) v += (Math.random() * 2 - 1) * noise;
        if (v > 1) v = 1; if (v < -1) v = -1;
        out.push(v);
        pos += factor;
    }
    if (lp > 0) {
        let y = 0;
        for (let i = 0; i < out.length; i++) { y = y + lp * (out[i] - y); out[i] = y; }
    }
    return out;
}

// 1フレームをチャネル経由で decoder に通し、復元payloadを返す(復元失敗はnull)。
function sendThroughChannel(enc, dec, pkt, chOpt) {
    const samples = enc.buildSamples(pkt);
    const rs = hwChannel(samples, chOpt);
    let got = null;
    dec.port.postMessage = (m) => { if (m && m.type === 'frame' && !got) got = Array.from(m.payload); };
    for (let i = 0; i < rs.length; i++) dec.processSample(rs[i]);
    return got;
}

// ============================================================================
// Test 1: 実機模擬チャネルでの搬送成功率。歪みがあっても一定割合は復元できること。
// ============================================================================
function testChannelDecodeRate(chOpt, minRate, label) {
    const enc = new Encoder();
    const dec = new Decoder();
    let ok = 0;
    const N = 60;
    for (let s = 0; s < N; s++) {
        const pkt = [40 + (s % 80), 100, s & 0x7F, 5 - (s % 6), 0, s & 0xFF];
        const got = sendThroughChannel(enc, dec, pkt, chOpt);
        if (got && got.length === pkt.length && got.every((v, i) => v === pkt[i])) ok++;
    }
    const rate = ok / N;
    check(rate >= minRate, `${label}: decode rate ${(rate*100).toFixed(0)}% >= ${(minRate*100)}% (${ok}/${N})`);
}

// ============================================================================
// Test 2: 欠落ありチャネルでの状態同期の収束。
//   送信側Aの「真の状態」を進めつつ、各パケットを確率dropで落とす。
//   受信側Bは、最後に届いたパケットで状態が正しく復元されること(位置/発射/score)。
// ============================================================================
function testStateConvergenceWithDrops(dropRate, chOpt, label) {
    const enc = new Encoder();
    const dec = new Decoder();
    game.gameInit();

    let seq = 0;
    let aFireCount = 0;      // Aの累積発射
    let aHp = 5;
    let aX = 50;
    let delivered = 0;

    const sendState = (forceDeliver) => {
        const fireByte = (aFireCount & 0x7F);
        const pkt = [aX & 0xFF, 100, fireByte, aHp, 0, seq++ & 0xFF];
        // ランダム欠落（forceDeliverなら必ず届ける）
        if (!forceDeliver && Math.random() < dropRate) return;
        const got = sendThroughChannel(enc, dec, pkt, chOpt);
        if (got) { game.gameOnRx(got); delivered++; }
    };

    // MATCHING 突破(最初は確実に届ける)
    sendState(true);
    game.gameTick(100);
    game.gameTick(100 + 3000);  // PLAYING

    // Aが: 移動しながら 5発撃ち、HPが 5->1 に減る、を多数パケットで送る(一部欠落)。
    for (let step = 0; step < 40; step++) {
        if (step === 5)  { aX = 70; }
        if (step === 10) { aFireCount = 1; }
        if (step === 15) { aFireCount = 2; }
        if (step === 20) { aFireCount = 3; aHp = 4; }
        if (step === 25) { aFireCount = 4; aHp = 3; }
        if (step === 30) { aFireCount = 5; aHp = 1; }
        sendState(false);
    }
    // 最後に「現在の真の状態」を必ず1つ届ける（状態同期の肝: 最新が届けば収束）。
    sendState(true);
    sendState(true);  // 念のため2回(1回目が搬送歪みで化けても次で)

    // 収束確認: 位置・score(=MAX-HP)・発射スポーン数が真値に追いつく。
    check(game.G.remote.x === 70, `${label}: position converged to 70 (got ${game.G.remote.x})`);
    check(game.G.local.score === (5 - 1), `${label}: score converged to MAX-HP=4 (got ${game.G.local.score})`);
    // 発射は差分スポーンなので、累積5発ぶんの弾が(弾上限内で)出ているはず
    const bullets = game.G.remote.bullets.filter(b => b.active).length;
    check(bullets >= 1, `${label}: at least some remote bullets spawned (got ${bullets})`);
}

// ============================================================================
// Test 3: UAC バッファ境界模擬。
//   実機の AudioWorklet process() は 128 サンプル固定で呼ばれ、複数フレームが
//   連続ストリームで流れる。1フレーム(Sync+データ=数百サンプル)はバッファ境界を
//   またぐため、decoder の状態がブロック境界で正しく保持されるかが問われる。
//   ここでは「複数フレームを連結した連続サンプル列を、QUANTUM サンプルずつ刻んで
//   decoder に投入」し、全フレームが CRC 一致で復元できることを検証する。
//   (実機は 128。worklet 側に依存はないが実機に合わせる)
// ============================================================================
function testUacBufferBoundary(quantum, chOpt, label) {
    const enc = new Encoder();
    const dec = new Decoder();

    // 連続ストリームを作る: 複数フレーム + フレーム間に無音ギャップ(実機のアイドル)
    const stream = [];
    const expectPayloads = [];
    const GAP = 40;  // フレーム間の無音サンプル(送信していない区間)
    for (let s = 0; s < 20; s++) {
        const pkt = [40 + s, 100, s & 0x7F, 5 - (s % 6), 0, s & 0xFF];
        expectPayloads.push(pkt);
        const samples = enc.buildSamples(pkt);
        const ch = hwChannel(samples, chOpt);
        for (const v of ch) stream.push(v);
        for (let g = 0; g < GAP; g++) stream.push(0);  // アイドル(無音)
    }

    // QUANTUM サンプルずつ decoder に投入(実機の process() 相当)。
    const gotList = [];
    dec.port.postMessage = (m) => { if (m && m.type === 'frame') gotList.push(Array.from(m.payload)); };
    for (let i = 0; i < stream.length; i += quantum) {
        for (let j = i; j < Math.min(i + quantum, stream.length); j++) {
            dec.processSample(stream[j]);
        }
    }

    // 復元できたフレーム数と、それらが期待payloadのいずれかに一致するか。
    let matched = 0;
    for (const got of gotList) {
        if (expectPayloads.some(p => p.length === got.length && p.every((v, i) => v === got[i]))) {
            matched++;
        }
    }
    // クリーンなら全フレーム復元できるはず。歪みありは一定割合。
    check(gotList.length > 0, `${label}: decoded at least one frame (got ${gotList.length})`);
    check(matched === gotList.length, `${label}: all decoded frames are valid payloads (${matched}/${gotList.length})`);
    return { frames: gotList.length, matched };
}

// ============================================================================
// Test 4: USB 1ms単位の欠落（実機の usb_device_uac 受信バグの再現）。
//   元実装では ISR が 1ms(=48サンプル) 毎に1個のバッファへ上書きし、タスク起床が
//   遅れると 1ms 分がまるごと消えていた。1パケット(約28ms)のうち1msでも欠けると
//   ビット位置がずれて CRC 不一致になるため、生存率は (1-p)^28 に落ちる。
//   修正後(FIFO全量読み出し)は p=0 相当になる。ここではその差を数値で固定する。
// ============================================================================
function dropUsbMs(samples, p) {
    const MS = 48;  // 48kHz の 1ms 分
    const out = [];
    for (let i = 0; i < samples.length; i += MS) {
        if (Math.random() < p) continue;            // この1ms分が上書きで消えた
        for (let j = i; j < Math.min(i + MS, samples.length); j++) out.push(samples[j]);
    }
    return out;
}

function testUsbMsDrop(p, label) {
    const enc = new Encoder();
    let ok = 0;
    const N = 200;
    for (let s = 0; s < N; s++) {
        const dec = new Decoder();
        const pkt = [40 + (s % 80), 100, s & 0x7F, 5, 0, s & 0xFF];
        const samples = enc.buildSamples(pkt);
        const rs = dropUsbMs(Array.from(samples), p);
        let got = null;
        dec.port.postMessage = (m) => { if (m && m.type === 'frame' && !got) got = Array.from(m.payload); };
        for (let i = 0; i < rs.length; i++) dec.processSample(rs[i]);
        if (got && got.length === pkt.length && got.every((v, i) => v === pkt[i])) ok++;
    }
    return ok / N;
}

console.log('=== hardware-channel simulation tests ===');

// 搬送成功率: 軽い歪み(ほぼ素通し)はほぼ100%
testChannelDecodeRate({ factor: 1.0, gain: 1.0, lp: 0 }, 0.95, 'clean');
// 実機寄り: 補間+軽リサンプル+軽ローパス+振幅減衰
testChannelDecodeRate({ factor: 1.02, gain: 0.985, lp: 0.3, noise: 0.01 }, 0.6, 'hw-like mild');
testChannelDecodeRate({ factor: 0.97, gain: 0.98, lp: 0.4, noise: 0.015 }, 0.4, 'hw-like harsh');

// 状態収束: 欠落があっても最新が届けば正しい状態へ収束
testStateConvergenceWithDrops(0.0,  { factor: 1.0, gain: 1.0 }, 'drops0%');
testStateConvergenceWithDrops(0.3,  { factor: 1.0, gain: 1.0 }, 'drops30%');
testStateConvergenceWithDrops(0.6,  { factor: 1.0, gain: 1.0 }, 'drops60%');
testStateConvergenceWithDrops(0.3,  { factor: 1.02, gain: 0.985, lp: 0.3 }, 'drops30%+hw-like');

// UACバッファ境界(128サンプル刻み)での連続ストリーム復調。
// クリーン: 全フレーム復元。実機の process() が128刻みでもフレーム境界をまたいで
// 正しく復調できる(decoder状態がブロック境界で保たれる)ことを確認。
{
    const r = testUacBufferBoundary(128, { factor: 1.0, gain: 1.0 }, 'uac-boundary clean q128');
    check(r.frames === 20, `uac-boundary clean: all 20 frames decoded (got ${r.frames})`);
}
// 刻みを変えても(境界位置がずれても)成立すること。
testUacBufferBoundary(64,  { factor: 1.0, gain: 1.0 }, 'uac-boundary clean q64');
testUacBufferBoundary(100, { factor: 1.0, gain: 1.0 }, 'uac-boundary clean q100(odd)');
// 実機寄りの軽い歪み + 128刻み。復元フレームは全て正当であること(化けフレームを拾わない)。
testUacBufferBoundary(128, { factor: 1.01, gain: 0.99, lp: 0.2 }, 'uac-boundary hw-like q128');

// USB 1ms 欠落: 修正前の症状(数%の1ms欠落でパケットがほぼ全滅)と、修正後(欠落なし=全通過)を固定。
{
    const rate0 = testUsbMsDrop(0.0, 'usb-ms-drop 0%');
    check(rate0 >= 0.99, `usb-ms-drop 0% (fixed firmware): ${(rate0*100).toFixed(0)}% survive`);
    const rate5 = testUsbMsDrop(0.05, 'usb-ms-drop 5%');
    // 1パケット約28ms → (0.95)^28 ≒ 24%。1msの欠落が致命的であることを確認(上限で判定)。
    check(rate5 < 0.5, `usb-ms-drop 5% (old firmware): only ${(rate5*100).toFixed(0)}% survive (expected ~24%)`);
    console.log(`  [info] USB 1ms drop survival: 0%->${(rate0*100).toFixed(0)}%, 5%->${(rate5*100).toFixed(0)}%`);
}

// ============================================================================
// Test 5(対策Y): ビットずれで Len を巨大値と誤読したフレームの後でも、次フレームを
//   復元できること。Len>PCM_MAX_FRAME_PAYLOAD(64) を即破棄して Sync 再探索へ戻る
//   ので、暴走読みが次フレームの Sync を食いつぶさない。
//   手順: [Sync + Seq + Len=200(巨大) + ゴミ少々] の後に [正常な6Bフレーム] を連結し、
//   正常フレームが CRC 一致で復元されることを確認する。
// ============================================================================
{
    const enc = new Encoder();
    const dec = new Decoder();

    // 1) 暴走フレーム: Sync の後に Seq, Len=200 を手で流し込む（ゴミは少しだけ）。
    //    enc.buildSamples は正常フレームしか作れないので、Sync 波形 + 任意バイトを
    //    直接マンチェスターで生成する簡易ヘルパを使わず、「正常フレームの Len を
    //    無理やり大きくした」サンプル列を作る代わりに、正常フレームを2つ連結し、
    //    1つ目の途中にビットずれ相当の破損(1サンプル挿入)を入れて Len 誤読を誘発する。
    const SYNC_LEN = 32;               // PCM_SYNC_BLK(8) * 4（worklet と一致）
    const good = [40, 100, 7, 5, 0, 123];
    const s1 = Array.from(enc.buildSamples([10, 20, 30, 40, 50, 60])); // 壊す対象
    const s2 = Array.from(enc.buildSamples(good));                     // 正しく読みたい
    // s1 のデータ部先頭付近に 1 サンプル挿入してビット位相をずらす（Len 誤読を誘発）。
    const corruptAt = SYNC_LEN + 20;
    s1.splice(corruptAt, 0, s1[corruptAt] || 0.5);
    const stream = s1.concat(new Array(40).fill(0)).concat(s2);

    const gotList = [];
    dec.port.postMessage = (m) => { if (m && m.type === 'frame') gotList.push(Array.from(m.payload)); };
    for (let i = 0; i < stream.length; i++) dec.processSample(stream[i]);

    const recoveredGood = gotList.some(g => g.length === good.length && g.every((v, i) => v === good[i]));
    check(recoveredGood, `recovery-Y: good frame after a corrupted(Len-overrun) frame is recovered (frames=${gotList.length})`);
}

console.log(`\n=== channel: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
