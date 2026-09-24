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

const PCM_SYNC = [0x7FFF, -0x8000, 0x7FFF, -0x8000]; // int16 sync values
const PCM_SYNC_LEN = 4;
const PCM_MAX_PAYLOAD = 255;

// Sync tolerance (in int16 units). Data bytes reconstruct exactly, but the raw
// Sync samples pass through Float32; allow a small window in case of rounding.
const SYNC_TOL = 2;

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
        this.RX_CRC_HI = 4;
        this.RX_CRC_LO = 5;

        this.resetDecoder();

        // Stats
        this.sampleCounter = 0;
        this.frameCount = 0;
        this.crcErrorCount = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === 'reset') this.resetDecoder();
        };
    }

    resetDecoder() {
        this.state = this.RX_SYNC;
        this.syncMatch = 0;
        this.seq = 0;
        this.payloadLen = 0;
        this.payload = [];
        this.payloadIndex = 0;
        this.crcHi = 0;
    }

    crc16(data) {
        let crc = 0xFFFF;
        for (let i = 0; i < data.length; i++) {
            crc ^= (data[i] << 8) & 0xFFFF;
            for (let bit = 0; bit < 8; bit++) {
                if (crc & 0x8000) crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
                else crc = (crc << 1) & 0xFFFF;
            }
        }
        return crc;
    }

    syncMatches(s, idx) {
        return Math.abs(s - PCM_SYNC[idx]) <= SYNC_TOL;
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
                this.payloadLen = b;
                this.payload = [];
                this.payloadIndex = 0;
                this.state = (b === 0) ? this.RX_CRC_HI : this.RX_PAYLOAD;
                break;
            case this.RX_PAYLOAD:
                this.payload.push(b);
                this.payloadIndex++;
                if (this.payloadIndex >= this.payloadLen) this.state = this.RX_CRC_HI;
                break;
            case this.RX_CRC_HI:
                this.crcHi = b;
                this.state = this.RX_CRC_LO;
                break;
            case this.RX_CRC_LO: {
                const received = ((this.crcHi << 8) | b) & 0xFFFF;
                const crcData = [this.seq, this.payloadLen, ...this.payload];
                const expected = this.crc16(crcData);
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
                return ok;
            }
            default:
                break;
        }
        return false;
    }

    processSample(f) {
        const s = floatToInt16(f);

        if (this.state === this.RX_SYNC) {
            // Sliding search of the raw-sample Sync pattern (with tolerance).
            if (this.syncMatches(s, this.syncMatch)) {
                this.syncMatch++;
                if (this.syncMatch >= PCM_SYNC_LEN) {
                    this.state = this.RX_SEQ;
                    this.syncMatch = 0;
                }
            } else {
                // Mismatch: if current sample is the first Sync value, match=1 else 0.
                this.syncMatch = this.syncMatches(s, 0) ? 1 : 0;
            }
            return;
        }

        // Data section: 1 sample = high byte + low byte (2 bytes).
        const hi = (s >> 8) & 0xFF;
        const lo = s & 0xFF;
        this.pushByte(hi);
        // If CRC_LO processing returned state to RX_SYNC, the low byte here is
        // the zero-pad at the frame boundary (frames are sample-aligned) — skip it.
        if (this.state !== this.RX_SYNC) {
            this.pushByte(lo);
        }
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const channel = input[0];
        if (!channel) return true;

        for (let i = 0; i < channel.length; i++) {
            this.processSample(channel[i]);
        }

        this.sampleCounter += channel.length;
        if (this.sampleCounter - (this.lastStatsAt || 0) >= 48000) {
            this.lastStatsAt = this.sampleCounter;
            this.port.postMessage({
                type: 'stats',
                samples: this.sampleCounter,
                frames: this.frameCount,
                crcErrors: this.crcErrorCount
            });
        }
        return true;
    }
}

registerProcessor('pcm-decoder-processor', PCMDecoderProcessor);
