/**
 * game.test.js - ブラウザ側ゲームロジックがファームウェア game_shooter.c と
 * 一致することを検証する Node テスト（状態同期パケット版）。
 *
 * 実行: node web/game.test.js
 *
 * 状態同期パケット(6バイト): [0]x [1]y [2]fire_cnt(bit0-6=累積,bit7=大弾)
 *                            [3]hp [4]flags(bit0=gameover,bit1-2=result,bit3=charging)
 *                            [5]seq
 * 設計の肝: 全パケットが「現在の状態」。欠落・古いパケット破棄があっても
 *          最新1個で完全復元でき、HP/HIT/発射がずれない。
 */
'use strict';

const g = require('./game.js');
const {
    GAME_FIELD_W, GAME_FIELD_H, GAME_SHIP_W, GAME_SHIP_H,
    GAME_MAX_HP, GAME_WIN_SCORE, GAME_BIG_DAMAGE, GAME_MAX_BULLETS,
    GAME_MOVE_SENS_PCT, GAME_CHARGE_FULL_MS,
    GAME_PKT_LEN, GAME_PKT_X, GAME_PKT_Y, GAME_PKT_FIRECNT, GAME_PKT_HP,
    GAME_PKT_FLAGS, GAME_PKT_SEQ,
    GAME_PKT_FIRE_BIG_BIT, GAME_PKT_FIRE_CNT_MASK,
    GAME_PKT_FLAG_GAMEOVER, GAME_PKT_RESULT_SHIFT, GAME_PKT_RESULT_MASK, GAME_PKT_FLAG_CHARGING,
    GAME_RES_WIN, GAME_RES_LOSE, GAME_RES_DRAW,
    GAME_COUNTDOWN_MS, GAME_TIME_LIMIT_MS, GAME_SEND_INTERVAL_MS,
    SCALE_X,
    GAME_STATE_PLAYING, GAME_STATE_MATCHING, GAME_STATE_RESULT,
    GAME_RESULT_WIN, GAME_RESULT_LOSE, GAME_RESULT_DRAW,
    seqIsNewer, viewPhysY,
    G, gameInit, gameOnInput, gameOnRx, gameTick,
} = g;

let pass = 0, fail = 0;
let lastPkt = null, sendCount = 0;
g._setSendHook((pkt) => { lastPkt = pkt.slice(); sendCount++; });

function check(cond, msg) {
    if (cond) { pass++; }
    else { fail++; console.log('FAIL: ' + msg); }
}

// 相手の状態同期パケットを作るヘルパ
function pkt({ x = 80, y = 100, fireCnt = 0, big = false, hp = GAME_MAX_HP, flags = 0, seq = 0 }) {
    let fc = fireCnt & GAME_PKT_FIRE_CNT_MASK;
    if (big) fc |= GAME_PKT_FIRE_BIG_BIT;
    const p = [];
    p[GAME_PKT_X] = x & 0xFF;
    p[GAME_PKT_Y] = y & 0xFF;
    p[GAME_PKT_FIRECNT] = fc & 0xFF;
    p[GAME_PKT_HP] = hp & 0xFF;
    p[GAME_PKT_FLAGS] = flags & 0xFF;
    p[GAME_PKT_SEQ] = seq & 0xFF;
    return p;
}

// MATCHING -> PLAYING
function advanceToPlaying(t) {
    gameOnRx(pkt({ seq: 1 }));
    gameTick(t);
    t += GAME_COUNTDOWN_MS;
    gameTick(t);
    return t;
}

// --- Seq newest-wins ---
function testSeqHelper() {
    check(seqIsNewer(202, 200) === true, 'seq 200->202 newer');
    check(seqIsNewer(199, 200) === false, 'seq 200->199 older');
    check(seqIsNewer(1, 202) === true, 'seq wrap 202->1 newer');
    check(seqIsNewer(250, 1) === false, 'seq 1->250 older');
    check(seqIsNewer(5, 5) === false, 'same seq not newer');
}

// --- パケットフォーマット（6バイト・状態） ---
function testPacketFormat() {
    gameInit();
    sendCount = 0;
    let t = advanceToPlaying(1000);
    gameOnInput(0, 0, false);
    t += GAME_SEND_INTERVAL_MS; gameTick(t);
    check(lastPkt.length === GAME_PKT_LEN, 'packet is 6 bytes');
    check(lastPkt[GAME_PKT_HP] === GAME_MAX_HP, 'packet hp = full at start');
    check((lastPkt[GAME_PKT_FIRECNT] & GAME_PKT_FIRE_CNT_MASK) === 0, 'fire_cnt=0 when no fire');
    const seq0 = lastPkt[GAME_PKT_SEQ];
    t += GAME_SEND_INTERVAL_MS; gameTick(t);
    const seq1 = lastPkt[GAME_PKT_SEQ];
    check(((seq1 - seq0) & 0xFF) === 1, 'seq increments by 1');
}

// --- 位置は絶対座標で送る/受ける ---
function testPosition() {
    gameInit();
    let t = advanceToPlaying(1000);
    // 相手位置を受信（絶対座標）
    gameOnRx(pkt({ x: 20, y: 30, seq: 10 }));
    check(G.remote.x === 20, 'remote x updated to 20');
    check(G.remote.y === 30, 'remote y updated to 30');
    // 古いseqは無視（状態同期でも順序は守る）
    gameOnRx(pkt({ x: 99, y: 99, seq: 5 }));
    check(G.remote.x === 20, 'older seq ignored (x stays 20)');
}

// --- 発射: fire_count 差分で相手弾がスポーン ---
function testFireCounterSpawn() {
    gameInit();
    let t = advanceToPlaying(1000);
    const before = G.remote.bullets.filter(b => b.active).length;
    // 相手が1発撃った（fireCnt 0->1）
    gameOnRx(pkt({ fireCnt: 1, seq: 11 }));
    const after1 = G.remote.bullets.filter(b => b.active).length;
    check(after1 === before + 1, 'fire_cnt +1 spawns one remote bullet');
    // 同じ fireCnt の再送（重複）はスポーンしない
    gameOnRx(pkt({ fireCnt: 1, seq: 12 }));
    const after2 = G.remote.bullets.filter(b => b.active).length;
    check(after2 === after1, 'same fire_cnt (resend) does not double-spawn');
}

// --- 欠落補償: fire_cnt が飛んでも差分ぶんスポーン ---
function testFireGapCompensation() {
    gameInit();
    let t = advanceToPlaying(1000);
    const before = G.remote.bullets.filter(b => b.active).length;
    // fireCnt が 0 -> 3 に飛んだ（間の2パケットが欠落）
    gameOnRx(pkt({ fireCnt: 3, seq: 20 }));
    const after = G.remote.bullets.filter(b => b.active).length;
    check(after === before + 3, 'fire_cnt jump 0->3 spawns 3 bullets (gap compensated)');
}

// --- 大弾フラグ ---
function testBigBullet() {
    gameInit();
    let t = advanceToPlaying(1000);
    gameOnRx(pkt({ fireCnt: 1, big: true, seq: 30 }));
    const big = G.remote.bullets.find(b => b.active && b.charged);
    check(!!big, 'fire with big bit spawns charged bullet');
}

// --- HP状態同期: 相手HP現在値から score を算出（ずれない） ---
function testHpStateSync() {
    gameInit();
    let t = advanceToPlaying(1000);
    // 相手HPが 5->2 に（自分が3ダメージ与えた状態）
    gameOnRx(pkt({ hp: 2, seq: 40 }));
    check(G.local.score === GAME_MAX_HP - 2, 'score = MAX_HP - opponent hp (=3)');
    // さらに相手HP 2->0（計5ダメージ）
    gameOnRx(pkt({ hp: 0, seq: 41 }));
    check(G.local.score === GAME_MAX_HP, 'score reaches MAX when opp hp=0');
    // 途中パケット欠落を模しても、最新HPで正しく復元される（単調増加）
}

// --- HP欠落耐性: 中間を飛ばしても最新HPで正しい score ---
function testHpGapResilience() {
    gameInit();
    let t = advanceToPlaying(1000);
    // いきなり相手HP=1（間のHP通知が全部落ちた想定）
    gameOnRx(pkt({ hp: 1, seq: 50 }));
    check(G.local.score === GAME_MAX_HP - 1, 'score correct even if intermediate HP packets lost');
}

// --- 被弾でHPが減り、送信パケットに現在HPが載る ---
function testLocalHitSendsHp() {
    gameInit();
    let t = advanceToPlaying(1000);
    // 相手弾を自機に当てるため、相手が撃つ→弾が自機まで来るのを進める
    // ここでは直接 G をいじらず、相手発射→tickで弾移動→被弾を数フレーム進める
    // 自機を相手弾の正面に置く
    G.local.x = G.remote.x; // 同じX
    gameOnRx(pkt({ x: G.remote.x, fireCnt: 1, seq: 60 }));
    // 弾が自機に到達するまで tick
    for (let i = 0; i < 40; i++) { t += GAME_SEND_INTERVAL_MS; gameTick(t); }
    check(G.local.hp < GAME_MAX_HP, 'local hp decreased after being hit');
    check(lastPkt[GAME_PKT_HP] === G.local.hp, 'sent packet carries current local hp');
}

// --- gameover 同期 ---
function testGameover() {
    gameInit();
    let t = advanceToPlaying(1000);
    // 相手が WIN を通知 -> 自分は LOSE で即終了
    const flags = GAME_PKT_FLAG_GAMEOVER | ((GAME_RES_WIN << GAME_PKT_RESULT_SHIFT) & GAME_PKT_RESULT_MASK);
    gameOnRx(pkt({ flags, seq: 70 }));
    check(G.state === GAME_STATE_RESULT, 'gameover moves to RESULT');
    check(G.result === GAME_RESULT_LOSE, 'opponent WIN -> my LOSE');
}

// --- charging フラグ ---
function testChargingFlag() {
    gameInit();
    let t = advanceToPlaying(1000);
    // 押し続けてためる -> charging フラグが立つ
    gameOnInput(160, 0, true);
    t += GAME_SEND_INTERVAL_MS; gameTick(t);
    gameOnInput(160, 0, true);
    t += GAME_CHARGE_FULL_MS; gameTick(t);
    check((lastPkt[GAME_PKT_FLAGS] & GAME_PKT_FLAG_CHARGING) !== 0, 'charging flag set while holding');
}

// --- 視点反転 ---
function testViewFlip() {
    // P2(ブラウザ)は盤面を上下反転して自機を手前に見せる
    const y0 = viewPhysY(0, GAME_SHIP_H);
    const yBottom = viewPhysY(GAME_FIELD_H - GAME_SHIP_H, GAME_SHIP_H);
    check(y0 > yBottom, 'P2 view flips (logical top maps to lower screen)');
}

testSeqHelper();
testPacketFormat();
testPosition();
testFireCounterSpawn();
testFireGapCompensation();
testBigBullet();
testHpStateSync();
testHpGapResilience();
testLocalHitSendsHp();
testGameover();
testChargingFlag();
testViewFlip();

console.log(`\n=== game.js tests: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
