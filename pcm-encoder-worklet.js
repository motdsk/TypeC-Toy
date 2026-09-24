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

const PCM_SYNC = [0x7FFF, -0x8000, 0x7FFF, -0x8000]; // int16 sync values
const PCM_MAX_PAYLOAD = 255;

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

        this.port.onmessage = (event) => {
            const msg = event.data;
            if (msg.type === 'send') {
                const samples = this.buildSamples(msg.frame);
                if (samples) {
                    this.txQueue.push(samples);
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
        const crc = this.crc16(bytes);          // CRC over Seq+Len+Payload
        bytes.push((crc >> 8) & 0xFF);          // CRC-hi
        bytes.push(crc & 0xFF);                 // CRC-lo

        this.seq = (this.seq + 1) & 0xFF;

        // Sync samples (exact int16 values) + packed data samples.
        const numData = Math.ceil(bytes.length / 2);
        const out = new Float32Array(PCM_SYNC.length + numData);

        let oi = 0;
        for (let i = 0; i < PCM_SYNC.length; i++) {
            out[oi++] = int16ToFloat(PCM_SYNC[i]);
        }
        for (let bi = 0; bi < bytes.length; bi += 2) {
            const hi = bytes[bi];
            const lo = (bi + 1 < bytes.length) ? bytes[bi + 1] : 0; // zero-pad low byte
            // s = (hi << 8) | lo, interpreted as signed int16
            let s = ((hi << 8) | lo) & 0xFFFF;
            if (s >= 0x8000) s -= 0x10000;
            out[oi++] = int16ToFloat(s);
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
