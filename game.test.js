/**
 * game.test.js - ブラウザ側ゲームロジックがファームウェア game_shooter.c と
 * バイト/Seq/HIT/HP/チャージ/CFIRE/GAMEOVER/相対移動の意味論で一致することを
 * 検証する Node テスト。
 *
 * 実行: node web/game.test.js
 *
 * game.js は DOM 非依存で require 可能に作ってある（_hasDOM ガード）。
 * テスト送信フックを注入してパケット内容をキャプチャする。
 */
'use strict';

const g = require('./game.js');
const {
    GAME_FIELD_W, GAME_FIELD_H, GAME_SHIP_W, GAME_SHIP_H,
    GAME_MAX_HP, GAME_WIN_SCORE, GAME_BIG_DAMAGE,
    GAME_MOVE_SENS_PCT, GAME_CHARGE_FULL_MS,
    GAME_PKT_FLAG_FIRE, GAME_PKT_FLAG_HIT, GAME_PKT_FLAG_CFIRE,
    GAME_PKT_FLAG_GAMEOVER, GAME_PKT_RESULT_SHIFT, GAME_PKT_RESULT_MASK,
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

// ヘルパ: MATCHING -> PLAYING
function advanceToPlaying(t) {
    gameOnRx([0, 80, 100, 1]); // 相手(P1/下)。位置は下側でも可
    gameTick(t);               // MATCHING -> COUNTDOWN
    t += GAME_COUNTDOWN_MS;
    gameTick(t);               // COUNTDOWN -> PLAYING
    return t;
}

// --- Seq newest-wins (pure helper) ---
function testSeqHelper() {
    check(seqIsNewer(202, 200) === true, 'seq 200->202 newer');
    check(seqIsNewer(199, 200) === false, 'seq 200->199 older');
    check(seqIsNewer(1, 202) === true, 'seq wrap 202->1 newer'); // (1-202) int8 = +55
    check(seqIsNewer(250, 1) === false, 'seq 1->250 older'); // (250-1) int8 = -7
    check(seqIsNewer(5, 5) === false, 'same seq is not newer');
}

// --- 入力パケットフォーマット ---
function testPacketFormat() {
    gameInit();
    sendCount = 0;
    // 押していない状態: fire=false。x は物理タッチだが押していないので位置は変わらない。
    gameOnInput(0, 0, false);
    gameTick(0); // last_send_ms=0, everSent=false -> 初回送信
    check(sendCount >= 1, 'packet sent during matching');
    check(lastPkt.length === 4, 'packet length is 4');
    // 自機初期X = (160-12)/2 = 74。 Y は home_y(P2)=4。
    check(lastPkt[1] === 74, 'packet X = initial ship X (74)');
    check(lastPkt[2] === 4, 'packet[2] = ship Y (home_y P2 = 4)');
    check((lastPkt[0] & GAME_PKT_FLAG_FIRE) === 0, 'no fire flag when idle');
    check((lastPkt[0] & GAME_PKT_FLAG_CFIRE) === 0, 'no cfire flag when idle');

    const seq0 = lastPkt[3];
    gameTick(GAME_SEND_INTERVAL_MS);
    const seq1 = lastPkt[3];
    check(((seq1 - seq0) & 0xFF) === 1, 'seq increments by 1');
}

// --- 相対移動 (バーチャルスティック) の演算 ---
function testRelativeMove() {
    gameInit();
    const startX = G.local.x; // 74
    // 押し始め: 物理X=100 でアンカー確立 ( this frame moves 0)
    gameOnInput(100, 0, true);
    check(G.local.x === startX, 'anchor frame does not move');

    // 物理Xを +40 動かす: delta_phys=40, delta_log = trunc(trunc(40*70/100)/2)
    // = trunc(trunc(28)/2) = trunc(14) = 14
    gameOnInput(140, 0, true);
    check(G.local.x === startX + 14, 'relative move applies sens% and /SCALE_X (delta=14)');

    // 逆方向: 物理X=100 に戻すと delta=0 -> anchorShipX に戻る
    gameOnInput(100, 0, true);
    check(G.local.x === startX, 'relative move back to anchor');

    // 離すとアンカークリア、位置は保持
    gameOnInput(100, 0, false);
    check(G.local.x === startX, 'position preserved after release');

    // クランプ確認: 極端に右へ
    gameInit();
    gameOnInput(0, 0, true);      // anchor at phys 0
    gameOnInput(9999, 0, true);   // huge delta -> clamp to FIELD_W-SHIP_W
    check(G.local.x === GAME_FIELD_W - GAME_SHIP_W, 'move clamped to right edge');
    gameOnInput(-9999, 0, true);
    check(G.local.x === 0, 'move clamped to left edge');
}

// --- 小弾(タップ)発射 -> FIRE フラグ ---
function testSmallFire() {
    gameInit();
    let t = advanceToPlaying(0);
    check(G.state === GAME_STATE_PLAYING, 'reached playing');

    sendCount = 0; lastPkt = null;
    // 押す (touching) -> 短ため -> 離す (release) -> tick で小弾発射 + pending_fire
    gameOnInput(100, 0, true);
    t += GAME_SEND_INTERVAL_MS; gameTick(t);   // press edge (charge start)
    gameOnInput(100, 0, false);
    t += GAME_SEND_INTERVAL_MS; gameTick(t);   // release edge -> spawn small + pending_fire

    // 直後の tick 送信で FIRE フラグが乗る
    let sawFire = false;
    for (let i = 0; i < 3; i++) {
        if (lastPkt && (lastPkt[0] & GAME_PKT_FLAG_FIRE)) { sawFire = true; break; }
        t += GAME_SEND_INTERVAL_MS; gameTick(t);
    }
    check(sawFire, 'quick tap+release sends FIRE flag (small bullet)');
    // 自機弾が1発 active になっている
    const activeLocal = G.local.bullets.filter(b => b.active).length;
    check(activeLocal >= 1, 'small bullet spawned locally on release');
}

// --- 大弾(長ため)発射 -> CFIRE フラグ + 貫通/ダメージ3 ---
function testBigFire() {
    gameInit();
    let t = advanceToPlaying(0);
    sendCount = 0; lastPkt = null;

    // 押し始め
    gameOnInput(100, 0, true);
    t += GAME_SEND_INTERVAL_MS; gameTick(t);   // charge start
    // CHARGE_FULL_MS 以上ためる (ホールドしたまま時間を進める)
    const holdEnd = t + GAME_CHARGE_FULL_MS + 100;
    for (t += GAME_SEND_INTERVAL_MS; t < holdEnd; t += GAME_SEND_INTERVAL_MS) {
        gameOnInput(100, 0, true);
        gameTick(t);
    }
    // 離す -> 大弾発射 + pending_cfire
    gameOnInput(100, 0, false);
    t += GAME_SEND_INTERVAL_MS; gameTick(t);

    let sawCfire = false;
    for (let i = 0; i < 3; i++) {
        if (lastPkt && (lastPkt[0] & GAME_PKT_FLAG_CFIRE)) { sawCfire = true; break; }
        t += GAME_SEND_INTERVAL_MS; gameTick(t);
    }
    check(sawCfire, 'long hold+release sends CFIRE flag (big bullet)');
    const big = G.local.bullets.find(b => b.active && b.charged);
    check(!!big, 'big charged bullet spawned locally');
    check(big && big.damage === GAME_BIG_DAMAGE, 'big bullet damage is 3');
}

// --- 相手の FIRE/CFIRE 受信 -> 相手弾を決定論スポーン ---
function testRemoteSpawn() {
    gameInit();
    let t = advanceToPlaying(0);

    const before = G.remote.bullets.filter(b => b.active).length;
    gameOnRx([GAME_PKT_FLAG_FIRE, 74, 100, 50]); // 相手が小弾発射
    const afterSmall = G.remote.bullets.filter(b => b.active).length;
    check(afterSmall === before + 1, 'remote FIRE spawns one remote bullet');

    gameOnRx([GAME_PKT_FLAG_CFIRE, 74, 100, 51]); // 相手が大弾発射
    const bigRemote = G.remote.bullets.find(b => b.active && b.charged);
    check(!!bigRemote, 'remote CFIRE spawns charged remote bullet');
    // 相手(P1)は上方向へ撃つ -> vy 負
    check(bigRemote && bigRemote.vy < 0, 'remote (P1) bullet travels up (vy<0)');
}

// --- HP: 相手弾が自機に当たると HP 減少 + pending_hit ---
function testHpDamageAndHitNotify() {
    gameInit();
    let t = advanceToPlaying(0);
    check(G.local.hp === GAME_MAX_HP, 'hp starts at MAX_HP');

    // 自機を既知位置に固定 (P2 上, home_y=4, x=74)
    // 相手弾を自機の直上に手動配置して確実に当てる。
    // 相手(P1)弾は上方向(-)へ進むので、自機のすぐ下 (y > 自機) から上へ来る位置に置く。
    // 自機は y=4..13 (SHIP_H=10)。当たるように弾 y を 13 に置き、vy=-4 で 9 -> 命中。
    const b = G.remote.bullets[0];
    b.active = true; b.charged = false; b.damage = 1;
    b.x = G.local.x + 6; // 自機中心 (74+6=80 だが自機x=74..85 内)
    b.y = 13;
    b.vy = -4;

    sendCount = 0; lastPkt = null;
    t += GAME_SEND_INTERVAL_MS;
    gameTick(t); // 弾移動 13->9 命中, hp 5->4, pending_hit

    check(G.local.hp === GAME_MAX_HP - 1, 'small bullet deals 1 damage to hp');

    // 次の送信で HIT フラグ + data[2]=ダメージ量
    let sawHit = false, hitDmg = -1;
    for (let i = 0; i < 3; i++) {
        if (lastPkt && (lastPkt[0] & GAME_PKT_FLAG_HIT)) { sawHit = true; hitDmg = lastPkt[2]; break; }
        t += GAME_SEND_INTERVAL_MS; gameTick(t);
    }
    check(sawHit, 'HIT flag sent after being damaged');
    check(hitDmg === 1, 'HIT packet data[2] = applied damage (1)');
}

// --- 大弾は貫通してダメージ3 ---
function testBigBulletPierceDamage() {
    gameInit();
    let t = advanceToPlaying(0);

    const b = G.remote.bullets[0];
    b.active = true; b.charged = true; b.damage = GAME_BIG_DAMAGE;
    b.x = G.local.x + 6;
    b.y = 13; b.vy = -4;

    t += GAME_SEND_INTERVAL_MS;
    gameTick(t); // 命中 -> hp 5->2, 貫通で弾は残る
    check(G.local.hp === GAME_MAX_HP - GAME_BIG_DAMAGE, 'big bullet deals 3 damage');
    check(b.active === true, 'big bullet pierces (stays active)');
}

// --- HIT 受信 -> local.score にダメージ量を加算 (権威=被弾側) ---
function testScoreFromHit() {
    gameInit();
    let t = advanceToPlaying(0);
    check(G.local.score === 0, 'score starts at 0');

    // 相手が「被弾した(dmg=3)」と通知 -> 自分の与ダメージ +3
    gameOnRx([GAME_PKT_FLAG_HIT, 74, 3, 60]);
    check(G.local.score === 3, 'HIT with dmg=3 adds 3 to local score');

    // dmg=0 のときは 1 として扱う
    gameOnRx([GAME_PKT_FLAG_HIT, 74, 0, 61]);
    check(G.local.score === 4, 'HIT with dmg=0 counts as 1');
}

// --- スコア到達で勝利 (与ダメ >= WIN_SCORE) ---
function testWinByScore() {
    gameInit();
    let t = advanceToPlaying(0);
    let seq = 70;
    // 相手が繰り返し被弾申告 (dmg=1) -> 与ダメ 5 到達で WIN
    for (let i = 0; i < GAME_WIN_SCORE; i++) {
        gameOnRx([GAME_PKT_FLAG_HIT, 74, 1, seq++ & 0xFF]);
    }
    check(G.local.score >= GAME_WIN_SCORE, 'score reached win threshold');
    t += GAME_SEND_INTERVAL_MS;
    gameTick(t);
    check(G.state === GAME_STATE_RESULT, 'game finishes on win score');
    check(G.result === GAME_RESULT_WIN, 'result is WIN');
}

// --- HP 0 で敗北 ---
function testLoseByHpZero() {
    gameInit();
    let t = advanceToPlaying(0);
    // 相手弾で 5 回被弾させる: 手動で大弾(dmg3)+小弾(dmg1)x2 = 5
    // シンプルに hp を直接減らさず、命中経由で確実に 0 にする。
    // ここでは連続小弾で 5 ダメージ。
    for (let k = 0; k < GAME_MAX_HP; k++) {
        const b = G.remote.bullets[0];
        b.active = true; b.charged = false; b.damage = 1;
        b.x = G.local.x + 6; b.y = 13; b.vy = -4;
        t += GAME_SEND_INTERVAL_MS;
        gameTick(t);
        if (G.state === GAME_STATE_RESULT) break;
    }
    check(G.local.hp === 0, 'hp reduced to 0');
    check(G.state === GAME_STATE_RESULT, 'finished when hp hits 0');
    check(G.result === GAME_RESULT_LOSE, 'lose when hp hits 0 (no kill)');
}

// --- GAMEOVER 受信 -> 結果の裏返しで即終了 ---
function testGameoverRx() {
    // 相手が WIN を通知 -> 自分は LOSE
    gameInit();
    let t = advanceToPlaying(0);
    const flags = GAME_PKT_FLAG_GAMEOVER | ((GAME_RES_WIN << GAME_PKT_RESULT_SHIFT) & GAME_PKT_RESULT_MASK);
    gameOnRx([flags, 74, 100, 80]);
    check(G.state === GAME_STATE_RESULT, 'gameover rx enters RESULT');
    check(G.result === GAME_RESULT_LOSE, 'opponent WIN -> my LOSE');

    // 相手が LOSE を通知 -> 自分は WIN
    gameInit();
    t = advanceToPlaying(0);
    const flags2 = GAME_PKT_FLAG_GAMEOVER | ((GAME_RES_LOSE << GAME_PKT_RESULT_SHIFT) & GAME_PKT_RESULT_MASK);
    gameOnRx([flags2, 74, 100, 80]);
    check(G.result === GAME_RESULT_WIN, 'opponent LOSE -> my WIN');

    // 相手が DRAW を通知 -> 自分も DRAW
    gameInit();
    t = advanceToPlaying(0);
    const flags3 = GAME_PKT_FLAG_GAMEOVER | ((GAME_RES_DRAW << GAME_PKT_RESULT_SHIFT) & GAME_PKT_RESULT_MASK);
    gameOnRx([flags3, 74, 100, 80]);
    check(G.result === GAME_RESULT_DRAW, 'opponent DRAW -> my DRAW');
}

// --- GAMEOVER 送信: 決着時に gameover ビット+結果コードを送る ---
function testGameoverTx() {
    gameInit();
    let t = advanceToPlaying(0);
    // WIN させる
    let seq = 90;
    for (let i = 0; i < GAME_WIN_SCORE; i++) gameOnRx([GAME_PKT_FLAG_HIT, 74, 1, seq++ & 0xFF]);
    sendCount = 0; lastPkt = null;
    t += GAME_SEND_INTERVAL_MS;
    gameTick(t); // WIN 判定 -> pending_gameover, RESULT 遷移, 送信継続

    // RESULT 中も pending_gameover があるため送信され続ける
    let sawGameover = false, rc = -1;
    for (let i = 0; i < 3; i++) {
        if (lastPkt && (lastPkt[0] & GAME_PKT_FLAG_GAMEOVER)) {
            sawGameover = true;
            rc = (lastPkt[0] & GAME_PKT_RESULT_MASK) >> GAME_PKT_RESULT_SHIFT;
            break;
        }
        t += GAME_SEND_INTERVAL_MS; gameTick(t);
    }
    check(sawGameover, 'GAMEOVER flag sent on local finish');
    check(rc === GAME_RES_WIN, 'GAMEOVER result code = WIN');
}

// --- 時間切れ引き分け (0-0) ---
function testTimeoutDraw() {
    gameInit();
    let t = advanceToPlaying(0);
    t += GAME_TIME_LIMIT_MS;
    gameTick(t);
    check(G.state === GAME_STATE_RESULT, 'finished at time limit');
    check(G.result === GAME_RESULT_DRAW, 'draw on 0-0 timeout');
}

// --- 視点反転 (P2 は盤面上下反転で自機が手前=下) ---
function testViewFlip() {
    // P2: logical_y=4 (自機上端) -> flipped = (120-(4+10))*2 = 106*2 = 212 (画面下寄り)
    const y = viewPhysY(4, GAME_SHIP_H);
    check(y === (GAME_FIELD_H - (4 + GAME_SHIP_H)) * 2, 'P2 view flip maps top-logical to bottom-screen');
    check(y > GAME_FIELD_H, 'local ship (P2) renders near bottom of 320x240 canvas');
}

testSeqHelper();
testPacketFormat();
testRelativeMove();
testSmallFire();
testBigFire();
testRemoteSpawn();
testHpDamageAndHitNotify();
testBigBulletPierceDamage();
testScoreFromHit();
testWinByScore();
testLoseByHpZero();
testGameoverRx();
testGameoverTx();
testTimeoutDraw();
testViewFlip();

console.log(`\n=== game.js tests: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
