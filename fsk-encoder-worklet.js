/**
 * MFSK-4 Encoder AudioWorklet Processor
 *
 * 4-tone FSK: 2 bits per symbol, phase-continuous.
 * - f0 = 600Hz  (symbol "00")
 * - f1 = 1200Hz (symbol "01")
 * - f2 = 2400Hz (symbol "10")
 * - f3 = 3600Hz (symbol "11")
 * - Sample rate: 48000 Hz
 * - Samples per symbol: 20
 * - Symbol rate: 2400 sym/s = 4800 bps
 * - Byte ordering: MSB first, 4 symbols per byte (2 bits each)
 */

class FSKEncoderProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        this.sampleRate = 48000;
        this.freqs = [2400, 1200]; // [Space(0), Mark(1)]
        this.samplesPerSymbol = 20;

        // Phase increments for each frequency
        this.phaseIncs = this.freqs.map(f => (2 * Math.PI * f) / this.sampleRate);

        this.phase = 0;
        this.txQueue = [];
        this.currentFrame = null;
        this.byteIndex = 0;
        this.symbolIndex = 0; // 0-3 (4 symbols per byte, MSB first)
        this.sampleCount = 0;
        this.amplitude = 0.7;

        this.port.onmessage = (event) => {
            if (event.data.type === 'send') {
                this.txQueue.push(new Uint8Array(event.data.frame));
                this.port.postMessage({ type: 'tx_start', queueLen: this.txQueue.length, frameLen: event.data.frame.length });
            }
        };
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        if (!output || output.length === 0) return true;
        const channel = output[0];

        for (let i = 0; i < channel.length; i++) {
            if (this.currentFrame === null) {
                if (this.txQueue.length > 0) {
                    this.currentFrame = this.txQueue.shift();
                    this.byteIndex = 0;
                    this.symbolIndex = 0;
                    this.sampleCount = 0;
                } else {
                    channel[i] = 0;
                    continue;
                }
            }

            // Get current bit (MSB first)
            const byte = this.currentFrame[this.byteIndex];
            const bit = (byte >> (7 - this.symbolIndex)) & 1;

            // Generate sine at mark(1) or space(0) frequency
            channel[i] = Math.sin(this.phase) * this.amplitude;
            this.phase += this.phaseIncs[bit];
            if (this.phase >= 2 * Math.PI) this.phase -= 2 * Math.PI;

            this.sampleCount++;
            if (this.sampleCount >= this.samplesPerSymbol) {
                this.sampleCount = 0;
                this.symbolIndex++;
                if (this.symbolIndex >= 8) {
                    this.symbolIndex = 0;
                    this.byteIndex++;
                    if (this.byteIndex >= this.currentFrame.length) {
                        this.currentFrame = null;
                        this.port.postMessage({ type: 'tx_done' });
                    }
                }
            }
        }
        return true;
    }
}

registerProcessor('fsk-encoder-processor', FSKEncoderProcessor);
