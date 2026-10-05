/**
 * cdp-eval.js - CDP で game.html タブに任意の JS を評価する簡易ツール。
 * 実行: node web/cdp-eval.js "<式>"
 * 例:   node web/cdp-eval.js "window.__rxDisconnect()"
 */
'use strict';
const http = require('http');
const expr = process.argv[2] || 'void 0';

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
        return new Promise((resolve) => { const mid = ++id; pending.set(mid, resolve); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
    }
    ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    });
    ws.addEventListener('open', async () => {
        await send('Runtime.enable');
        const r = await send('Runtime.evaluate', { expression: expr, userGesture: true, awaitPromise: true, returnByValue: true });
        console.log('result:', JSON.stringify(r && r.result ? r.result.value : r));
        ws.close();
        process.exit(0);
    });
    ws.addEventListener('error', (e) => { console.error('WS error', e.message || e); process.exit(1); });
})();
