/**
 * PCM Direct Transport Decoder AudioWorklet Processor
 *
 * ファームウェア typec_poc_idf/main/pcm_transport.c の受信側と *バイト互換* な
 * デコーダ。入力チャンネルの Float32 サンプルを int16 に復元し、Sync検出 →
 * バイト分解 → ステートマシン → CRC検証 を行う。
 *
 * ワイヤフォーマット（48kHz / 16bit / mono）:
 *   サンプル列 = [Sync x4] + (バイトフレームを 2バイト/サンプル で格納)
 *   Sync       = 生int16サンプル値 4個: 0x7FFF, 0x8000, 0x7FFF, 0x8000
 *   バイトフレーム = [Seq:1][Len:1][Payload:Len][CRC-16 hi][CRC-16 lo]
 *   サンプル分解: hi = (s >> 8) & 0xFF, lo = s & 0xFF （上位バイトが先）
 *   フレーム終端で下位バイトが 0 詰めの場合、CRC_LO確定後に残る lo は破棄する。
 *   CRC-16-CCITT（多項式 0x1021, init 0xFFFF）を Seq+Len+Payload に対して計算。
 *
 * Float32 -> int16 変換:
 *   int16 = Math.round(f * 32768) を clamp して復元する
 *   （エンコーダは int16 / 32768 で写像しているため厳密に往復する）。
 *   Sync検出のみ、float往復の誤差に備えて小さな許容窓を設ける（下記 SYNC_TOL）。
 *   データバイトは厳密復元が前提なので許容窓は使わない。
 *
 * ポートAPI（fsk-decoder-worklet.js と同形）:
 *   受信: {type:'reset'}
 *   送出: {type:'frame', payload: Uint8Array, seq}
 *         {type:'crc_error', received, expected, payloadLen, firstBytes, seq}
 *         {type:'stats', samples, frames, crcErrors}
 */

// Sync（ブロック方式 / firmware pcm_transport.h と一致）
//   [+FS]*BLK, [-FS]*BLK, [+FS]*BLK, [-FS]*BLK。振幅非依存に「閾値＋極性」で検出。
const PCM_SYNC_FS = 0x7FFF;
const PCM_SYNC_NFS = -32767;
const PCM_SYNC_BLK = 8;
const PCM_SYNC_LEN = PCM_SYNC_BLK * 4; // 32
const PCM_SYNC_THRESH = 3000;          // 極性判定の振幅閾値。実機ダンプ解析で最小振幅~4511/ノイズ2000未満皆無と判明し、6000では遷移点を穴あけしていたため3000へ(firmware と一致)
const PCM_MAX_PAYLOAD = 255;
// 対策Y: 受信許容する1フレーム最大ペイロード長（firmware PCM_MAX_FRAME_PAYLOAD と一致）。
// ビットずれで Len を巨大値と誤読したフレームを破棄し、即 Sync 再探索へ戻すための上限。
const PCM_MAX_FRAME_PAYLOAD = 64;

// データのマンチェスター復調（firmware pcm_transport.c と一致）
const PCM_CELL = 16;   // 速度優先（半セル=8）
const PCM_CELL_HALF = PCM_CELL / 2;

function syncSample(i) {
    const block = Math.floor(i / PCM_SYNC_BLK);
    return (block & 1) ? PCM_SYNC_NFS : PCM_SYNC_FS;
}

function floatToInt16(f) {
    let v = Math.round(f * 32768);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    return v;
}

class PCMDecoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // RX states (mirror pcm_transport.c rx_state_t)
        this.RX_SYNC = 0;
        this.RX_SEQ = 1;
        this.RX_LEN = 2;
        this.RX_PAYLOAD = 3;
        this.RX_CRC = 4;   // CRC-8（フレーム短縮で1バイト化）

        this.resetDecoder();

        // Stats
        this.sampleCounter = 0;
        this.frameCount = 0;
        this.crcErrorCount = 0;
        this.syncCount = 0;      // Sync検出回数（実機SY相当）
        this.hiCount = 0;        // 高振幅サンプル数（実機HI相当）
        this.peakPos = 0;
        this.peakNeg = 0;
        // ラン長ヒストグラム（極性が続いた長さの分布）。データ部の実効セル長診断用。
        // インデックス=ラン長(0..63にクリップ)、値=出現回数。
        this.runHist = new Array(64).fill(0);
        this._dbgLastSign = 0;
        this._dbgRun = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === 'reset') this.resetDecoder();
        };
    }

    resetDecoder() {
        this.state = this.RX_SYNC;
        this.syncMatch = 0;
        this.syncSeenCur = false;
        this.seq = 0;
        this.payloadLen = 0;
        this.payload = [];
        this.payloadIndex = 0;
        this.crcHi = 0;
        this.manReset(-1);
    }

    // マンチェスター復調状態リセット（firmware man_reset をミラー）
    manReset(lastSign) {
        this.manLastSign = lastSign;   // Sync末尾=負(-1)
        this.manRun = 0;
        this.slotParity = false;       // 半セルスロット: false=前半待ち, true=後半待ち
        this.manCellSign = 0;
        this.manStarted = false;
        this.manSkipStart = false;
        this.bitAcc = 0;
        this.bitCount = 0;
    }

    // 復調1ビットを蓄積し8ビットで pushByte。戻り値: フレーム確定なら true
    manPushBit(bit) {
        this.bitAcc = ((this.bitAcc << 1) | (bit & 1)) & 0xFF;
        this.bitCount++;
        if (this.bitCount >= 8) {
            const ok = this.pushByte(this.bitAcc);
            this.bitAcc = 0;
            this.bitCount = 0;
            return ok;
        }
        return false;
    }

    // 1サンプルをマンチェスター復調器へ（firmware man_feed_sample をミラー）
    //
    // 中央遷移追従型（クロック再同期あり）:
    //   各ビット = 前半(極性=ビット値) + 後半(逆極性)。中央に必ず1回遷移。
    //   セル先頭の極性を「そのビットの前半極性=ビット値」として確定候補にし、
    //   前半→後半の中央遷移を検出したら、そこから半セル後を次セル先頭に合わせる。
    //   これで各ビットが実長に追従し、リサンプルのセル伸縮に強い。
    //
    // 状態:
    //   manPhase 0=セル先頭待ち(前半極性の確定), 1=中央遷移待ち, 2=後半消化
    //   manCellSign: 現ビットの前半極性(=ビット値)
    manFeedSample(s) {
        const sign = (s >= PCM_SYNC_THRESH) ? 1 : (s <= -PCM_SYNC_THRESH) ? -1 : 0;

        if (!this.manStarted) {
            // Sync末尾(負)からの最初の立ち上がり(負→正)= スタートビット前半先頭
            if (this.manLastSign <= 0 && sign === 1) {
                this.manStarted = true;
                this.manPhase = 1;       // 前半に入った。中央遷移待ち。
                this.manCellSign = 1;    // 前半極性=正 → スタートビット=1
                this.manRun = 1;
                this.manSkipStart = true;
            }
            if (sign !== 0) this.manLastSign = sign;
            return false;
        }

        let framed = false;

        // 半セルスロット展開方式（最も素直で誤りにくいマンチェスター復調）:
        //  極性が変わったエッジで直前ランを確定し、その長さを半セル(HALF)単位に
        //  量子化して「そのランの極性を持つ半セルスロット」を round(len/HALF) 個
        //  生成する。マンチェスターは各ビット=2半セルスロット [前半][後半]で、
        //  前半スロットの極性がビット値。スロットを2個ずつ消費してビットを出す。
        //  位相はスタートビット(スロット2個)で合わせる。ラン長を丸めるので、
        //  リサンプルでセルが多少伸縮してもスロット数が保たれる。
        // ゼロサンプル(しきい値未満)はランに加算して時間経過を保つ(極性は切らない)。
        // ゼロ込みの生ランは綺麗に 8/16 の2値。ゼロを無視すると実効ラン長が縮んで
        // 量子化が潰れビット整列が崩れる(実機で検証)。ゼロはランに含めるのが正しい。
        if (sign === 0) { this.manRun++; return false; }
        if (this.manLastSign === 0) { this.manLastSign = sign; this.manRun = 1; return false; }
        if (sign === this.manLastSign) { this.manRun++; return false; }

        // エッジ確定: 直前ランを半セルスロットに量子化
        const runLen = this.manRun;
        const prevSign = this.manLastSign;
        this.manLastSign = sign;
        this.manRun = 1;

        // ラン長 → 半セルスロット数（最低1）。round(len/HALF)。
        let slots = Math.round(runLen / PCM_CELL_HALF);
        if (slots < 1) slots = 1;

        for (let k = 0; k < slots; k++) {
            framed = this._pushSlot(prevSign) || framed;
        }
        return framed;
    }

    // 半セルスロット(極性)を1つ受け取り、2個で1ビットを確定する。
    // slotParity=false: これは前半スロット（ビット値=極性）。true: 後半スロット。
    _pushSlot(pol) {
        let framed = false;
        if (!this.manStarted) {
            // 最初のスロット列でスタートビットの位相を確立する。
            // Sync末尾は負。スタートビット=1 は [前半+][後半-]。最初に来る「+スロット」を
            // 前半スロットの開始とみなす。負スロットが先に来る間は読み飛ばす。
            if (pol === 1) {
                this.manStarted = true;
                this.slotParity = true;   // この+スロットを前半として consumed。次は後半。
                this.manCellSign = 1;     // 前半極性=+ → スタートビット(=1)
                this.manSkipStart = true; // スタートビットは捨てる
            }
            return false;
        }
        if (!this.slotParity) {
            // 前半スロット: ビット値を決める
            this.manCellSign = pol;
            this.slotParity = true;
        } else {
            // 後半スロット: ここで1ビット確定（前半極性 manCellSign）
            const bit = (this.manCellSign === 1) ? 1 : 0;
            if (this.manSkipStart) this.manSkipStart = false;
            else framed = this.manPushBit(bit);
            this.slotParity = false;
        }
        return framed;
    }

    // CRC-8 (多項式 0x07, init 0x00)。firmware pcm_crc8 / encoder crc8 と一致。
    crc8(data) {
        let crc = 0x00;
        for (let i = 0; i < data.length; i++) {
            crc ^= data[i] & 0xFF;
            for (let bit = 0; bit < 8; bit++) {
                crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xFF : (crc << 1) & 0xFF;
            }
        }
        return crc & 0xFF;
    }

    // 期待極性（ブロック方式）: idx 番目に正ブロックなら +THRESH 以上、
    // 負ブロックなら -THRESH 以下で一致とみなす（firmware sync_pol_ok と対称）。
    syncPolOk(s, idx) {
        const expect = syncSample(idx);
        return expect > 0 ? (s >= PCM_SYNC_THRESH) : (s <= -PCM_SYNC_THRESH);
    }

    /**
     * 1バイトをステートマシンへ投入。フレーム確定時に true を返す。
     * pcm_transport.c の rx_push_byte をミラーする。
     */
    pushByte(b) {
        switch (this.state) {
            case this.RX_SEQ:
                this.seq = b;
                this.state = this.RX_LEN;
                break;
            case this.RX_LEN:
                // 対策Y: Len が許容上限を超えたらビットずれ暴走とみなしフレーム破棄→即Sync再探索。
                if (b > PCM_MAX_FRAME_PAYLOAD) {
                    this.crcErrorCount++;
                    this.state = this.RX_SYNC;
                    this.syncMatch = 0;
                    this.syncSeenCur = false;
                    break;
                }
                this.payloadLen = b;
                this.payload = [];
                this.payloadIndex = 0;
                this.state = (b === 0) ? this.RX_CRC : this.RX_PAYLOAD;
                break;
            case this.RX_PAYLOAD:
                this.payload.push(b);
                this.payloadIndex++;
                if (this.payloadIndex >= this.payloadLen) this.state = this.RX_CRC;
                break;
            case this.RX_CRC: {
                const received = b & 0xFF;
                const crcData = [this.seq, this.payloadLen, ...this.payload];
                const expected = this.crc8(crcData);
                let ok = false;
                if (received === expected) {
                    this.frameCount++;
                    this.port.postMessage({
                        type: 'frame',
                        payload: new Uint8Array(this.payload),
                        seq: this.seq
                    });
                    ok = true;
                } else {
                    this.crcErrorCount++;
                    this.port.postMessage({
                        type: 'crc_error',
                        received,
                        expected,
                        payloadLen: this.payloadLen,
                        firstBytes: this.payload.slice(0, 4),
                        seq: this.seq
                    });
                }
                // Frame complete: return to Sync hunting.
                this.state = this.RX_SYNC;
                this.syncMatch = 0;
                this.syncSeenCur = false;
                return ok;
            }
            default:
                break;
        }
        return false;
    }

    processSample(f) {
        const s = floatToInt16(f);
        if (s > this.peakPos) this.peakPos = s;
        if (s < this.peakNeg) this.peakNeg = s;
        if (s >= PCM_SYNC_THRESH || s <= -PCM_SYNC_THRESH) this.hiCount++;

        // 生サンプルのラン長ヒストグラム（復調とは独立の診断）。
        {
            const dsign = (s >= PCM_SYNC_THRESH) ? 1 : (s <= -PCM_SYNC_THRESH) ? -1 : 0;
            if (dsign === 0) {
                // 低振幅はランを途切れさせない（継続扱い）
                if (this._dbgRun > 0) this._dbgRun++;
            } else if (this._dbgLastSign === 0) {
                this._dbgLastSign = dsign; this._dbgRun = 1;
            } else if (dsign === this._dbgLastSign) {
                this._dbgRun++;
            } else {
                // エッジ: 直前ラン長を記録
                let r = this._dbgRun; if (r > 63) r = 63;
                this.runHist[r]++;
                this._dbgLastSign = dsign; this._dbgRun = 1;
            }
        }

        if (this.state === this.RX_SYNC) {
            // Sync検出（ブロック長非依存 / 極性切替ベース）。firmware と同一。
            // 高振幅の 正→負→正→負 と極性が切り替わることだけを見る。
            //   syncMatch: 通過した切替回数 (0..3), syncSeenCur: 現区間に入ったか
            const sign = (s >= PCM_SYNC_THRESH) ? 1 : (s <= -PCM_SYNC_THRESH) ? -1 : 0;
            if (sign !== 0) {
                const want = (this.syncMatch & 1) ? -1 : 1;
                if (this.syncSeenCur) {
                    const wantNext = (want === 1) ? -1 : 1;
                    if (sign === wantNext) {
                        this.syncMatch++;
                        this.syncSeenCur = true;
                        if (this.syncMatch >= 3) {
                            this.state = this.RX_SEQ;
                            this.syncMatch = 0;
                            this.syncSeenCur = false;
                            this.syncCount++;
                            // データ部のマンチェスター復調を初期化（Sync末尾=負）
                            this.manReset(-1);
                        }
                    }
                } else {
                    if (sign === want) {
                        this.syncSeenCur = true;
                    } else {
                        this.syncMatch = 0;
                        this.syncSeenCur = (sign === 1);
                    }
                }
            }
            return;
        }

        // Data section: マンチェスター(セル中央サンプリング)復調。
        this.manFeedSample(s);
    }

    process(inputs, outputs, parameters) {
        // 起動診断: 最初の数回だけ process が呼ばれていること/入力の有無を通知。
        if ((this._dbgCalls || 0) < 3) {
            this._dbgCalls = (this._dbgCalls || 0) + 1;
            const inp = inputs[0];
            this.port.postMessage({
                type: 'dbg',
                call: this._dbgCalls,
                hasInput: !!(inp && inp.length),
                chLen: (inp && inp[0]) ? inp[0].length : 0
            });
        }
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const channel = input[0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this.processSample(channel[i]);
        }

        this.sampleCounter += channel.length;
        if (this.sampleCounter - (this.lastStatsAt || 0) >= 24000) {
            this.lastStatsAt = this.sampleCounter;
            // ラン長ヒストグラムの上位（出現の多いラン長 top5）を要約
            const hist = this.runHist.map((c, len) => [len, c]).filter(x => x[1] > 0);
            hist.sort((a, b) => b[1] - a[1]);
            const top = hist.slice(0, 6).map(x => x[0] + ':' + x[1]);
            this.port.postMessage({
                type: 'stats',
                samples: this.sampleCounter,
                frames: this.frameCount,
                crcErrors: this.crcErrorCount,
                sync: this.syncCount,
                hi: this.hiCount,
                peakPos: this.peakPos,
                peakNeg: this.peakNeg,
                runTop: top
            });
        }
        return true;
    }
}

registerProcessor('pcm-decoder-processor', PCMDecoderProcessor);
