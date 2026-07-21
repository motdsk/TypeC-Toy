/**
 * FSK Modem - Main JavaScript Module
 *
 * Protocol logic, UI control, AudioContext management, and device selection.
 * Coordinates the encoder/decoder AudioWorklets and implements the
 * communication protocol (framing, CRC, ACK/NACK, retries).
 *
 * Frame format (matches ESP32 implementation):
 *   [0xAA][0xAA][0x7E][Length][Data...][CRC-H][CRC-L]
 *
 * CRC-16-CCITT: polynomial 0x1021, init 0xFFFF
 * CRC is computed over [Length][Data...]
 */

// ============================================================================
// CRC-16-CCITT
// ============================================================================

/**
 * CRC-16-CCITT calculation matching the ESP32 frame_crc16() exactly.
 * @param {Uint8Array|number[]} data - bytes to compute CRC over
 * @returns {number} 16-bit CRC value
 */
function crc16(data) {
    let crc = 0xFFFF;
    for (let i = 0; i < data.length; i++) {
        crc ^= (data[i] << 8) & 0xFFFF;
        for (let bit = 0; bit < 8; bit++) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return crc;
}

// ============================================================================
// Frame Encoding
// ============================================================================

/**
 * Encode payload data into a complete frame.
 * Output: [0xAA][0xAA][0x7E][Length][Data...][CRC-H][CRC-L]
 * CRC is computed over [Length][Data...]
 *
 * @param {Uint8Array|number[]} payload - data bytes (0-255 bytes)
 * @returns {Uint8Array} complete frame bytes
 */
function encodeFrame(payload) {
    const len = payload.length;
    if (len > 255) throw new Error('Payload too large (max 255 bytes)');

    const frame = new Uint8Array(len + 6);
    let idx = 0;

    // Preamble
    frame[idx++] = 0xAA;
    frame[idx++] = 0xAA;

    // Sync
    frame[idx++] = 0x7E;

    // Length
    frame[idx++] = len;

    // Data
    for (let i = 0; i < len; i++) {
        frame[idx++] = payload[i];
    }

    // CRC-16 over [Length][Data...]
    const crcData = new Uint8Array(len + 1);
    crcData[0] = len;
    for (let i = 0; i < len; i++) {
        crcData[i + 1] = payload[i];
    }
    const crcValue = crc16(crcData);
    frame[idx++] = (crcValue >> 8) & 0xFF;  // CRC high
    frame[idx++] = crcValue & 0xFF;          // CRC low

    return frame;
}

// ============================================================================
// Modem State
// ============================================================================

let audioContext = null;
let encoderNode = null;
let decoderNode = null;
let mediaStream = null;
let isConnected = false;
let isSending = false;

// ACK/Retry state
const ACK_TIMEOUT_MS = 500;
const MAX_RETRIES = 3;
let pendingSend = null;  // { payload, retries, timeoutId }

// Sequence number for ACK tracking
let txSeqNum = 0;

// ============================================================================
// UI Elements
// ============================================================================

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const txIndicator = document.getElementById('txIndicator');
const rxIndicator = document.getElementById('rxIndicator');
const deviceSelect = document.getElementById('deviceSelect');
const btnConnect = document.getElementById('btnConnect');
const sendInput = document.getElementById('sendInput');
const btnSend = document.getElementById('btnSend');
const rxLog = document.getElementById('rxLog');

// ============================================================================
// UI Helpers
// ============================================================================

function setStatus(state, text) {
    statusText.textContent = text;
    statusDot.className = 'status-dot';
    if (state === 'connected') statusDot.classList.add('connected');
    else if (state === 'error') statusDot.classList.add('error');
}

function setTxActive(active) {
    txIndicator.className = active ? 'indicator active-tx' : 'indicator';
}

function setRxActive(active) {
    rxIndicator.className = active ? 'indicator active-rx' : 'indicator';
}

function logMessage(text, type = 'data') {
    const now = new Date();
    const time = now.toLocaleTimeString('ja-JP', { hour12: false });

    const msgEl = document.createElement('div');
    msgEl.className = 'msg';

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = time;

    const dataSpan = document.createElement('span');
    dataSpan.className = `msg-${type}`;
    dataSpan.textContent = text;

    msgEl.appendChild(timeSpan);
    msgEl.appendChild(dataSpan);

    // Remove initial placeholder if present
    if (rxLog.children.length === 1 && rxLog.children[0].querySelector('.msg-info')?.textContent === 'Waiting for connection...') {
        rxLog.innerHTML = '';
    }

    rxLog.appendChild(msgEl);
    rxLog.scrollTop = rxLog.scrollHeight;
}

// ============================================================================
// Device Enumeration
// ============================================================================

async function enumerateDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter(d => d.kind === 'audioinput');
        const audioOutputs = devices.filter(d => d.kind === 'audiooutput');

        deviceSelect.innerHTML = '';

        if (audioInputs.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'No audio input devices found';
            deviceSelect.appendChild(opt);
        } else {
            // Add a default option
            const defaultOpt = document.createElement('option');
            defaultOpt.value = '';
            defaultOpt.textContent = `-- Select device (${audioInputs.length} available) --`;
            deviceSelect.appendChild(defaultOpt);

            audioInputs.forEach((device, idx) => {
                const opt = document.createElement('option');
                opt.value = device.deviceId;
                opt.textContent = device.label || `Audio Input ${idx + 1}`;
                deviceSelect.appendChild(opt);
            });
        }

        deviceSelect.disabled = false;
    } catch (err) {
        logMessage(`Device enum error: ${err.message}`, 'error');
    }
}

// ============================================================================
// Audio Connection
// ============================================================================

async function connectAudio() {
    if (isConnected) {
        disconnectAudio();
        return;
    }

    try {
        setStatus('', 'Connecting...');

        // Create AudioContext inside user gesture handler (required by Safari/iOS)
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 48000
        });

        // Resume AudioContext (required after user gesture)
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Get getUserMedia stream with specific constraints
        const constraints = {
            audio: {
                sampleRate: 48000,
                channelCount: 1,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        };

        // If a specific device is selected, add deviceId constraint
        const selectedDeviceId = deviceSelect.value;
        if (selectedDeviceId) {
            constraints.audio.deviceId = { exact: selectedDeviceId };
        }

        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Enumerate devices again now that we have permission (labels available)
        await enumerateDevices();

        // Register and connect encoder worklet (TX)
        await audioContext.audioWorklet.addModule('fsk-encoder-worklet.js');
        encoderNode = new AudioWorkletNode(audioContext, 'fsk-encoder-processor', {
            outputChannelCount: [1]
        });

        encoderNode.port.onmessage = (event) => {
            if (event.data.type === 'tx_start') {
                isSending = true;
                setTxActive(true);
            } else if (event.data.type === 'tx_done') {
                isSending = false;
                setTxActive(false);
            }
        };

        // Connect encoder to audio output (UAC speaker)
        encoderNode.connect(audioContext.destination);

        // Register and connect decoder worklet (RX)
        await audioContext.audioWorklet.addModule('fsk-decoder-worklet.js');
        decoderNode = new AudioWorkletNode(audioContext, 'fsk-decoder-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 0,
            channelCount: 1
        });

        decoderNode.port.onmessage = (event) => {
            handleDecoderMessage(event.data);
        };

        // Connect getUserMedia source to decoder worklet
        const source = audioContext.createMediaStreamSource(mediaStream);
        source.connect(decoderNode);

        // Success
        isConnected = true;
        setStatus('connected', 'Connected');
        btnConnect.textContent = '🔌 Disconnect';
        btnConnect.classList.add('connected');
        sendInput.disabled = false;
        btnSend.disabled = false;

        logMessage('Audio connected', 'info');

    } catch (err) {
        setStatus('error', `Error: ${err.message}`);
        logMessage(`Connection failed: ${err.message}`, 'error');
        disconnectAudio();
    }
}

function disconnectAudio() {
    if (encoderNode) {
        encoderNode.disconnect();
        encoderNode = null;
    }
    if (decoderNode) {
        decoderNode.disconnect();
        decoderNode = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    if (pendingSend && pendingSend.timeoutId) {
        clearTimeout(pendingSend.timeoutId);
        pendingSend = null;
    }

    isConnected = false;
    isSending = false;
    setStatus('', 'Disconnected');
    setTxActive(false);
    setRxActive(false);
    btnConnect.textContent = '🎤 Connect Audio';
    btnConnect.classList.remove('connected');
    sendInput.disabled = true;
    btnSend.disabled = true;
}

// ============================================================================
// Decoder Message Handler
// ============================================================================

function handleDecoderMessage(data) {
    if (data.type === 'frame') {
        setRxActive(true);
        setTimeout(() => setRxActive(false), 200);

        const payload = data.payload;
        // Try to decode as UTF-8 text
        try {
            const text = new TextDecoder('utf-8').decode(payload);
            logMessage(text, 'data');
        } catch {
            // Show as hex
            const hex = Array.from(payload).map(b => b.toString(16).padStart(2, '0')).join(' ');
            logMessage(`[HEX] ${hex}`, 'data');
        }

        // Check if this is an ACK for our pending send
        if (pendingSend && payload.length >= 2 && payload[0] === 0x06) { // ACK byte
            clearTimeout(pendingSend.timeoutId);
            pendingSend = null;
            logMessage('ACK received', 'info');
        }
    } else if (data.type === 'crc_error') {
        logMessage(`CRC error (got 0x${data.received.toString(16)}, expected 0x${data.expected.toString(16)})`, 'error');
    }
}

// ============================================================================
// Send Logic
// ============================================================================

function sendData() {
    if (!isConnected || !encoderNode) return;

    const text = sendInput.value.trim();
    if (!text) return;

    const payload = new TextEncoder().encode(text);
    if (payload.length > 255) {
        logMessage('Message too long (max 255 bytes)', 'error');
        return;
    }

    sendFrame(payload);
    sendInput.value = '';
}

/**
 * Send a frame (fire-and-forget for PoC, no ACK expected).
 * @param {Uint8Array} payload - data to send
 */
function sendFrame(payload) {
    const frame = encodeFrame(payload);

    // Post frame bytes to encoder worklet
    encoderNode.port.postMessage({
        type: 'send',
        frame: Array.from(frame)
    });

    logMessage(`→ ${new TextDecoder().decode(payload)}`, 'info');
}

function handleAckTimeout() {
    if (!pendingSend) return;

    pendingSend.retries++;
    if (pendingSend.retries >= MAX_RETRIES) {
        logMessage(`Send failed after ${MAX_RETRIES} retries`, 'error');
        pendingSend = null;
        return;
    }

    // Retry
    logMessage(`Timeout, retry ${pendingSend.retries}/${MAX_RETRIES}...`, 'error');
    const frame = encodeFrame(pendingSend.payload);
    encoderNode.port.postMessage({
        type: 'send',
        frame: Array.from(frame)
    });

    pendingSend.timeoutId = setTimeout(() => handleAckTimeout(), ACK_TIMEOUT_MS);
}

// ============================================================================
// Event Listeners
// ============================================================================

btnConnect.addEventListener('click', connectAudio);

btnSend.addEventListener('click', sendData);

sendInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        sendData();
    }
});

// Handle device selection change while connected
deviceSelect.addEventListener('change', async () => {
    if (isConnected) {
        // Reconnect with new device
        logMessage('Switching device...', 'info');
        disconnectAudio();
        await connectAudio();
    }
});

// Initial device enumeration (will show limited info until permission granted)
if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    enumerateDevices();
}
