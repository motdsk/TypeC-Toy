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
// 連続プレイ: RESULT をこの時間表示したら自動で次戦(MATCHING)へ戻る（firmware と一致）。
const GAME_RESULT_HOLD_MS = 4000;
const GAME_SEND_INTERVAL_MS = 40;        // 送信 25Hz（PCM搬送の詰まり回避。firmwareと一致）
const GAME_TICK_INTERVAL_MS = 20;        // ローカルループは 50Hz 維持（描画・入力は滑らかに）
const GAME_TICK_BASE_MS = 20;            // 弾速の基準周期。弾移動は経過時間/この値のステップ数ぶん進める（firmwareと一致、tick頻度非依存で実速度一定）

const GAME_MOVE_SENS_PCT = 70;
const GAME_CHARGE_MIN_MS = 450;
const GAME_CHARGE_FULL_MS = 1100;
const GAME_SMALL_DAMAGE = 1;
const GAME_BIG_DAMAGE = 3;
const GAME_FIRE_LOCKOUT_MS = 250;

// 状態同期パケット（6バイト。firmware game_shooter.h と一致）
//   [0]x [1]y [2]fire_cnt(bit0-6=累積7bit,bit7=大弾) [3]hp [4]flags [5]seq
const GAME_PKT_LEN = 6;
const GAME_PKT_X = 0;
const GAME_PKT_Y = 1;
const GAME_PKT_FIRECNT = 2;
const GAME_PKT_HP = 3;
const GAME_PKT_FLAGS = 4;
const GAME_PKT_SEQ = 5;
const GAME_PKT_FIRE_BIG_BIT = 0x80;
const GAME_PKT_FIRE_CNT_MASK = 0x7F;
const GAME_PKT_FLAG_GAMEOVER = 0x01;
const GAME_PKT_RESULT_SHIFT = 1;
const GAME_PKT_RESULT_MASK = 0x06;
const GAME_PKT_FLAG_CHARGING = 0x08;

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
    // 状態同期: 発射は累積カウンタで送る（欠落耐性）
    fireCount: 0,
    lastFireBig: false,
    lastRxFireCnt: 0,
    rxFireInit: false,
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
    if (st === GAME_STATE_PLAYING) {
        // 弾移動の経過時間基準をリセット(カウントダウン分を持ち込まない)
        G.lastTickMs = G.nowMs;
        G.stepAccMs = 0;
    }
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
    G.fireCount = 0;
    G.lastFireBig = false;
    G.lastRxFireCnt = 0;
    G.rxFireInit = false;
    G.pendingGameover = false;
    G.myResultCode = 0;
    G.nowMs = 0;
    G.lastSendMs = 0;
    G.everSent = false;
    G.stateEnterMs = 0;
    G.lastTickMs = 0;    // 経過時間ベース弾移動用
    G.stepAccMs = 0;

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
// 連続プレイ用リスタート（firmware game_restart を写像）
//   通信路(worklet)は維持したまま、ゲーム状態だけ作り直して MATCHING へ戻す。
//   txSeq は継続させ(相手の newest-wins を壊さない)、haveRx をリセットして
//   新ゲームの最初のパケットで再マッチングする。nowMs/lastSendMs は維持。
// ============================================================================
function gameRestart() {
    const keepTxSeq = G.txSeq;
    const keepNow = G.nowMs;
    resetShip(G.local, IS_PLAYER_ONE);
    resetShip(G.remote, !IS_PLAYER_ONE);
    G.homeY = IS_PLAYER_ONE ? (GAME_FIELD_H - GAME_SHIP_H - 4) : 4;
    G.result = GAME_RESULT_NONE;
    G.prevFire = false;
    G.lastRxSeq = 0;
    G.haveRx = false;
    G.fireCount = 0;
    G.lastFireBig = false;
    G.lastRxFireCnt = 0;
    G.rxFireInit = false;
    G.pendingGameover = false;
    G.myResultCode = 0;
    G.txSeq = keepTxSeq;      // seq は継続
    G.nowMs = keepNow;
    G.lastSendMs = 0;
    G.everSent = false;
    G.lastTickMs = 0;
    G.stepAccMs = 0;
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

    const rxX = data[GAME_PKT_X];
    const rxY = data[GAME_PKT_Y];
    const fireCntRaw = data[GAME_PKT_FIRECNT];
    const rxHp = data[GAME_PKT_HP];
    const flags = data[GAME_PKT_FLAGS];
    const rxSeq = data[GAME_PKT_SEQ];

    const fireCnt = fireCntRaw & GAME_PKT_FIRE_CNT_MASK;
    const fireBig = (fireCntRaw & GAME_PKT_FIRE_BIG_BIT) !== 0;

    if (!G.haveRx) {
        // MATCHING 確立: 最初の受信は無条件採用。発射カウンタ基準も取得。
        G.haveRx = true;
        G.lastRxSeq = rxSeq;
        G.lastRxFireCnt = fireCnt;
        G.rxFireInit = true;
    } else {
        // 古い/重複は破棄。状態同期なので破棄してもずれない。
        if (!seqIsNewer(rxSeq, G.lastRxSeq)) return;
        G.lastRxSeq = rxSeq;
    }

    // 相手機の位置更新（絶対座標。欠落しても最新で復帰）
    G.remote.x = clampI(rxX, 0, GAME_FIELD_W - GAME_SHIP_W);
    G.remote.y = clampI(rxY, 0, GAME_FIELD_H - GAME_SHIP_H);

    // 発射: 累積カウンタの差分だけスポーン（欠落補償）
    let diff = (fireCnt - G.lastRxFireCnt) & GAME_PKT_FIRE_CNT_MASK;
    if (diff > 0) {
        if (diff > GAME_MAX_BULLETS) diff = GAME_MAX_BULLETS;
        for (let k = 0; k < diff; k++) {
            const big = (k === diff - 1) ? fireBig : false;
            spawnBulletEx(G.remote, !G.isP1, big);
        }
        G.lastRxFireCnt = fireCnt;
    }

    // 与ダメージ(score): 相手HP現在値から直接算出（ずれない）
    const oppHp = (rxHp <= GAME_MAX_HP) ? rxHp : GAME_MAX_HP;
    const myScore = GAME_MAX_HP - oppHp;
    if (myScore > G.local.score) G.local.score = myScore; // 単調増加
    G.remote.hp = oppHp;
    G.remote.alive = (oppHp > 0);

    // 相手が決着を通知 -> 相手の結果の裏返しで自分も即終了（両機同時終了）
    if (flags & GAME_PKT_FLAG_GAMEOVER) {
        const rc = (flags & GAME_PKT_RESULT_MASK) >> GAME_PKT_RESULT_SHIFT;
        // GAMEOVER は対戦中(PLAYING/COUNTDOWN)のみ受理。RESULT 中や、連続プレイで
        // 再 MATCHING に戻った直後に相手の「古い GAMEOVER」が届いても、新ゲームを
        // いきなり終了させない（firmware と対称）。
        if (G.state === GAME_STATE_PLAYING || G.state === GAME_STATE_COUNTDOWN) {
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
    // 発射累積カウンタ: 下位7bit + 大弾フラグ(bit7)
    let fireByte = G.fireCount & GAME_PKT_FIRE_CNT_MASK;
    if (G.lastFireBig) fireByte |= GAME_PKT_FIRE_BIG_BIT;

    if (G.chargeLevel > 0) flags |= GAME_PKT_FLAG_CHARGING;

    if (G.pendingGameover) {
        flags |= GAME_PKT_FLAG_GAMEOVER;
        flags |= (G.myResultCode << GAME_PKT_RESULT_SHIFT) & GAME_PKT_RESULT_MASK;
        // gameover は届くまで送り続けるため pending はクリアしない。
    }

    const pkt = [
        G.local.x & 0xFF,          // [0] x
        G.local.y & 0xFF,          // [1] y
        fireByte & 0xFF,           // [2] fire_cnt
        G.local.hp & 0xFF,         // [3] hp (相手が score 算出に使う)
        flags & 0xFF,              // [4] flags
        G.txSeq & 0xFF,            // [5] seq
    ];
    G.txSeq = (G.txSeq + 1) & 0xFF;

    if (_testSendHook) {
        _testSendHook(pkt);
        return;
    }
    // 状態同期パケット(6バイト)を PCM トランスポートで送出。
    // 全パケットが「現在の状態」なので最新優先でよい（古いものは捨てて問題なし）。
    // worklet 側が Seq/Len/CRC の搬送フレーミングを付与する。
    encoderNode.port.postMessage({ type: 'send', frame: pkt });
}

// ============================================================================
// 弾移動と当たり判定（update_bullets_and_collisions を写像）
// ============================================================================
// 弾を steps ステップ分進める（1ステップ=基準周期ぶんの移動）。衝突は各ステップで
// 判定し、速い弾/大ステップでのすり抜けを防ぐ。firmware と同一ロジック。
function updateBulletsAndCollisions(steps) {
  for (let st = 0; st < steps; st++) {
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
            // 状態同期: 自HPを減らすだけ。相手は send の自HP現在値から
            // score = MAX_HP - 自HP で復元する（被弾イベント通知は不要）。
            if (G.local.hp > dmg) G.local.hp -= dmg;
            else G.local.hp = 0;
            if (G.local.hp === 0) G.local.alive = false;
        }
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
                    const big = (held >= GAME_CHARGE_FULL_MS);
                    spawnBulletEx(G.local, G.isP1, big);
                    // 状態同期: 発射累積カウンタを進める。相手は差分でスポーン。
                    G.fireCount = (G.fireCount + 1) & GAME_PKT_FIRE_CNT_MASK;
                    G.lastFireBig = big;
                    G.chargeLevel = 0;
                }
                if (!touchNow) G.chargeLevel = 0;
            }
            G.prevTouching = G.touching;

            // 経過時間ベースで弾を進める（firmware と同一）。前回tickからのΔmsを
            // 蓄積し、基準周期ごとに1ステップ消化。tick頻度に依存せず実速度一定。
            {
                let dt = (G.lastTickMs === 0) ? GAME_TICK_BASE_MS : (nowMs - G.lastTickMs);
                if (dt > 200) dt = 200;  // 一時停止/初回の暴走防止
                G.stepAccMs += dt;
                const steps = Math.floor(G.stepAccMs / GAME_TICK_BASE_MS);
                G.stepAccMs -= steps * GAME_TICK_BASE_MS;
                updateBulletsAndCollisions(steps);
            }
            checkResult();
            break;
        }

        case GAME_STATE_RESULT:
            // 連続プレイ: 一定時間 RESULT を見せたら自動で次戦へ戻る（firmware と対称）。
            if (nowMs - G.stateEnterMs >= GAME_RESULT_HOLD_MS) {
                gameRestart();
            }
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
    G.lastTickMs = nowMs;   // 次tickの経過時間計算用
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

// ============================================================================
// スプライト（インベーダー風ドット絵）。11列×8行のビットマップ（文字列で定義）。
// 自機は砲台/宇宙船、敵機はインベーダー。論理機体サイズ 12x10 の枠に収める。
// 各行の '1' を1ドットとして fillRect で拡大描画する。
// ============================================================================
const SPRITE_W = 11, SPRITE_H = 8;

// 自機（下向きに構える砲台/シップ）
const SPRITE_SHIP = [
    '00000100000',
    '00000100000',
    '00001110000',
    '00011111000',
    '01111111110',
    '11111111111',
    '11011111011',
    '10000000001',
];

// 敵機（インベーダー）: 2枚のアニメーションフレーム（脚パタパタ）
const SPRITE_INVADER_A = [
    '00100000100',
    '00010001000',
    '00111111100',
    '01101110110',
    '11111111111',
    '10111111101',
    '10100000101',
    '00011011000',
];
const SPRITE_INVADER_B = [
    '00100000100',
    '10010001001',
    '10111111101',
    '11101110111',
    '11111111111',
    '01111111110',
    '00100000100',
    '01000000010',
];

// 論理機体(12x10)の中にスプライト(11x8)を中央寄せして描く。
// 1ドット = dotW x dotH の矩形（物理px）。
function drawSprite(rows, logicalX, logicalY, color) {
    const originPhysX = logicalX * SCALE_X;
    const originPhysY = viewPhysY(logicalY, GAME_SHIP_H);
    // 機体枠(12x10論理 -> 24x20物理)にスプライト11x8を収める。ドットサイズを算出。
    const dotW = (GAME_SHIP_W * SCALE_X) / SPRITE_W;   // ~2.18
    const dotH = (GAME_SHIP_H * SCALE_Y) / SPRITE_H;   // ~2.5
    gctx.fillStyle = color;
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
            if (row[c] === '1') {
                gctx.fillRect(
                    Math.floor(originPhysX + c * dotW),
                    Math.floor(originPhysY + r * dotH),
                    Math.ceil(dotW), Math.ceil(dotH));
            }
        }
    }
}

// 敵機アニメーション用のフレームトグル（時間で切り替え）
function invaderFrame() {
    return (Math.floor(G.nowMs / 350) & 1) ? SPRITE_INVADER_B : SPRITE_INVADER_A;
}

function drawShip(s, color) {
    if (!s.alive) return;
    drawSprite(SPRITE_SHIP, s.x, s.y, color);
}

function drawEnemy(s, color) {
    if (!s.alive) return;
    drawSprite(invaderFrame(), s.x, s.y, color);
}

// 弾の描画。通常弾=縦長の弾（涙型っぽい楕円）、チャージ弾=大きい丸。
function drawBullets(s, colorSmall, colorBig) {
    for (let i = 0; i < GAME_MAX_BULLETS; i++) {
        const b = s.bullets[i];
        if (!b.active) continue;
        const cx = b.x * SCALE_X;
        const cy = viewPhysY(b.y, 1);
        if (b.charged) {
            // チャージ弾: 大きい丸（グロー付き）
            const r = 8;
            gctx.fillStyle = colorBig;
            gctx.beginPath();
            gctx.arc(cx, cy, r, 0, Math.PI * 2);
            gctx.fill();
            // 中心ハイライト
            gctx.fillStyle = '#ffffff';
            gctx.globalAlpha = 0.5;
            gctx.beginPath();
            gctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
            gctx.fill();
            gctx.globalAlpha = 1.0;
        } else {
            // 通常弾: 縦長の弾（楕円）
            gctx.fillStyle = colorSmall;
            gctx.beginPath();
            gctx.ellipse(cx, cy, 2.5, 6, 0, 0, Math.PI * 2);
            gctx.fill();
        }
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

            // 相手機 (インベーダー, 画面奥=上)
            drawEnemy(G.remote, COL_ENEMY);

            // 自機 (砲台/シップ, 手前=下)。ため段階で色替え。
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
// worklet はブラウザに強くキャッシュされ、ハードリロードでも古い版が残ることが
// ある。URL にビルド時刻のクエリを付けてキャッシュを確実に無効化する。
const _WL_VER = '?v=' + Date.now();

async function setupTransport() {
    // Encoder (TX)
    await audioContext.audioWorklet.addModule('pcm-encoder-worklet.js' + _WL_VER);
    encoderNode = new AudioWorkletNode(audioContext, 'pcm-encoder-processor', { outputChannelCount: [1] });
    let _txStarts = 0, _txDones = 0;
    encoderNode.port.onmessage = (e) => {
        // 送信の生存確認: tx_start/tx_done を数えて 1 秒ごとにログ。
        // ここが増えていれば「ブラウザは送出している」= 問題は経路/受信側。
        const t = e.data && e.data.type;
        if (t === 'tx_start') _txStarts++;
        else if (t === 'tx_done') _txDones++;
    };
    setInterval(() => {
        if (!encoderNode) return;
        console.log('[TX] pkt_started=' + _txStarts + ' pkt_done=' + _txDones);
    }, 1000);
    encoderNode.connect(audioContext.destination);

    // Decoder (RX)
    if (mediaStream) {
        await audioContext.audioWorklet.addModule('pcm-decoder-worklet.js' + _WL_VER);
        decoderNode = new AudioWorkletNode(audioContext, 'pcm-decoder-processor', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        decoderNode.port.onmessage = (e) => handleRx(e.data);
        const source = audioContext.createMediaStreamSource(mediaStream);
        source.connect(decoderNode);
        // デバッグ用フック: 双方向衝突の切り分けのため、CDP から受信(RX)だけを
        // 止められるようにする。window.__rxDisconnect() で decoder への入力を切り、
        // 送信(TX)はそのまま継続する。本番動作には影響しない。
        try {
            window.__rxSource = source;
            window.__rxDisconnect = () => { try { source.disconnect(); console.log('[DBG] RX disconnected (send-only)'); } catch (e) {} };
            window.__rxReconnect = () => { try { source.connect(decoderNode); console.log('[DBG] RX reconnected'); } catch (e) {} };
        } catch (e) {}
        console.log('[RX] Decoder connected (pcm)');
    }
}

async function connect() {
    if (isConnected) { disconnect(); return; }
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        if (audioContext.state === 'suspended') await audioContext.resume();

        // 出力デバイス設定。
        // 重要: ブラウザ(P2)の音は「スピーカ出力」として CoreS3 の UAC OUT に
        // 流し込む必要がある。出力先を CoreS3 に向けないと音は PC 既定スピーカへ
        // 流れ、CoreS3 側には 1 サンプルも届かず MATCHING から抜けられない
        // (実機画面の NZ=0 の状態)。出力先の選択を必須扱いにして警告する。
        const selectedOutput = outputSelect.value;
        const selectedOutputLabel = outputSelect.options[outputSelect.selectedIndex]
            ? outputSelect.options[outputSelect.selectedIndex].textContent : '';
        if (!selectedOutput) {
            console.warn('[TX] 出力先が未選択(既定出力)。CoreS3 に音が届かない可能性大。上の Output で CoreS3 を選択してください。');
            setLog('⚠ Output で CoreS3 を選んでから Connect してください');
        }
        if (!audioContext.setSinkId) {
            console.warn('[TX] このブラウザは AudioContext.setSinkId 非対応。OS の既定再生デバイスを CoreS3 にしてください。');
        }
        if (selectedOutput && audioContext.setSinkId) {
            try {
                await audioContext.setSinkId(selectedOutput);
                console.log('[TX] 出力先を設定:', selectedOutputLabel, '(sinkId=' + audioContext.sinkId + ')');
            } catch (e) {
                console.warn('[TX] setSinkId 失敗:', e);
                setLog('⚠ 出力先の設定に失敗: ' + (e && e.message ? e.message : e));
            }
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
    } else if (data.type === 'dbg') {
        // デコーダ process() の起動診断。hasInput=false / chLen=0 ならマイク未供給。
        console.log('[RX dbg] call=' + data.call + ' hasInput=' + data.hasInput + ' chLen=' + data.chLen);
    } else if (data.type === 'stats') {
        // 実機画面の NZ/SY/FR/CE/HI/PK 相当。ブラウザ側の受信健全性を可視化。
        console.log('[RX stats] SY=' + data.sync + ' FR=' + data.frames + ' CE=' + data.crcErrors +
            ' HI=' + data.hi + ' PK+=' + data.peakPos + ' PK-=' + data.peakNeg +
            ' runTop(len:count)=' + (data.runTop ? data.runTop.join(' ') : ''));
    } else if (data.type === 'crc_error') {
        // CRC不一致の詳細（ビットずれ診断用）。頻発するとノイズになるので簡潔に。
        console.log('[RX crc_err] len=' + data.payloadLen +
            ' first=' + JSON.stringify(data.firstBytes) +
            ' recv=' + data.received + ' exp=' + data.expected);
    }
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
        GAME_PKT_X, GAME_PKT_Y, GAME_PKT_FIRECNT, GAME_PKT_HP, GAME_PKT_FLAGS, GAME_PKT_SEQ,
        GAME_PKT_FIRE_BIG_BIT, GAME_PKT_FIRE_CNT_MASK,
        GAME_PKT_FLAG_GAMEOVER, GAME_PKT_RESULT_SHIFT, GAME_PKT_RESULT_MASK, GAME_PKT_FLAG_CHARGING,
        GAME_RES_WIN, GAME_RES_LOSE, GAME_RES_DRAW,
        GAME_COUNTDOWN_MS, GAME_TIME_LIMIT_MS, GAME_SEND_INTERVAL_MS,
        SCALE_X, SCALE_Y, LCD_W, LCD_H,
        GAME_STATE_MATCHING, GAME_STATE_COUNTDOWN, GAME_STATE_PLAYING, GAME_STATE_RESULT,
        GAME_RESULT_NONE, GAME_RESULT_WIN, GAME_RESULT_LOSE, GAME_RESULT_DRAW,
        // pure helpers
        seqIsNewer, clampI, bulletHitsShip, viewPhysY,
        // engine (operate on module-level G; a captured-send hook is injected for tests)
        G, gameInit, gameRestart, gameOnInput, gameOnRx, gameTick,
        GAME_RESULT_HOLD_MS,
        _setSendHook(fn) { _testSendHook = fn; },
    };
}
