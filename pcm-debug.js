'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function loadWorklet(file) {
    const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const captured = {};
    const sandbox = {
        AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
        registerProcessor: (name, cls) => { captured[name] = cls; },
        sampleRate: 48000, console,
    };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: file });
    return captured;
}
const Encoder = loadWorklet('pcm-encoder-worklet.js')['pcm-encoder-processor'];
const Decoder = loadWorklet('pcm-decoder-worklet.js')['pcm-decoder-processor'];

function run(payloadByte) {
    const e = new Encoder();
    const samples = e.buildSamples([payloadByte]);
    const d = new Decoder();
    let bits = [];
    const origBit = d.manPushBit.bind(d);
    d.manPushBit = (b) => { bits.push(b); return origBit(b); };
    let bytes = [];
    const origPush = d.pushByte.bind(d);
    d.pushByte = (b) => { bytes.push(b); return origPush(b); };
    for (let i = 0; i < samples.length; i++) d.processSample(samples[i]);
    const exp = payloadByte.toString(2).padStart(8, '0');
    console.log(`payload=0x${payloadByte.toString(16)} exp bits=${exp}`);
    console.log(`  decoded bits=${bits.join('')}`);
    console.log(`  bytes=${bytes.map(b => '0x' + b.toString(16)).join(',')}`);
}

run(0xC3);
run(0xAA);
run(0x00);
run(0xFF);
