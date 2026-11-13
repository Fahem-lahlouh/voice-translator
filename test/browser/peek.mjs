const list = await (await fetch('http://127.0.0.1:9333/json/list')).json();
console.log(list.map((t) => `${t.type} ${t.url.slice(-40)}`).join('\n'));
const off = list.find((t) => t.url.includes('offscreen.html'));
if (off) {
  const ws = new WebSocket(off.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  const r = await new Promise((res) => {
    ws.onmessage = (e) => res(JSON.parse(e.data));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
      expression: 'JSON.stringify({seen:(globalThis.__vtSeen||[]).length, st:__doublage.snapshot()})', returnByValue: true } }));
  });
  console.log((r.result?.result?.value || JSON.stringify(r)).slice(0, 900));
  ws.close();
}
