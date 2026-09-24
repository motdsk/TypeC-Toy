/**
 * FSK Paint - おえかき通信
 *
 * 32x32 pixel, 8-color painting canvas with FSK modem transmission.
 * Image encoding: 3 bits per pixel, packed into bytes.
 * 32*32*3 = 3072 bits = 384 bytes, sent in 2 frames (255 + 129 bytes).
 *
 * Protocol:
 *   Frame 1: [0x01 (IMG_START)] [seq=0] [chunk_data... 253 bytes]
 *   Frame 2: [0x01 (IMG_START)] [seq=1] [chunk_data... remaining]
 *
 * Color palette (8 colors, 3-bit index):
 *   0=white, 1=black, 2=red, 3=green, 4=blue, 5=yellow, 6=cyan, 7=magenta
 */

// 8-color palette (RGB hex)
const PALETTE = [
    '#FFFFFF', // 0: white
    '#000000', // 1: black
    '#FF0000', // 2: red
    '#00CC00', // 3: green
    '#0066FF', // 4: blue
    '#FFCC00', // 5: yellow
    '#00CCCC', // 6: cyan
    '#CC00CC', // 7: magenta
];

const GRID = 32;
const CELL = 6; // 192 / 32
const IMG_CMD = 0x01; // Image frame command byte (legacy raw)
const IMG_RLE_CMD = 0x02; // Image frame command byte (RLE compressed)

// Pixel buffer (32x32, values 0-7)
const pixels = new Uint8Array(GRID * GRID);
pixels.fill(0); // white

let selectedColor = 1; // black

// ============================================================================
// Canvas Drawing
// ============================================================================

const drawCanvas = document.getElementById('drawCanvas');
const drawCtx = drawCanvas.getContext('2d');
const recvCanvas = document.getElementById('recvCanvas');
const recvCtx = recvCanvas.getContext('2d');

function renderDrawCanvas() {
    for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
            drawCtx.fillStyle = PALETTE[pixels[y * GRID + x]];
            drawCtx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
    }
}

function renderRecvCanvas(imgPixels) {
    for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
            recvCtx.fillStyle = PALETTE[imgPixels[y * GRID + x] & 0x07];
            recvCtx.fillRect(x * CELL, y * CELL, CELL, CELL);
        }
    }
}

function drawPixel(x, y) {
    if (x < 0 || x >= GRID || y < 0 || y >= GRID) return;
    pixels[y * GRID + x] = selectedColor;
    drawCtx.fillStyle = PALETTE[selectedColor];
    drawCtx.fillRect(x * CELL, y * CELL, CELL, CELL);
}

// Drawing events
let isDrawing = false;

function getGridPos(e) {
    const rect = drawCanvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const x = Math.floor((clientX - rect.left) / CELL);
    const y = Math.floor((clientY - rect.top) / CELL);
    return { x, y };
}

drawCanvas.addEventListener('mousedown', (e) => { isDrawing = true; const p = getGridPos(e); drawPixel(p.x, p.y); });
drawCanvas.addEventListener('mousemove', (e) => { if (isDrawing) { const p = getGridPos(e); drawPixel(p.x, p.y); } });
drawCanvas.addEventListener('mouseup', () => isDrawing = false);
drawCanvas.addEventListener('mouseleave', () => isDrawing = false);
drawCanvas.addEventListener('touchstart', (e) => { e.preventDefault(); isDrawing = true; const p = getGridPos(e); drawPixel(p.x, p.y); }, { passive: false });
drawCanvas.addEventListener('touchmove', (e) => { e.preventDefault(); if (isDrawing) { const p = getGridPos(e); drawPixel(p.x, p.y); } }, { passive: false });
drawCanvas.addEventListener('touchend', () => isDrawing = false);

// Palette UI
const paletteEl = document.getElementById('palette');
PALETTE.forEach((color, idx) => {
    const swatch = document.createElement('div');
    swatch.className = 'swatch' + (idx === selectedColor ? ' active' : '');
    swatch.style.background = color;
    swatch.style.border = color === '#FFFFFF' ? '2px solid #666' : '';
    swatch.addEventListener('click', () => {
        document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');
        selectedColor = idx;
    });
    paletteEl.appendChild(swatch);
});

document.getElementById('btnClear').addEventListener('click', () => {
    pixels.fill(0);
    renderDrawCanvas();
});

renderDrawCanvas();
recvCtx.fillStyle = '#1a1a2e';
recvCtx.fillRect(0, 0, 192, 192);

// ============================================================================
// Image Encoding/Decoding - RLE compressed
// Format: [color:3bit][length-1:5bit] pairs = max 32 pixels per run
// Total uncompressed: 1024 pixels. Typical compressed: 80-200 bytes.
// ============================================================================

function encodeImageRLE(pixelBuf) {
    const runs = [];
    let i = 0;
    while (i < 1024) {
        const color = pixelBuf[i];
        let len = 1;
        while (i + len < 1024 && pixelBuf[i + len] === color && len < 32) {
            len++;
        }
        // Pack: high 3 bits = color, low 5 bits = length-1
        runs.push((color << 5) | (len - 1));
        i += len;
    }
    return new Uint8Array(runs);
}

function decodeImageRLE(data) {
    const pixelBuf = new Uint8Array(1024);
    let pos = 0;
    for (let i = 0; i < data.length && pos < 1024; i++) {
        const color = (data[i] >> 5) & 0x07;
        const len = (data[i] & 0x1F) + 1;
        for (let j = 0; j < len && pos < 1024; j++) {
            pixelBuf[pos++] = color;
        }
    }
    return pixelBuf;
}

// Legacy 3-bit packed format (kept for compatibility)
function encodeImage(pixelBuf) {
    const out = new Uint8Array(384);
    let bitPos = 0;
    for (let i = 0; i < 1024; i++) {
        const val = pixelBuf[i] & 0x07;
        const byteIdx = Math.floor(bitPos / 8);
        const bitOff = bitPos % 8;
        if (bitOff <= 5) {
            out[byteIdx] |= (val << (5 - bitOff));
        } else {
            out[byteIdx] |= (val >> (bitOff - 5));
            out[byteIdx + 1] |= (val << (13 - bitOff));
        }
        bitPos += 3;
    }
    return out;
}

function decodeImage(data) {
    const pixelBuf = new Uint8Array(1024);
    let bitPos = 0;
    for (let i = 0; i < 1024; i++) {
        const byteIdx = Math.floor(bitPos / 8);
        const bitOff = bitPos % 8;
        let val;
        if (bitOff <= 5) {
            val = (data[byteIdx] >> (5 - bitOff)) & 0x07;
        } else {
            val = ((data[byteIdx] << (bitOff - 5)) | (data[byteIdx + 1] >> (13 - bitOff))) & 0x07;
        }
        pixelBuf[i] = val;
        bitPos += 3;
    }
    return pixelBuf;
}

// ============================================================================
// CRC-16-CCITT
// ============================================================================

function crc16(data) {
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

function encodeFrame(payload) {
    const len = payload.length;
    const frame = new Uint8Array(len + 8); // 4 preamble + sync + len + data + 2 CRC
    let idx = 0;
    frame[idx++] = 0xAA;
    frame[idx++] = 0xAA;
    frame[idx++] = 0xAA;
    frame[idx++] = 0xAA;
    frame[idx++] = 0x7E;
    frame[idx++] = len;
    for (let i = 0; i < len; i++) frame[idx++] = payload[i];
    const crcData = new Uint8Array(len + 1);
    crcData[0] = len;
    for (let i = 0; i < len; i++) crcData[i + 1] = payload[i];
    const crcVal = crc16(crcData);
    frame[idx++] = (crcVal >> 8) & 0xFF;
    frame[idx++] = crcVal & 0xFF;
    return frame;
}

// ============================================================================
// Audio/FSK Connection
// ============================================================================

let audioContext = null;
let encoderNode = null;
let decoderNode = null;
let mediaStream = null;
let isConnected = false;

// ---- Transport selection & sample-corruption fallback (要件18-8) ----
// PCM直接搬送をデフォルトとし、サンプル改変環境ではFSKへ一方向フォールバックする。
let currentTransport = 'pcm';       // 'pcm' (default) or 'fsk' (fallback)
let fallbackDone = false;           // pcm->fsk フォールバックは connect() ごとに一度だけ
let switchingTransport = false;     // 切替中のガード（ping-pong防止）
let pcmCrcErrorStreak = 0;          // 連続CRC失敗数（有効フレーム受信でリセット）
let pcmStatsWindows = 0;            // PCM statsを受信した回数（≒経過秒数）
let pcmFramesSeen = 0;              // これまでに受信できた有効フレーム総数

// フォールバック閾値
const FALLBACK_CRC_STREAK = 8;      // CRCが連続8回失敗 → PCM不可とみなす
const FALLBACK_SILENT_WINDOWS = 2;  // 有効フレーム0のstats窓が2回(≒2秒) → Sync不成立とみなす

const TRANSPORT_MODULES = {
    pcm: {
        encoderModule: 'pcm-encoder-worklet.js',
        encoderNode: 'pcm-encoder-processor',
        decoderModule: 'pcm-decoder-worklet.js',
        decoderNode: 'pcm-decoder-processor',
    },
    fsk: {
        encoderModule: 'fsk-encoder-worklet.js',
        encoderNode: 'fsk-encoder-processor',
        decoderModule: 'fsk-decoder-worklet.js',
        decoderNode: 'fsk-decoder-processor',
    },
};

function resetFallbackCounters() {
    pcmCrcErrorStreak = 0;
    pcmStatsWindows = 0;
    pcmFramesSeen = 0;
}

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const btnConnect = document.getElementById('btnConnect');
const btnSend = document.getElementById('btnSend');
const logEl = document.getElementById('log');
const progressBar = document.getElementById('progressBar');
const outputSelect = document.getElementById('outputSelect');

function setLog(msg) { logEl.textContent = msg; }

// Enumerate output devices
async function enumerateOutputs() {
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
enumerateOutputs();

// Auto-detect device changes (USB plug/unplug, mode switch)
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
        console.log('[DEVICE] Audio device changed, re-enumerating...');
        enumerateOutputs();
    });
}

// Receive buffer for multi-frame image
let rxImageBuf = new Uint8Array(512);
let rxImageChunks = 0; // bitmask
let rxImageLen = 0;

// エンコーダ/デコードのworklet読み込み・ノード生成・配線をトランスポート依存で行う。
// mediaStream / audioContext は呼び出し側で維持し、この関数では作り直さない。
async function setupTransport(transport) {
    const cfg = TRANSPORT_MODULES[transport] || TRANSPORT_MODULES.pcm;

    // Encoder (TX)
    await audioContext.audioWorklet.addModule(cfg.encoderModule);
    encoderNode = new AudioWorkletNode(audioContext, cfg.encoderNode, { outputChannelCount: [1] });
    encoderNode.port.onmessage = (e) => {
        if (e.data.type === 'tx_start') console.log('[ENC] TX queued, qLen=' + e.data.queueLen + ' fLen=' + e.data.frameLen);
        else if (e.data.type === 'tx_done') console.log('[ENC] TX done');
    };
    encoderNode.connect(audioContext.destination);

    // Decoder (RX) - requires an existing mediaStream source
    if (mediaStream) {
        await audioContext.audioWorklet.addModule(cfg.decoderModule);
        decoderNode = new AudioWorkletNode(audioContext, cfg.decoderNode, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
        decoderNode.port.onmessage = (e) => handleRx(e.data);
        const source = audioContext.createMediaStreamSource(mediaStream);
        source.connect(decoderNode);
        console.log('[RX] Decoder connected (' + transport + ')');
    }
}

async function connect() {
    if (isConnected) { disconnect(); return; }
    try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        if (audioContext.state === 'suspended') await audioContext.resume();

        // Fresh connect: default to PCM direct transport, reset fallback state.
        currentTransport = 'pcm';
        fallbackDone = false;
        switchingTransport = false;
        resetFallbackCounters();

        // Set audio output to selected device
        const selectedOutput = outputSelect.value;
        if (selectedOutput && audioContext.setSinkId) {
            try {
                await audioContext.setSinkId(selectedOutput);
            } catch (e) {
                console.warn('setSinkId failed:', e);
            }
        }

        // Decoder (RX) - optional, may fail on mobile if USB mic not accessible
        try {
            // First, get permission (this triggers Android to show USB device in subsequent calls)
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            tempStream.getTracks().forEach(t => t.stop());
            // Small delay to let Android audio routing settle after permission grant
            await new Promise(r => setTimeout(r, 300));
            // Find the USB audio input device matching the selected output
            let micDeviceId = undefined;
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const inputs = devices.filter(d => d.kind === 'audioinput');
                const outputs = devices.filter(d => d.kind === 'audiooutput');
                console.log('[RX] Audio inputs:', inputs.map(d => `${d.label} [${d.deviceId.slice(0,8)}] group=${d.groupId.slice(0,8)}`));
                console.log('[RX] Audio outputs:', outputs.map(d => `${d.label} [${d.deviceId.slice(0,8)}] group=${d.groupId.slice(0,8)}`));
                setLog(`Inputs: ${inputs.length}, Outputs: ${outputs.length}`);
                // Look for USB UAC device by label match
                const usbMic = inputs.find(d => d.label.toLowerCase().includes('usb') || d.label.includes('uac') || d.label.includes('303a') || d.label.includes('ヘッドセット'));
                if (usbMic) {
                    micDeviceId = usbMic.deviceId;
                    console.log('[RX] Using USB mic:', usbMic.label);
                } else if (inputs.length > 0) {
                    // If output was set to USB device, try to find matching input by groupId
                    const selectedOutput = outputSelect.value;
                    if (selectedOutput) {
                        const allDevices = devices;
                        const outDev = allDevices.find(d => d.deviceId === selectedOutput);
                        if (outDev && outDev.groupId) {
                            const matchedInput = inputs.find(d => d.groupId === outDev.groupId);
                            if (matchedInput) {
                                micDeviceId = matchedInput.deviceId;
                                console.log('[RX] Matched input by groupId:', matchedInput.label);
                            }
                        }
                    }
                    // Android fallback: if no USB mic found but only one input exists,
                    // Android may have auto-routed USB headset as default
                    if (!micDeviceId && inputs.length === 1) {
                        console.log('[RX] Only one input available, using it (Android auto-route):', inputs[0].label);
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
            console.log('[RX] getUserMedia constraints:', JSON.stringify(constraints));
            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

            // Log which track we actually got
            const audioTrack = mediaStream.getAudioTracks()[0];
            const trackSettings = audioTrack ? audioTrack.getSettings() : {};
            const micLabel = audioTrack?.label || 'unknown';
            console.log('[RX] Got audio track:', micLabel, 'settings:', JSON.stringify(trackSettings));
            setLog(`🎤 ${micLabel}`);
            // Store mic label for persistent display
            window._micLabel = micLabel;
            console.log('[RX] Mic acquired' + (micDeviceId ? ' (USB mic)' : ' (default mic)'));
        } catch (rxErr) {
            console.warn('[RX] Mic acquisition failed (send-only mode):', rxErr.message);
            mediaStream = null;
        }

        // Load worklets & wire encoder/decoder for the current transport (default: PCM).
        // setupTransport connects the decoder only when a mediaStream is available.
        await setupTransport(currentTransport);

        isConnected = true;
        statusDot.classList.add('connected');
        statusText.textContent = 'Connected';
        btnConnect.textContent = '🔌 Disconnect';
        btnConnect.classList.add('connected');
        btnSend.disabled = false;
        setLog('Audio connected (' + currentTransport.toUpperCase() + ')');
    } catch (err) {
        setLog('Error: ' + err.message);
        disconnect();
    }
}

// PCM -> FSK 一方向フォールバック（要件18-8）。
// mediaStream / audioContext は維持したまま、worklet ノードだけを張り替える。
async function switchTransport(transport) {
    if (switchingTransport) return;
    switchingTransport = true;
    try {
        // Tear down current worklet nodes (keep mediaStream + audioContext alive).
        if (encoderNode) { encoderNode.disconnect(); encoderNode = null; }
        if (decoderNode) { decoderNode.disconnect(); decoderNode = null; }

        currentTransport = transport;
        resetFallbackCounters();

        await setupTransport(transport);
        console.warn('[FALLBACK] Transport switched to ' + transport.toUpperCase());
        setLog('通信方式を ' + transport.toUpperCase() + ' に切替しました');
    } catch (e) {
        console.error('[FALLBACK] switchTransport failed:', e);
    } finally {
        switchingTransport = false;
    }
}

// PCM統計/CRC状況からサンプル改変環境を判定し、必要ならFSKへフォールバックする。
function maybeFallbackToFsk(reason) {
    if (currentTransport !== 'pcm' || fallbackDone || switchingTransport) return;
    fallbackDone = true; // 一度だけ（ping-pong防止）
    console.warn('[FALLBACK] PCM通信不可と判定 (' + reason + ') → FSKへフォールバック');
    setLog('PCM通信不可 → FSKにフォールバック (' + reason + ')');
    switchTransport('fsk');
}

function disconnect() {
    if (encoderNode) { encoderNode.disconnect(); encoderNode = null; }
    if (decoderNode) { decoderNode.disconnect(); decoderNode = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    // Reset transport/fallback state so the next connect() starts fresh on PCM.
    currentTransport = 'pcm';
    fallbackDone = false;
    switchingTransport = false;
    resetFallbackCounters();
    isConnected = false;
    statusDot.classList.remove('connected');
    statusText.textContent = 'Disconnected';
    btnConnect.textContent = '🎤 Connect';
    btnConnect.classList.remove('connected');
    btnSend.disabled = true;
}

btnConnect.addEventListener('click', connect);

// ============================================================================
// Send Image
// ============================================================================

let isSending = false;

// No ACK - redundant send (3x per chunk, fastest reliable method)

btnSend.addEventListener('click', async () => {
    if (!isConnected || isSending) return;
    isSending = true;
    btnSend.disabled = true;

    const imgData = encodeImageRLE(pixels);
    setLog(`Sending ${imgData.length} bytes...`);
    progressBar.style.width = '0%';

    const CHUNK_SIZE = 60; // Smaller chunks = higher CRC pass rate
    const totalChunks = Math.ceil(imgData.length / CHUNK_SIZE);
    const REDUNDANCY = 1; // Single send with FEC

    for (let seq = 0; seq < totalChunks; seq++) {
        const offset = seq * CHUNK_SIZE;
        const chunk = imgData.slice(offset, offset + CHUNK_SIZE);
        const payload = new Uint8Array(2 + chunk.length);
        payload[0] = IMG_RLE_CMD;
        payload[1] = seq;
        payload.set(chunk, 2);
        const frame = encodeFrame(payload);
        console.log(`[TX] Chunk ${seq}/${totalChunks}, payload=${chunk.length}B, frame=${frame.length}B, sending ${REDUNDANCY}x`);

        for (let r = 0; r < REDUNDANCY; r++) {
            encoderNode.port.postMessage({ type: 'send', frame: Array.from(frame) });
            const txTimeMs = (frame.length * 8 / 2400) * 1000 + 150;
            await new Promise(resolve => setTimeout(resolve, txTimeMs));
        }

        progressBar.style.width = ((seq + 1) / totalChunks * 100) + '%';
    }

    progressBar.style.width = '100%';
    setLog('Image sent!');
    isSending = false;
    btnSend.disabled = false;
});

// ============================================================================
// Receive Image
// ============================================================================

function handleRx(data) {
    if (data.type === 'frame') {
        // Valid frame proves PCM (or FSK) is viable → reset the CRC-failure streak.
        pcmCrcErrorStreak = 0;
        pcmFramesSeen++;
        const payload = data.payload;
        console.log('[RX] Frame OK, len=' + payload.length + ', hex=' + Array.from(payload.slice(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(' '));

        // Image frame (raw or RLE)
        if (payload.length >= 3 && (payload[0] === IMG_CMD || payload[0] === IMG_RLE_CMD)) {
            const isRLE = payload[0] === IMG_RLE_CMD;
            const seq = payload[1];
            const chunk = payload.slice(2);
            // CoreS3 sends with max 253-byte chunks (payload max 255 - 2 header bytes)
            // Use fixed chunk size for offset calculation
            const CHUNK_MAX = 253;
            const offset = seq * CHUNK_MAX;
            if (offset + chunk.length <= 512) {
                rxImageBuf.set(chunk, offset);
                rxImageChunks |= (1 << seq);
                rxImageLen = Math.max(rxImageLen, offset + chunk.length);
            }

            // Complete if this chunk is shorter than max (last chunk)
            if (chunk.length < CHUNK_MAX) {
                const imgBytes = rxImageBuf.slice(0, rxImageLen);
                const imgPixels = isRLE ? decodeImageRLE(imgBytes) : decodeImage(imgBytes);
                renderRecvCanvas(imgPixels);
                rxImageBuf = new Uint8Array(512);
                rxImageChunks = 0;
                rxImageLen = 0;
                progressBar.style.width = '100%';
                setLog('Image received!');
            } else {
                setLog(`Receiving... chunk ${seq + 1}`);
            }
        }
    } else if (data.type === 'crc_error') {
        console.warn('[RX] CRC FAIL: got=0x' + data.received.toString(16) + ' want=0x' + data.expected.toString(16) + ' len=' + data.payloadLen + ' first=' + JSON.stringify(data.firstBytes));
        setLog(`CRC ERR len=${data.payloadLen}`);
        // Sample-corruption detection (要件18-8): Sync is detected (we reached CRC)
        // but the payload bytes are being mangled → consecutive CRC failures.
        if (currentTransport === 'pcm') {
            pcmCrcErrorStreak++;
            if (pcmCrcErrorStreak >= FALLBACK_CRC_STREAK) {
                maybeFallbackToFsk('CRC連続失敗×' + pcmCrcErrorStreak);
            }
        }
    } else if (data.type === 'stats') {
        // Stats shape differs by transport:
        //   PCM: { samples, frames, crcErrors }
        //   FSK: { bits, lastMark, lastSpace }
        const isPcmStats = (data.samples !== undefined);
        if (isPcmStats) {
            console.log('[DECODER] PCM samples=' + data.samples + ' frames=' + data.frames + ' crcErrors=' + data.crcErrors);
            const mic = window._micLabel || '?';
            setLog(`🎤${mic.slice(0,20)} | frames=${data.frames} crcErr=${data.crcErrors}`);

            // Sample-corruption detection (要件18-8): audio is clearly flowing
            // (samples growing) but no valid frame AND no CRC error at all means
            // the Sync pattern is never even detected → sample values corrupted.
            if (currentTransport === 'pcm') {
                pcmStatsWindows++;
                if (pcmStatsWindows >= FALLBACK_SILENT_WINDOWS &&
                    data.samples > 0 && data.frames === 0 && data.crcErrors === 0) {
                    maybeFallbackToFsk('Sync未検出 (' + pcmStatsWindows + '窓, samples=' + data.samples + ')');
                }
            }
        } else {
            console.log('[DECODER] FSK bits=' + data.bits + ' magMark=' + data.lastMark + ' magSpace=' + data.lastSpace);
            // Show signal level on screen every 10000 bits
            if (data.bits % 10000 === 0) {
                const mic = window._micLabel || '?';
                setLog(`🎤${mic.slice(0,20)} | M=${data.lastMark} S=${data.lastSpace}`);
            }
        }
    }
}
