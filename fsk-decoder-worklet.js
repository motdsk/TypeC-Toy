/**
 * MFSK-4 Decoder AudioWorklet Processor
 *
 * 4-tone Goertzel detection, 2 bits per symbol.
 * - f0 = 600Hz  (symbol "00")
 * - f1 = 1200Hz (symbol "01")
 * - f2 = 2400Hz (symbol "10")
 * - f3 = 3600Hz (symbol "11")
 * - Sample rate: 48000 Hz
 * - Goertzel window: 20 samples
 * - Frame: [0xAA][0xAA][0x7E][len][data...][crc_h][crc_l]
 * - Sync detection: 24-bit sliding window for 0xAAAA7E
 */

class FSKDecoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.sampleRate = 48000;
        this.freqs = [1200, 2400]; // Mark=1200Hz, Space=2400Hz
        this.samplesPerSymbol = 20;

        // Goertzel coefficients for 2 frequencies
        const N = this.samplesPerSymbol;
        this.coeffs = this.freqs.map(f => {
            const k = f * N / this.sampleRate;
            return 2 * Math.cos(2 * Math.PI * k / N);
        });

        // Goertzel state (2 channels)
        this.q1 = [0, 0];
        this.q2 = [0, 0];
        this.sampleCount = 0;

        // Sliding bit shift register (24 bits)
        this.bitShiftReg = 0;
        this.bitShiftCount = 0;

        // Byte assembly
        this.currentByte = 0;
        this.bitCount = 0;

        // Frame state
        this.STATE_HUNT = 0;
        this.STATE_LENGTH = 1;
        this.STATE_DATA = 2;
        this.STATE_CRC_HIGH = 3;
        this.STATE_CRC_LOW = 4;

        this.frameState = this.STATE_HUNT;
        this.framePayload = [];
        this.framePayloadLen = 0;
        this.frameDataIndex = 0;
        this.frameCrcHigh = 0;

        this.port.onmessage = (event) => {
            if (event.data.type === 'reset') this.resetDecoder();
        };
    }

    resetDecoder() {
        this.q1 = [0, 0];
        this.q2 = [0, 0];
        this.sampleCount = 0;
        this.bitShiftReg = 0;
        this.bitShiftCount = 0;
        this.currentByte = 0;
        this.bitCount = 0;
        this.frameState = this.STATE_HUNT;
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

    processSample(sample) {
        // Goertzel iteration for Mark and Space
        for (let ch = 0; ch < 2; ch++) {
            const q0 = this.coeffs[ch] * this.q1[ch] - this.q2[ch] + sample;
            this.q2[ch] = this.q1[ch];
            this.q1[ch] = q0;
        }

        this.sampleCount++;
        if (this.sampleCount >= this.samplesPerSymbol) {
            // Compute magnitudes
            const magMark = this.q1[0]*this.q1[0] + this.q2[0]*this.q2[0] - this.coeffs[0]*this.q1[0]*this.q2[0];
            const magSpace = this.q1[1]*this.q1[1] + this.q2[1]*this.q2[1] - this.coeffs[1]*this.q1[1]*this.q2[1];
            this.q1[0] = this.q2[0] = this.q1[1] = this.q2[1] = 0;
            this.sampleCount = 0;

            // Energy gate
            if (magMark + magSpace < 1e-6) return;

            // Mark > Space → 1, else → 0
            const bit = magMark > magSpace ? 1 : 0;

            // Stats tracking (report every 1000 bits)
            this.bitCounter = (this.bitCounter || 0) + 1;
            if (this.bitCounter % 2000 === 0) {
                this.port.postMessage({
                    type: 'stats',
                    bits: this.bitCounter,
                    lastMark: magMark.toFixed(4),
                    lastSpace: magSpace.toFixed(4)
                });
            }

            this.feedBit(bit);
        }
    }

    feedBit(bit) {
        if (this.frameState === this.STATE_HUNT) {
            this.bitShiftReg = ((this.bitShiftReg << 1) | (bit & 1)) & 0xFFFFFF;
            this.bitShiftCount++;
            if (this.bitShiftCount >= 24 && (this.bitShiftReg & 0xFFFFFF) === 0xAAAA7E) {
                this.frameState = this.STATE_LENGTH;
                this.currentByte = 0;
                this.bitCount = 0;
                this.framePayload = [];
                this.frameDataIndex = 0;
            }
        } else {
            this.currentByte = ((this.currentByte << 1) | (bit & 1)) & 0xFF;
            this.bitCount++;
            if (this.bitCount >= 8) {
                this.feedByte(this.currentByte);
                this.currentByte = 0;
                this.bitCount = 0;
            }
        }
    }

    feedByte(byte) {
        switch (this.frameState) {
            case this.STATE_LENGTH:
                this.framePayloadLen = byte;
                this.frameDataIndex = 0;
                this.framePayload = [];
                this.frameState = (byte === 0) ? this.STATE_CRC_HIGH : this.STATE_DATA;
                break;
            case this.STATE_DATA:
                this.framePayload.push(byte);
                this.frameDataIndex++;
                if (this.frameDataIndex >= this.framePayloadLen)
                    this.frameState = this.STATE_CRC_HIGH;
                break;
            case this.STATE_CRC_HIGH:
                this.frameCrcHigh = byte;
                this.frameState = this.STATE_CRC_LOW;
                break;
            case this.STATE_CRC_LOW: {
                const receivedCrc = (this.frameCrcHigh << 8) | byte;
                const crcData = [this.framePayloadLen, ...this.framePayload];
                const expectedCrc = this.crc16(crcData);
                if (receivedCrc === expectedCrc) {
                    this.port.postMessage({ type: 'frame', payload: new Uint8Array(this.framePayload) });
                } else {
                    this.port.postMessage({
                        type: 'crc_error',
                        received: receivedCrc,
                        expected: expectedCrc,
                        payloadLen: this.framePayloadLen,
                        firstBytes: this.framePayload.slice(0, 4)
                    });
                }
                this.frameState = this.STATE_HUNT;
                this.bitShiftReg = 0;
                this.bitShiftCount = 0;
                this.currentByte = 0;
                this.bitCount = 0;
                break;
            }
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
        return true;
    }
}

registerProcessor('fsk-decoder-processor', FSKDecoderProcessor);
