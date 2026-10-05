/**
 * PCM Direct Transport Encoder AudioWorklet Processor
 *
 * FSK変調を使わず、int16 PCMサンプルにデータバイトを直接格納する送信側。
 * ファームウェア typec_poc_idf/main/pcm_transport.c と *バイト互換* な波形を生成する。
 *
 * ワイヤフォーマット（48kHz / 16bit / mono）:
 *   サンプル列 = [Sync x4] + (バイトフレームを 2バイト/サンプル で格納)
 *   Sync       = 生int16サンプル値 4個: 0x7FFF, 0x8000, 0x7FFF, 0x8000
 *   バイトフレーム = [Seq:1][Len:1][Payload:Len][CRC-16 hi][CRC-16 lo]
 *   サンプル格納: s = (B_hi << 8) | B_lo （上位バイトが先）
 *   バイト数が奇数の場合、最後のサンプルの下位バイトは 0 詰め。
 *   CRC-16-CCITT（多項式 0x1021, init 0xFFFF）を Seq+Len+Payload に対して計算。
 *
 * int16 -> Float32 変換:
 *   Sync は正確な整数値が必要なので int16 / 32768 で写像する
 *   （0x7FFF=32767 -> 32767/32768, 0x8000=-32768 -> -1.0）。
 *   データサンプルも同じ写像 (int16 / 32768) を使う。デコーダ側は
 *   Math.round(f * 32768) で int16 に厳密復元できる。
 *
 * ポートAPI（fsk-encoder-worklet.js と同形）:
 *   受信: {type:'send', frame:[payload bytes]}  ← 生ペイロード。Seq/Len/CRCはworklet内で付与
 *   送出: {type:'tx_start', queueLen, frameLen}
 *         {type:'tx_done'}
 */

// Sync（ブロック方式 / firmware pcm_transport.h と一致）
//   [+FS]*BLK, [-FS]*BLK, [+FS]*BLK, [-FS]*BLK
//   フルスケール正=0x7FFF, 負=-32767(0x8001。-32768クランプ回避)。
//   低周波矩形波なのでホストのリサンプルを通してもピーク/極性が残り、
//   受信側は「振幅閾値＋極性」で振幅非依存に検出できる。
const PCM_SYNC_FS = 0x7FFF;
const PCM_SYNC_NFS = -32767;
const PCM_SYNC_BLK = 8;
const PCM_SYNC_LEN = PCM_SYNC_BLK * 4; // 32
const PCM_MAX_PAYLOAD = 255;

// データのマンチェスター符号（firmware pcm_transport.h と一致）
//   1ビット=PCM_CELLサンプル。ビット1=前半+FS/後半-FS、ビット0=前半-FS/後半+FS。
//   データ先頭にスタートビット(=1)を1つ入れて受信位相を確定する。
const PCM_CELL = 16;   // 速度優先（半セル=8）
const PCM_CELL_HALF = PCM_CELL / 2;
const PCM_DATA_FS = 0x7FFF;
const PCM_DATA_NFS = -32767;

function syncSample(i) {
    const block = Math.floor(i / PCM_SYNC_BLK); // 0,1,2,3
    return (block & 1) ? PCM_SYNC_NFS : PCM_SYNC_FS;
}

// 1ビットのマンチェスター波形（cell内サンプル位置 pos の値）
function manTxSample(bit, pos) {
    const firstHalf = (pos < PCM_CELL_HALF);
    if (bit) return firstHalf ? PCM_DATA_FS : PCM_DATA_NFS;
    return firstHalf ? PCM_DATA_NFS : PCM_DATA_FS;
}

function int16ToFloat(v) {
    // v is a signed int16 (-32768..32767). Map to [-1,1) via /32768 so that the
    // decoder can recover the exact integer with Math.round(f * 32768).
    return v / 32768;
}

class PCMEncoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.txQueue = [];        // queued float sample arrays ready to emit
        this.current = null;      // current float sample array being emitted
        this.currentIndex = 0;
        this.seq = 0;             // internal sequence counter (mirrors pcm_transport tx.seq)

        // 最新優先モード: ゲームのようなリアルタイム用途では、送出が間に合わず
        // キューが溜まると「古い位置/入力」が遅延再生されて同期が崩れる。true の
        // 間は、送出中に届いた新フレームで待機キューを上書きし、常に最新だけを送る。
        this.latestOnly = true;

        this.port.onmessage = (event) => {
            const msg = event.data;
            if (msg.type === 'send') {
                const samples = this.buildSamples(msg.frame);
                if (samples) {
                    if (msg.urgent) {
                        samples._urgent = true;
                        this.txQueue.push(samples);
                    } else if (this.latestOnly) {
                        // 位置のみ: 送出待ちの非イベントを最新に上書き（遅延蓄積防止）。
                        const tail = this.txQueue[this.txQueue.length - 1];
                        if (tail && !tail._urgent) {
                            this.txQueue[this.txQueue.length - 1] = samples;
                        } else {
                            this.txQueue.push(samples);
                        }
                    } else {
                        this.txQueue.push(samples);
                    }
                    this.port.postMessage({
                        type: 'tx_start',
                        queueLen: this.txQueue.length,
                        frameLen: msg.frame ? msg.frame.length : 0
                    });
                }
            } else if (msg.type === 'reset') {
                this.txQueue = [];
                this.current = null;
                this.currentIndex = 0;
                this.seq = 0;
            }
        };
    }

    // CRC-8 (多項式 0x07, init 0x00)。フレーム短縮のため CRC-16 から変更
    // (firmware pcm_crc8 と一致)。フレームが1バイト短くなり、1フレーム内で
    // 波形の乱れを踏む確率が下がって受信成功率が上がる。
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

    /**
     * 生ペイロードから [Seq][Len][Payload][CRC-hi][CRC-lo] を組み立て、
     * Sync + 2バイト/サンプル 詰めの Float32 サンプル列を返す。
     * pcm_transport_send + pcm_transport_generate_tx をミラーする。
     */
    buildSamples(frame) {
        const payload = frame ? Array.from(frame) : [];
        const len = payload.length;
        if (len > PCM_MAX_PAYLOAD) return null;

        // Byte frame: Seq, Len, Payload, CRC-hi, CRC-lo
        const bytes = [];
        bytes.push(this.seq & 0xFF);           // Seq
        bytes.push(len & 0xFF);                 // Len
        for (let i = 0; i < len; i++) bytes.push(payload[i] & 0xFF); // Payload
        const crc = this.crc8(bytes);           // CRC-8 over Seq+Len+Payload
        bytes.push(crc & 0xFF);                 // CRC-8 (1バイト)

        this.seq = (this.seq + 1) & 0xFF;

        // Sync(32 sample) + start bit(1) + data bits(8/byte) をマンチェスターで。
        // 末尾に1セル分のポストアンブル(無音)を足し、受信側が最終ビットの
        // 中央遷移後の半セルを観測して確定できるようにする。
        const numBits = 1 /*start*/ + bytes.length * 8;
        const out = new Float32Array(PCM_SYNC_LEN + numBits * PCM_CELL + PCM_CELL);

        let oi = 0;
        // Sync ブロック
        for (let i = 0; i < PCM_SYNC_LEN; i++) {
            out[oi++] = int16ToFloat(syncSample(i));
        }
        // スタートビット(=1)
        for (let p = 0; p < PCM_CELL; p++) {
            out[oi++] = int16ToFloat(manTxSample(1, p));
        }
        // データバイト（MSB first）
        let lastHalfPol = 0; // 最終ビット後半の極性（終端エッジ生成用）
        for (let bi = 0; bi < bytes.length; bi++) {
            const byte = bytes[bi];
            for (let b = 0; b < 8; b++) {
                const bit = (byte >> (7 - b)) & 1;
                for (let p = 0; p < PCM_CELL; p++) {
                    out[oi++] = int16ToFloat(manTxSample(bit, p));
                }
                // 各ビット後半の極性: bit1→後半-, bit0→後半+
                lastHalfPol = bit ? -1 : 1;
            }
        }
        // 終端: 最終ビット後半と逆極性の1セルを足す。これで受信側に必ず
        // 「最終ビットの後半スロットを確定させるエッジ」が立つ（末尾ビット取りこぼし防止）。
        const endPol = -lastHalfPol;
        const endVal = (endPol === 1) ? PCM_DATA_FS : PCM_DATA_NFS;
        for (let p = 0; p < PCM_CELL; p++) {
            out[oi++] = int16ToFloat(endVal);
        }
        return out;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const channel = output[0];

        for (let i = 0; i < channel.length; i++) {
            if (this.current === null) {
                if (this.txQueue.length > 0) {
                    this.current = this.txQueue.shift();
                    this.currentIndex = 0;
                } else {
                    channel[i] = 0; // silence when idle
                    continue;
                }
            }

            channel[i] = this.current[this.currentIndex++];

            if (this.currentIndex >= this.current.length) {
                this.current = null;
                this.currentIndex = 0;
                this.port.postMessage({ type: 'tx_done' });
            }
        }
        return true;
    }
}

registerProcessor('pcm-encoder-processor', PCMEncoderProcessor);
