const STATE_KEY = 'jarvis.state';

const baseUrlEl = document.getElementById('baseUrl');
const tokenEl = document.getElementById('token');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save');
const testBtn = document.getElementById('test');

function showStatus(kind, msg) {
  statusEl.hidden = false;
  statusEl.className = `status status--${kind}`;
  statusEl.textContent = msg;
}

async function load() {
  const { [STATE_KEY]: state = {} } = await chrome.storage.local.get(STATE_KEY);
  baseUrlEl.value = state.baseUrl ?? '';
  tokenEl.value = state.token ?? '';
}

async function save() {
  const baseUrl = baseUrlEl.value.trim().replace(/\/+$/, '');
  const token = tokenEl.value.trim();
  if (!baseUrl || !token) {
    showStatus('bad', 'Both fields required.');
    return;
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    showStatus('bad', 'URL must start with http:// or https://');
    return;
  }
  await chrome.storage.local.set({ [STATE_KEY]: { baseUrl, token } });
  showStatus('ok', 'Saved. Open a Meet/Zoom/Teams tab to test.');
}

async function test() {
  showStatus('info', 'Pinging Jarvis…');
  const res = await chrome.runtime.sendMessage({ kind: 'ping-jarvis' });
  if (res?.ok) {
    showStatus(
      'ok',
      `Connected · ${res.json?.name ?? 'jarvis'} v${res.json?.version ?? '?'}`,
    );
  } else {
    showStatus(
      'bad',
      res?.reason === 'not-configured'
        ? 'Fill in URL + token first, then Save.'
        : `Couldn't reach Jarvis (${res?.reason ?? 'unknown'}).`,
    );
  }
}

saveBtn.addEventListener('click', () => void save());
testBtn.addEventListener('click', () => void test());
void load();
