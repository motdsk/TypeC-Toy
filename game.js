/**
 * game.js - リアルタイム対戦シューティング（ブラウザ側 / 要件19.1, 19.6）
 *
 * ブラウザは「プレイヤー2 (P2)」。対戦相手の M5Stack CoreS3 が「プレイヤー1 (P1)」。
 * 通信は PCM 直接搬送（web/pcm-encoder-worklet.js / pcm-decoder-worklet.js）を
 * UAC 経由（ブラウザのマイク/スピーカ = USB オーディオデバイス）で行う。
 *
 * ■ ファームウェアとのバイト/ロジック互換（typec_poc_idf/main/game_shooter.c を厳密ミラー）
 *   - 論理盤面: 160x120。自機/相手機サイズ 12x10。SCALE_X=SCALE_Y=2。Canvas 320x240。
 *   - パケット = 4バイト:
 *       [0] flags: bit0=FIRE(0x01) bit1=HIT(0x02) bit2=CFIRE(0x04)
 *                  bit3=GAMEOVER(0x08) bit4-5=result(shift 4, mask 0x30)
 *       [1] x   : 自機X (0..159) 兼 発射X
 *       [2]     : HIT時=ダメージ量 / 通常時=自機Y
 *       [3] seq : 8bit newest-wins
 *   - 弾は決定論スポーン（座標は送らない）。FIRE/CFIRE 受信で相手弾を生成。
 *   - P1(CoreS3)は上方向(-)へ、P2(ブラウザ)は下方向(+)へ撃つ。
 *   - HP制: 初期HP=5。相手弾が自機に当たると HP を減らし pending_hit を立てる。
 *     相手の HIT 通知(=相手が被弾した申告)を受けると local.score += dmg。
 *   - 決着は gameover ビット+結果コードで相互通知（両機同時終了）。
 *
 * ■ 操作（firmware と同一のバーチャルスティック）
 *   キャンバス上を「押している間 = 移動(相対) ＆ ため」「離した瞬間 = 発射」。
 *   短ため=小弾(黄, dmg1)、長ため=大弾(シアン, dmg3/貫通)。
 *   物理タッチXは 0..319（LCD_W）空間へ写像し、firmware の SCALE_X 除算に合わせる。
 *
 * ■ 視点反転
 *   ブラウザは P2 なので描画時に盤面を上下反転し、自機を必ず手前(下)に見せる。
 */

'use strict';

// ============================================================================
// ゲーム定数（game_shooter.h を厳密ミラー）
// ============================================================================
const GAME_FIELD_W = 160;
const GAME_FIELD_H = 120;
const GAME_SHIP_W = 12;
const GAME_SHIP_H = 10;
const GAME_MAX_BULLETS = 6;
const GAME_SMALL_SPEED = 4;
const GAME_BIG_SPEED = 6;
const GAME_MAX_HP = 5;
const GAME_WIN_SCORE = GAME_MAX_HP;      // 5
const GAME_TIME_LIMIT_MS = 60000;
const GAME_COUNTDOWN_MS = 3000;
const GAME_SEND_INTERVAL_MS = 20;        // 50Hz
const GAME_TICK_INTERVAL_MS = 20;        // ローカルループ 50Hz

const GAME_MOVE_SENS_PCT = 70;
const GAME_CHARGE_MIN_MS = 450;
const GAME_CHARGE_FULL_MS = 1100;
const GAME_SMALL_DAMAGE = 1;
const GAME_BIG_DAMAGE = 3;
const GAME_FIRE_LOCKOUT_MS = 250;

const GAME_PKT_LEN = 4;
const GAME_PKT_FLAG_FIRE = 0x01;
const GAME_PKT_FLAG_HIT = 0x02;
const GAME_PKT_FLAG_CFIRE = 0x04;
const GAME_PKT_FLAG_GAMEOVER = 0x08;
const GAME_PKT_RESULT_SHIFT = 4;
const GAME_PKT_RESULT_MASK = 0x30;

// gameover 時の result エンコード (2bit)
const GAME_RES_WIN = 1;
const GAME_RES_LOSE = 2;
const GAME_RES_DRAW = 3;

// 状態機械（game_state_t）
const GAME_STATE_MATCHING = 0;
const GAME_STATE_COUNTDOWN = 1;
const GAME_STATE_PLAYING = 2;
const GAME_STATE_RESULT = 3;

// 勝敗（game_result_t）
const GAME_RESULT_NONE = 0;
const GAME_RESULT_WIN = 1;
const GAME_RESULT_LOSE = 2;
const GAME_RESULT_DRAW = 3;

// 描画スケール（論理160x120 -> Canvas 320x240, x2。firmware SCALE と同一）
const LCD_W = 320;
const LCD_H = 240;
const SCALE_X = LCD_W / GAME_FIELD_W; // 2
const SCALE_Y = LCD_H / GAME_FIELD_H; // 2

// ブラウザはプレイヤー2（相手 CoreS3 が P1）
const IS_PLAYER_ONE = false;

// ============================================================================
// ユーティリティ（game_shooter.c を写像）
// ============================================================================
function clampI(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/*
 * Seq newest-wins 判定（8bit ラップアラウンド）。
 * new_seq が cur_seq より新しいなら true。int8 差分>0 で判定。
 */
function seqIsNewer(newSeq, curSeq) {
    let diff = (newSeq - curSeq) & 0xFF;
    if (diff >= 0x80) diff -= 0x100; // to int8
    return diff > 0;
}

// AABB: 弾(点) が ship の矩形内か（bullet_hits_ship を写像）
function bulletHitsShip(b, s) {
    return (b.x >= s.x && b.x < s.x + GAME_SHIP_W &&
            b.y >= s.y && b.y < s.y + GAME_SHIP_H);
}

// ============================================================================
// ゲーム状態（game_shooter.c の static G を写像）
// ============================================================================
function makeShip() {
    const bullets = [];
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        bullets.push({ x: 0, y: 0, vy: 0, damage: 0, charged: false, active: false });
    }
    return { x: 0, y: 0, bullets, score: 0, hp: GAME_MAX_HP, alive: true };
}

function resetShip(s, isP1Ship) {
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        const b = s.bullets[i];
        b.x = 0; b.y = 0; b.vy = 0; b.damage = 0; b.charged = false; b.active = false;
    }
    s.alive = true;
    s.score = 0;
    s.hp = GAME_MAX_HP;
    s.x = Math.floor((GAME_FIELD_W - GAME_SHIP_W) / 2);
    // P1 は下側、P2 は上側（盤面は対称）
    s.y = isP1Ship ? (GAME_FIELD_H - GAME_SHIP_H - 4) : 4;
}

const G = {
    initialized: false,
    isP1: IS_PLAYER_ONE,

    state: GAME_STATE_MATCHING,
    result: GAME_RESULT_NONE,

    local: makeShip(),   // 自機 (P2/上)
    remote: makeShip(),  // 相手機 (P1/下)

    prevFire: false,

    txSeq: 0,
    lastRxSeq: 0,
    haveRx: false,
    pendingHit: false,
    pendingHitDmg: 0,
    pendingFire: false,
    pendingCfire: false,
    pendingGameover: false,
    myResultCode: 0,

    lastSendMs: 0,
    everSent: false,
    stateEnterMs: 0,
    nowMs: 0,

    homeY: 4, // P2 は上端 (reset 時に設定)

    // 相対移動（バーチャルスティック）
    haveAnchor: false,
    anchorTouchX: 0,
    anchorShipX: 0,

    // チャージ（押している間ためる -> 離したら発射）
    touching: false,
    prevTouching: false,
    chargeStartMs: 0,
    chargeLevel: 0,
};

function stateEnter(st) {
    G.state = st;
    G.stateEnterMs = G.nowMs;
}

function gameInit() {
    G.initialized = true;
    G.isP1 = IS_PLAYER_ONE;
    G.state = GAME_STATE_MATCHING;
    G.result = GAME_RESULT_NONE;
    resetShip(G.local, IS_PLAYER_ONE);     // 自機: 自分の側 (P2 -> 上)
    resetShip(G.remote, !IS_PLAYER_ONE);   // 相手機: 反対側 (P1 -> 下)

    // 自機Yは自陣の端に固定 (横移動シューティング)
    G.homeY = IS_PLAYER_ONE ? (GAME_FIELD_H - GAME_SHIP_H - 4) : 4;

    G.prevFire = false;
    G.txSeq = 0;
    G.lastRxSeq = 0;
    G.haveRx = false;
    G.pendingHit = false;
    G.pendingHitDmg = 0;
    G.pendingFire = false;
    G.pendingCfire = false;
    G.pendingGameover = false;
    G.myResultCode = 0;
    G.nowMs = 0;
    G.lastSendMs = 0;
    G.everSent = false;
    G.stateEnterMs = 0;

    // 移動/チャージ状態初期化
    G.haveAnchor = false;
    G.anchorTouchX = 0;
    G.anchorShipX = G.local.x;
    G.touching = false;
    G.prevTouching = false;
    G.chargeStartMs = 0;
    G.chargeLevel = 0;

    stateEnter(GAME_STATE_MATCHING);
}

// ============================================================================
// 弾生成（spawn_bullet_ex を写像）
//   big=true で大弾(長ため/貫通/高速/ダメージ3)、false で小弾(短ため)
// ============================================================================
function spawnBulletEx(s, isP1Ship, big) {
    const speed = big ? GAME_BIG_SPEED : GAME_SMALL_SPEED;
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        const b = s.bullets[i];
        if (!b.active) {
            b.active = true;
            b.charged = big;
            b.damage = big ? GAME_BIG_DAMAGE : GAME_SMALL_DAMAGE;
            b.x = s.x + Math.floor(GAME_SHIP_W / 2);
            if (isP1Ship) {
                // P1 は上方向(-)
                b.y = s.y - 1;
                b.vy = -speed;
            } else {
                // P2 は下方向(+)
                b.y = s.y + GAME_SHIP_H + 1;
                b.vy = speed;
            }
            return;
        }
    }
    // 空きが無ければ発射しない（静的上限）
}

// ============================================================================
// ローカル入力（game_shooter_on_input を写像, client-side prediction）
//   local_x : 生の物理タッチX (0..LCD_W-1)。相対移動でワープを防ぐ。
//   fire    : 今タッチしているか (touching)。
// ============================================================================
function gameOnInput(localX, localY, fire) {
    if (!G.initialized) return;
    // 横移動シューティング: localY は使わない (Yは自陣に固定)

    G.touching = fire;

    if (fire) {
        if (!G.haveAnchor) {
            // 押し始め: 現在のタッチ位置と自機位置を基準に記録
            G.haveAnchor = true;
            G.anchorTouchX = localX;
            G.anchorShipX = G.local.x;
        }
        // 基準からのスワイプ変位(物理px)を感度倍率で論理移動量に変換して加算
        const deltaPhys = localX - G.anchorTouchX;
        const deltaLog = Math.trunc(Math.trunc(deltaPhys * GAME_MOVE_SENS_PCT / 100) / SCALE_X);
        const nx = G.anchorShipX + deltaLog;
        G.local.x = clampI(nx, 0, GAME_FIELD_W - GAME_SHIP_W);
    } else {
        // 離した: 基準クリア (次のタッチで再アンカー)。位置は保持。
        G.haveAnchor = false;
    }
    G.local.y = G.homeY;
}

// ============================================================================
// 受信（game_shooter_on_rx を写像）— Seq newest-wins
// ============================================================================
function gameOnRx(data) {
    if (!G.initialized || !data || data.length < GAME_PKT_LEN) return;

    const flags = data[0];
    const rxX = data[1];
    const rxY = data[2];
    const rxSeq = data[3];

    if (!G.haveRx) {
        // MATCHING 確立: 最初の受信は無条件採用
        G.haveRx = true;
        G.lastRxSeq = rxSeq;
    } else {
        if (!seqIsNewer(rxSeq, G.lastRxSeq)) {
            return; // 古い/重複は破棄
        }
        G.lastRxSeq = rxSeq;
    }

    // 相手機の位置更新（HIT時は data[2] がダメージ量なので Y は更新しない）
    G.remote.x = clampI(rxX, 0, GAME_FIELD_W - GAME_SHIP_W);
    if (!(flags & GAME_PKT_FLAG_HIT)) {
        G.remote.y = clampI(rxY, 0, GAME_FIELD_H - GAME_SHIP_H);
    }

    // 相手が発射 -> 相手機から相手の向きで弾をスポーン（決定論同期）
    if (flags & GAME_PKT_FLAG_FIRE) {
        spawnBulletEx(G.remote, !G.isP1, /*big=*/false);
    }
    if (flags & GAME_PKT_FLAG_CFIRE) {
        spawnBulletEx(G.remote, !G.isP1, /*big=*/true);
    }

    // 相手が被弾を通知 -> 自分の与ダメージ(score)に加算（権威=被弾側）
    if (flags & GAME_PKT_FLAG_HIT) {
        const dmg = rxY ? rxY : 1;
        if (G.local.score + dmg > 0xFF) G.local.score = 0xFF;
        else G.local.score += dmg;
    }

    // 相手が決着を通知 -> 相手の結果の裏返しで自分も即終了（両機同時終了）
    if (flags & GAME_PKT_FLAG_GAMEOVER) {
        const rc = (flags & GAME_PKT_RESULT_MASK) >> GAME_PKT_RESULT_SHIFT;
        if (G.state !== GAME_STATE_RESULT) {
            if (rc === GAME_RES_WIN) G.result = GAME_RESULT_LOSE;
            else if (rc === GAME_RES_LOSE) G.result = GAME_RESULT_WIN;
            else G.result = GAME_RESULT_DRAW;
            stateEnter(GAME_STATE_RESULT);
        }
    }
}

// ============================================================================
// パケット送信（send_input_packet を写像, 30-60Hz）
// ============================================================================
let _testSendHook = null; // テスト時のみ注入される送信フック（ブラウザでは null）

function sendInputPacket() {
    // ブラウザ: encoderNode 経由で送出。テスト: _testSendHook 経由でキャプチャ。
    if (!encoderNode && !_testSendHook) return;

    let flags = 0;
    let data2 = G.local.y & 0xFF; // 既定はY。hit時のみダメージ量に差替。

    if (G.pendingFire) {
        flags |= GAME_PKT_FLAG_FIRE;
        G.pendingFire = false;
    }
    if (G.pendingCfire) {
        flags |= GAME_PKT_FLAG_CFIRE;
        G.pendingCfire = false;
    }
    if (G.pendingHit) {
        flags |= GAME_PKT_FLAG_HIT; // 自機被弾を通知。data2 にダメージ量。
        data2 = (G.pendingHitDmg ? G.pendingHitDmg : 1) & 0xFF;
        G.pendingHit = false;
        G.pendingHitDmg = 0;
    }
    if (G.pendingGameover) {
        flags |= GAME_PKT_FLAG_GAMEOVER;
        flags |= (G.myResultCode << GAME_PKT_RESULT_SHIFT) & GAME_PKT_RESULT_MASK;
        // gameover は届くまで送り続けるため pending はここでクリアしない。
    }

    const pkt = [
        flags & 0xFF,
        G.local.x & 0xFF,
        data2 & 0xFF,
        G.txSeq & 0xFF,
    ];
    G.txSeq = (G.txSeq + 1) & 0xFF;

    if (_testSendHook) {
        _testSendHook(pkt);
        return;
    }
    // ゲームパケット(4バイト)を PCM トランスポートのペイロードとして送出。
    // worklet 側が Seq/Len/CRC の搬送フレーミングを付与する。
    encoderNode.port.postMessage({ type: 'send', frame: pkt });
}

// ============================================================================
// 弾移動と当たり判定（update_bullets_and_collisions を写像）
// ============================================================================
function updateBulletsAndCollisions() {
    // --- 自弾を移動し、相手機への命中を判定（表示の見栄え用） ---
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        const b = G.local.bullets[i];
        if (!b.active) continue;
        b.y += b.vy;
        if (b.y < 0 || b.y >= GAME_FIELD_H) {
            b.active = false;
            continue;
        }
        // 相手への加点は相手からの HIT 通知で行う。ここでは弾を消すだけ
        // （チャージ弾は貫通するので消さない）。
        if (G.remote.alive && bulletHitsShip(b, G.remote)) {
            if (!b.charged) b.active = false;
        }
    }

    // --- 相手弾を移動し、自機への命中を判定（被弾の権威=自分） ---
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        const b = G.remote.bullets[i];
        if (!b.active) continue;
        b.y += b.vy;
        if (b.y < 0 || b.y >= GAME_FIELD_H) {
            b.active = false;
            continue;
        }
        if (G.local.alive && bulletHitsShip(b, G.local)) {
            const dmg = b.damage ? b.damage : 1;
            if (!b.charged) b.active = false; // 通常弾は消す、チャージ弾は貫通
            const before = G.local.hp;
            if (G.local.hp > dmg) G.local.hp -= dmg;
            else G.local.hp = 0;
            if (before !== G.local.hp) {
                const applied = before - G.local.hp;
                G.pendingHit = true;
                G.pendingHitDmg = applied;
            }
            if (G.local.hp === 0) G.local.alive = false;
        }
    }
}

// ============================================================================
// 勝敗判定（check_result を写像）
// ============================================================================
function checkResult() {
    let finished = false;

    if (!G.local.alive) {
        // 自分がやられた。相手も倒していれば引き分け(相打ち)。
        G.result = (G.local.score >= GAME_WIN_SCORE) ? GAME_RESULT_DRAW
                                                     : GAME_RESULT_LOSE;
        finished = true;
    } else if (G.local.score >= GAME_WIN_SCORE) {
        G.result = GAME_RESULT_WIN;
        finished = true;
    } else if (G.nowMs - G.stateEnterMs >= GAME_TIME_LIMIT_MS) {
        // 時間切れ: 与ダメ(my_hits) vs 被ダメ(opp_hits) で判定
        const myHits = G.local.score;
        const oppHits = GAME_MAX_HP - G.local.hp;
        if (myHits > oppHits) G.result = GAME_RESULT_WIN;
        else if (myHits < oppHits) G.result = GAME_RESULT_LOSE;
        else G.result = GAME_RESULT_DRAW;
        finished = true;
    }

    if (finished) {
        // 決着を相手へ通知（両機同時終了）。結果コードをエンコード。
        G.pendingGameover = true;
        G.myResultCode = (G.result === GAME_RESULT_WIN) ? GAME_RES_WIN
                       : (G.result === GAME_RESULT_LOSE) ? GAME_RES_LOSE
                                                         : GAME_RES_DRAW;
        stateEnter(GAME_STATE_RESULT);
    }
}

// ============================================================================
// tick: 状態機械の駆動（game_shooter_tick を写像）
// ============================================================================
function gameTick(nowMs) {
    if (!G.initialized) return;
    G.nowMs = nowMs;

    switch (G.state) {
        case GAME_STATE_MATCHING:
            // 相手からの最初のパケット受信で接続確立 -> COUNTDOWN
            if (G.haveRx) {
                stateEnter(GAME_STATE_COUNTDOWN);
            }
            // MATCHING 中も自機情報を送り続け、相手の MATCHING を確立させる
            break;

        case GAME_STATE_COUNTDOWN:
            if (nowMs - G.stateEnterMs >= GAME_COUNTDOWN_MS) {
                stateEnter(GAME_STATE_PLAYING);
            }
            break;

        case GAME_STATE_PLAYING: {
            // 操作: 押している間ためる。離した瞬間に発射。
            if (G.local.alive) {
                const touchNow = G.touching;

                if (touchNow && !G.prevTouching) {
                    // 押し始め: ため開始
                    G.chargeStartMs = G.nowMs;
                    G.chargeLevel = 0;
                } else if (touchNow && G.prevTouching) {
                    // 押し続け: ため量を更新
                    const held = G.nowMs - G.chargeStartMs;
                    G.chargeLevel = (held >= GAME_CHARGE_FULL_MS) ? 2
                                  : (held >= GAME_CHARGE_MIN_MS) ? 1 : 0;
                } else if (!touchNow && G.prevTouching) {
                    // 離した瞬間: 発射。ため量で小弾/大弾を決める。
                    const held = G.nowMs - G.chargeStartMs;
                    if (held >= GAME_CHARGE_FULL_MS) {
                        spawnBulletEx(G.local, G.isP1, /*big=*/true);
                        G.pendingCfire = true;
                    } else {
                        spawnBulletEx(G.local, G.isP1, /*big=*/false);
                        G.pendingFire = true;
                    }
                    G.chargeLevel = 0;
                }
                if (!touchNow) G.chargeLevel = 0;
            }
            G.prevTouching = G.touching;

            updateBulletsAndCollisions();
            checkResult();
            break;
        }

        case GAME_STATE_RESULT:
            break;
    }

    // 送信レート制御（30-60Hz）。MATCHING/COUNTDOWN/PLAYING では常時送信し、
    // RESULT 中も pending_gameover があれば送り続ける（両機を確実に終了させる）。
    // 初回tickは無条件で送信し、相手の MATCHING を即座に確立させる。
    const shouldSend = (G.state !== GAME_STATE_RESULT) || G.pendingGameover;
    if (shouldSend) {
        if (!G.everSent || nowMs - G.lastSendMs >= GAME_SEND_INTERVAL_MS) {
            sendInputPacket();
            G.lastSendMs = nowMs;
            G.everSent = true;
        }
    }
}

// ============================================================================
// 視点反転（view_phys_y を写像）。ブラウザは P2 なので盤面を上下反転。
//   logical_y (0..GAME_FIELD_H) -> physical LCD y (0..LCD_H)
// ============================================================================
function viewPhysY(logicalY, hLog) {
    if (G.isP1) {
        return logicalY * SCALE_Y;
    }
    const flipped = (GAME_FIELD_H - (logicalY + hLog));
    return flipped * SCALE_Y;
}

// ============================================================================
// 描画（Canvas。firmware game_shooter_render を写像）
// ============================================================================
const _hasDOM = (typeof document !== 'undefined');
const gameCanvas = _hasDOM ? document.getElementById('gameCanvas') : null;
const gctx = gameCanvas ? gameCanvas.getContext('2d') : null;

const COL_BG = '#05050a';
const COL_YOU = '#00d466';       // 自機 ため0 (緑)
const COL_YOU_CHG1 = '#ffe000';  // 自機 ため1 (黄)
const COL_YOU_CHG2 = '#00d4aa';  // 自機 ため2 (シアン)
const COL_ENEMY = '#ff5050';     // 相手機 (赤)
const COL_BULLET_S = '#ffe000';  // 自弾 小 (黄)
const COL_BULLET_B = '#00d4aa';  // 自弾 大 (シアン)
const COL_EBULLET_S = '#ff5050'; // 相手弾 小 (赤)
const COL_EBULLET_B = '#ff40ff'; // 相手弾 大 (マゼンタ)
const COL_TEXT = '#e0e0e0';
const COL_CYAN = '#00d4aa';

function drawShipRect(x, y, w, h, color) {
    gctx.fillStyle = color;
    gctx.fillRect(x, y, w, h);
}

function drawShip(s, color) {
    if (!s.alive) return;
    drawShipRect(s.x * SCALE_X, viewPhysY(s.y, GAME_SHIP_H),
                 GAME_SHIP_W * SCALE_X, GAME_SHIP_H * SCALE_Y, color);
}

function drawBullets(s, colorSmall, colorBig) {
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        const b = s.bullets[i];
        if (!b.active) continue;
        const bw = b.charged ? 6 : 2;
        const bh = b.charged ? 5 : 3;
        gctx.fillStyle = b.charged ? colorBig : colorSmall;
        gctx.fillRect((b.x - Math.floor(bw / 2)) * SCALE_X, viewPhysY(b.y, bh),
                      bw * SCALE_X, bh * SCALE_Y);
    }
}

function centerText(text, y, color, font) {
    gctx.fillStyle = color;
    gctx.font = font || 'bold 28px sans-serif';
    gctx.textAlign = 'center';
    gctx.textBaseline = 'middle';
    gctx.fillText(text, LCD_W / 2, y);
    gctx.textAlign = 'left';
    gctx.textBaseline = 'alphabetic';
}

function gameRender() {
    if (!gctx) return;
    if (!G.initialized) {
        gctx.fillStyle = COL_BG;
        gctx.fillRect(0, 0, LCD_W, LCD_H);
        centerText('CONNECT to start', LCD_H / 2, COL_TEXT, 'bold 18px sans-serif');
        return;
    }

    switch (G.state) {
        case GAME_STATE_MATCHING:
            gctx.fillStyle = COL_BG;
            gctx.fillRect(0, 0, LCD_W, LCD_H);
            centerText('MATCHING...', 40, COL_CYAN, 'bold 22px sans-serif');
            centerText('Waiting for opponent', 66, COL_TEXT, '13px sans-serif');
            gctx.fillStyle = COL_YOU;
            gctx.font = '13px sans-serif';
            gctx.textAlign = 'center';
            gctx.fillText('HOLD+SWIPE = move', LCD_W / 2, 108);
            gctx.fillStyle = COL_YOU_CHG1;
            gctx.fillText('hold longer = charge', LCD_W / 2, 130);
            gctx.fillStyle = COL_CYAN;
            gctx.fillText('RELEASE = FIRE!', LCD_W / 2, 152);
            gctx.fillStyle = COL_EBULLET_B;
            gctx.fillText('long hold = BIG (dmg 3)', LCD_W / 2, 174);
            gctx.textAlign = 'left';
            break;

        case GAME_STATE_COUNTDOWN: {
            gctx.fillStyle = COL_BG;
            gctx.fillRect(0, 0, LCD_W, LCD_H);
            const elapsed = G.nowMs - G.stateEnterMs;
            let count = 3 - Math.floor(elapsed / 1000);
            if (count < 1) count = 1;
            centerText(String(count), LCD_H / 2, '#ffe000', 'bold 72px sans-serif');
            break;
        }

        case GAME_STATE_PLAYING: {
            gctx.fillStyle = COL_BG;
            gctx.fillRect(0, 0, LCD_W, LCD_H);

            // HP / HIT 表示
            gctx.fillStyle = COL_TEXT;
            gctx.font = 'bold 14px monospace';
            gctx.textAlign = 'left';
            gctx.textBaseline = 'top';
            gctx.fillText('HP:' + G.local.hp + '  HIT:' + G.local.score, 6, 4);
            gctx.textBaseline = 'alphabetic';

            // 相手弾 (赤/マゼンタ) と自弾 (黄/シアン)
            drawBullets(G.remote, COL_EBULLET_S, COL_EBULLET_B);
            drawBullets(G.local, COL_BULLET_S, COL_BULLET_B);

            // 相手機 (赤, 画面奥=上)
            drawShip(G.remote, COL_ENEMY);

            // 自機 (手前=下)。ため段階で色替え。
            const shipColor = (G.chargeLevel >= 2) ? COL_YOU_CHG2
                            : (G.chargeLevel === 1) ? COL_YOU_CHG1 : COL_YOU;
            drawShip(G.local, shipColor);
            break;
        }

        case GAME_STATE_RESULT:
            gctx.fillStyle = COL_BG;
            gctx.fillRect(0, 0, LCD_W, LCD_H);
            if (G.result === GAME_RESULT_WIN) {
                centerText('YOU WIN!', LCD_H / 2, COL_YOU, 'bold 36px sans-serif');
            } else if (G.result === GAME_RESULT_LOSE) {
                centerText('YOU LOSE', LCD_H / 2, COL_ENEMY, 'bold 36px sans-serif');
            } else {
                centerText('DRAW', LCD_H / 2, '#ffe000', 'bold 36px sans-serif');
            }
            break;
    }
}

// ============================================================================
// HUD 更新（スコア/状態ラベル）
// ============================================================================
const scoreYouEl = _hasDOM ? document.getElementById('scoreYou') : null;
const scoreEnemyEl = _hasDOM ? document.getElementById('scoreEnemy') : null;
const stateLabelEl = _hasDOM ? document.getElementById('stateLabel') : null;

const STATE_NAMES = ['MATCHING', 'COUNTDOWN', 'PLAYING', 'RESULT'];

function updateHud() {
    if (!scoreYouEl) return;
    // YOU 側は残HP、CoreS3 側は自分が与えたダメージ数 (HIT)
    scoreYouEl.textContent = 'HP ' + G.local.hp;
    scoreEnemyEl.textContent = 'HIT ' + G.local.score;
    stateLabelEl.textContent = STATE_NAMES[G.state] || '--';
}

// ============================================================================
// 入力: タッチ / マウス（バーチャルスティック: 押して移動＆ため, 離して発射）
//   物理タッチX は 0..LCD_W-1 (0..319) 空間へ写像し firmware の SCALE_X 除算に合わせる。
// ============================================================================
let touchPhysX = Math.floor((LCD_W - 1) / 2); // 物理タッチX (0..319)
let touching = false;                          // 今タッチしているか

// Canvas 表示座標 (CSS px) -> 物理LCD X (0..LCD_W-1)
function canvasToPhysX(e) {
    const rect = gameCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let px = ((clientX - rect.left) / rect.width) * LCD_W;
    return clampI(Math.round(px), 0, LCD_W - 1);
}

if (gameCanvas) {
    gameCanvas.addEventListener('mousedown', (e) => {
        touching = true;
        touchPhysX = canvasToPhysX(e);
    });
    gameCanvas.addEventListener('mousemove', (e) => {
        if (touching) touchPhysX = canvasToPhysX(e);
    });
    window.addEventListener('mouseup', () => { touching = false; });

    gameCanvas.addEventListener('touchstart', (e) => {
        e.preventDefault();
        touching = true;
        touchPhysX = canvasToPhysX(e);
    }, { passive: false });
    gameCanvas.addEventListener('touchmove', (e) => {
        e.preventDefault();
        if (touching) touchPhysX = canvasToPhysX(e);
    }, { passive: false });
    gameCanvas.addEventListener('touchend', (e) => {
        e.preventDefault();
        touching = false;
    }, { passive: false });
    gameCanvas.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        touching = false;
    }, { passive: false });
}

// ============================================================================
// メインループ（50Hz）: 入力反映 -> tick(送信/弾/判定) -> 描画
// ============================================================================
let loopTimer = null;
let loopStartMs = 0;

function loopStep() {
    const now = (performance.now() - loopStartMs) | 0;

    // fire 引数 = 「今タッチしているか」。移動＆ため＆離しはコア側で処理。
    gameOnInput(touchPhysX, 0, touching);

    gameTick(now);
    gameRender();
    updateHud();
}

function startLoop() {
    if (loopTimer) return;
    loopStartMs = performance.now();
    gameInit();
    loopTimer = setInterval(loopStep, GAME_TICK_INTERVAL_MS);
}

function stopLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
}

// 未接続時も盤面を1回描画
gameRender();

// ============================================================================
// Audio / PCM トランスポート接続（paint.js の connect パターンを自己完結で流用）
//   - getUserMedia: echoCancellation/noiseSuppression/autoGainControl=false
//   - USB マイク検出（label / groupId マッチ）
//   - PCM worklet（pcm-encoder-processor / pcm-decoder-processor）
// ============================================================================
let audioContext = null;
let encoderNode = null;
let decoderNode = null;
let mediaStream = null;
let isConnected = false;

const statusDot = _hasDOM ? document.getElementById('statusDot') : null;
const statusText = _hasDOM ? document.getElementById('statusText') : null;
const btnConnect = _hasDOM ? document.getElementById('btnConnect') : null;
const logEl = _hasDOM ? document.getElementById('log') : null;
const outputSelect = _hasDOM ? document.getElementById('outputSelect') : null;

function setLog(msg) { if (logEl) logEl.textContent = msg; }

// 出力デバイス列挙（paint.js 流用）
async function enumerateOutputs() {
    if (!outputSelect) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput');
        outputSelect.innerHTML = '<option value="">-- Default output --</option>';
        outputs.forEach((d, i) => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.textContent = d.label || `Output ${i + 1}`;
            outputSelect.appendChild(opt);
        });
    } catch (e) { /* ignore */ }
}
if (_hasDOM) enumerateOutputs();

if (_hasDOM && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
        console.log('[DEVICE] Audio device changed, re-enumerating...');
        enumerateOutputs();
    });
}

// PCM worklet の読み込み・ノード生成・配線（paint.js setupTransport の PCM 部を流用）
async function setupTransport() {
    // Encoder (TX)
    await audioContext.audioWorklet.addModule('pcm-encoder-worklet.js');
    encoderNode = new AudioWorkletNode(audioContext, 'pcm-encoder-processor', { outputChannelCount: [1] });
    encoderNode.port.onmessage = (e) => {
        // tx_start / tx_done はデバッグログのみ
    };
    encoderNode.connect(audioContext.destination);

    // Decoder (RX)
    if (mediaStream) {
        await audioContext.audioWorklet.addModule('pcm-decoder-worklet.js');
        decoderNode = new AudioWorkletNode(audioContext, 'pcm-decoder-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        decoderNode.port.onmessage = (e) => handleRx(e.data);
        const source = audioContext.createMediaStreamSource(mediaStream);
        source.connect(decoderNode);
        console.log('[RX] Decoder connected (pcm)');
    }
}

async function connect() {
    if (isConnected) { disconnect(); return; }
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        if (audioContext.state === 'suspended') await audioContext.resume();

        // 出力デバイス設定
        const selectedOutput = outputSelect.value;
        if (selectedOutput && audioContext.setSinkId) {
            try { await audioContext.setSinkId(selectedOutput); }
            catch (e) { console.warn('setSinkId failed:', e); }
        }

        // マイク取得（送受信両対応。失敗時は送信専用）
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            tempStream.getTracks().forEach(t => t.stop());
            await new Promise(r => setTimeout(r, 300));

            let micDeviceId = undefined;
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const inputs = devices.filter(d => d.kind === 'audioinput');
                const usbMic = inputs.find(d => d.label.toLowerCase().includes('usb') || d.label.includes('uac') || d.label.includes('303a') || d.label.includes('ヘッドセット'));
                if (usbMic) {
                    micDeviceId = usbMic.deviceId;
                    console.log('[RX] Using USB mic:', usbMic.label);
                } else if (inputs.length > 0) {
                    const outDev = devices.find(d => d.deviceId === selectedOutput);
                    if (outDev && outDev.groupId) {
                        const matched = inputs.find(d => d.groupId === outDev.groupId);
                        if (matched) { micDeviceId = matched.deviceId; console.log('[RX] Matched input by groupId:', matched.label); }
                    }
                    if (!micDeviceId && inputs.length === 1) {
                        console.log('[RX] Only one input, using it:', inputs[0].label);
                    }
                }
            } catch (enumErr) {
                console.warn('[RX] Device enumeration failed:', enumErr);
            }

            const constraints = {
                audio: {
                    sampleRate: 48000,
                    channelCount: 1,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    ...(micDeviceId ? { deviceId: { exact: micDeviceId } } : {})
                }
            };
            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            const audioTrack = mediaStream.getAudioTracks()[0];
            const micLabel = audioTrack ? audioTrack.label : 'unknown';
            setLog('🎤 ' + micLabel);
        } catch (rxErr) {
            console.warn('[RX] Mic acquisition failed (send-only mode):', rxErr.message);
            mediaStream = null;
        }

        await setupTransport();

        isConnected = true;
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        btnConnect.textContent = '🔌 Disconnect';
        btnConnect.classList.add('connected');

        // ゲームループ開始（接続後）
        startLoop();
        setLog('Connected (PCM). HOLD+SWIPE to move, RELEASE to fire!');
    } catch (err) {
        setLog('Error: ' + err.message);
        disconnect();
    }
}

function disconnect() {
    stopLoop();
    if (encoderNode) { encoderNode.disconnect(); encoderNode = null; }
    if (decoderNode) { decoderNode.disconnect(); decoderNode = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    isConnected = false;
    statusDot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    btnConnect.textContent = '🎤 Connect';
    btnConnect.classList.remove('connected');
    gameRender();
}

if (btnConnect) btnConnect.addEventListener('click', connect);

// ============================================================================
// 受信ハンドラ: decoder の {type:'frame'} からゲームパケット(4バイト)を取り出す
// ============================================================================
function handleRx(data) {
    if (!data) return;
    if (data.type === 'frame') {
        const payload = data.payload; // Uint8Array (ゲームパケット 4バイト)
        if (payload && payload.length >= GAME_PKT_LEN) {
            gameOnRx(payload);
        }
    }
    // crc_error / stats は本ゲームでは無視（デバッグはコンソールで）
}

// ============================================================================
// テスト用エクスポート（Node からロジックを検証するため。ブラウザでは無害）
// ============================================================================
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        // constants
        GAME_FIELD_W, GAME_FIELD_H, GAME_SHIP_W, GAME_SHIP_H,
        GAME_MAX_BULLETS, GAME_SMALL_SPEED, GAME_BIG_SPEED,
        GAME_MAX_HP, GAME_WIN_SCORE,
        GAME_SMALL_DAMAGE, GAME_BIG_DAMAGE,
        GAME_MOVE_SENS_PCT, GAME_CHARGE_MIN_MS, GAME_CHARGE_FULL_MS,
        GAME_PKT_LEN,
        GAME_PKT_FLAG_FIRE, GAME_PKT_FLAG_HIT, GAME_PKT_FLAG_CFIRE,
        GAME_PKT_FLAG_GAMEOVER, GAME_PKT_RESULT_SHIFT, GAME_PKT_RESULT_MASK,
        GAME_RES_WIN, GAME_RES_LOSE, GAME_RES_DRAW,
        GAME_COUNTDOWN_MS, GAME_TIME_LIMIT_MS, GAME_SEND_INTERVAL_MS,
        SCALE_X, SCALE_Y, LCD_W, LCD_H,
        GAME_STATE_MATCHING, GAME_STATE_COUNTDOWN, GAME_STATE_PLAYING, GAME_STATE_RESULT,
        GAME_RESULT_NONE, GAME_RESULT_WIN, GAME_RESULT_LOSE, GAME_RESULT_DRAW,
        // pure helpers
        seqIsNewer, clampI, bulletHitsShip, viewPhysY,
        // engine (operate on module-level G; a captured-send hook is injected for tests)
        G, gameInit, gameOnInput, gameOnRx, gameTick,
        _setSendHook(fn) { _testSendHook = fn; },
    };
}
