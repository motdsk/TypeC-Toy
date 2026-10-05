/**
 * cdp-debug.js - CDP(Chrome DevTools Protocol)でgame.htmlタブに接続し、
 * コンソールログを収集しつつ、出力先をUSB(CoreS3)に設定してConnectを実行する。
 *
 * 実行: node web/cdp-debug.js [秒数]
 * 前提: Chrome を --remote-debugging-port=9222 で起動し game.html を開いていること。
 */
'use strict';
const http = require('http');

const DURATION = (parseInt(process.argv[2], 10) || 20) * 1000;

function getTargets() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:9222/json', (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', reject);
    });
}

(async () => {
    const targets = await getTargets();
    const page = targets.find(t => t.type === 'page' && t.url.includes('game.html'));
    if (!page) { console.error('game.html タブが見つかりません'); process.exit(1); }
    const ws = new WebSocket(page.webSocketDebuggerUrl);

    let id = 0;
    const pending = new Map();
    function send(method, params) {
        return new Promise((resolve) => {
            const mid = ++id;
            pending.set(mid, resolve);
            ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
    }

    ws.addEventListener('open', async () => {
        await send('Runtime.enable');
        await send('Console.enable');
        await send('Log.enable');

        // 出力デバイス(audiooutput)一覧を取得し、USB/ヘッドセット/303a を含むものを選ぶ。
        // さらに Connect ボタンをクリックする。これらをページ内で評価する。
        // 手順を2段に分ける。(1)権限取得+出力先選択(await可)。(2)userGestureでConnect。
        const prep = `
          (async () => {
            const log = (m) => console.log('[CDP] ' + m);
            try {
              // 既に接続中なら一旦切る（btnのテキストで判定）
              const b = document.getElementById('btnConnect');
              if (b && /disconnect|🔌/i.test(b.textContent)) { b.click(); log('pre-disconnect'); await new Promise(r=>setTimeout(r,500)); }
              try { const s = await navigator.mediaDevices.getUserMedia({audio:true}); s.getTracks().forEach(t=>t.stop()); } catch(e){ log('pre-grant failed: '+e.message); }
              const devs = await navigator.mediaDevices.enumerateDevices();
              const outs = devs.filter(d => d.kind === 'audiooutput');
              const sel = document.getElementById('outputSelect');
              // 「既定 - ... usb uac」でなく、素の「ヘッドセット (usb uac)(303a)」を優先的に選ぶ
              let match = outs.find(o => /303a/i.test(o.label) && !/既定|通信|default|communication/i.test(o.label))
                        || outs.find(o => /303a|usb uac|ヘッドセット|headset/i.test(o.label));
              let picked = '';
              if (match && sel) {
                // select の option は deviceId を value に持つ。deviceId で合わせる。
                for (const opt of sel.options) { if (opt.value === match.deviceId) { sel.value = opt.value; picked = opt.textContent; break; } }
                if (!picked) { // フォールバック: ラベル一致
                  for (const opt of sel.options) { if (opt.textContent && opt.textContent.includes('303a')) { sel.value = opt.value; picked = opt.textContent; break; } }
                }
              }
              log('picked output: ' + picked + ' (val=' + (sel?sel.value:'?') + ')');
              return true;
            } catch (e) { log('PREP ERROR ' + e.message); return false; }
          })();
        `;
        await send('Runtime.evaluate', { expression: prep, awaitPromise: true });
        // userGesture=true で Connect（AudioContext起動を許可）
        const doConnect = `
          (() => {
            const log = (m) => console.log('[CDP] ' + m);
            const btn = document.getElementById('btnConnect');
            if (btn) { btn.click(); log('clicked Connect (userGesture)'); } else { log('no Connect button'); }
          })();
        `;
        await send('Runtime.evaluate', { expression: doConnect, userGesture: true, awaitPromise: false });
        console.log('--- Connect 実行。以後コンソールログを収集します ---');
    });

    // コンソール出力を受信して表示
    ws.addEventListener('message', (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); return; }
        if (msg.method === 'Runtime.consoleAPICalled') {
            const args = (msg.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' ');
            console.log('LOG: ' + args);
        } else if (msg.method === 'Log.entryAdded') {
            console.log('LOGE: ' + msg.params.entry.text);
        }
    });

    ws.addEventListener('error', (e) => console.error('WS error', e.message || e));

    setTimeout(() => { console.log('--- 収集終了 ---'); ws.close(); process.exit(0); }, DURATION);
})();
