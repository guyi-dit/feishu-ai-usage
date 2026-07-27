'use strict';

const key = 'app_secret';
const appIdInput = document.getElementById('appId');
const secretInput = document.getElementById('secret');
const saveButton = document.getElementById('save');
const clearButton = document.getElementById('clear');
const statusBox = document.getElementById('status');

function setBusy(busy) {
  saveButton.disabled = busy;
  clearButton.disabled = busy;
}

function setStatus(message, state) {
  statusBox.textContent = message;
  statusBox.dataset.state = state || '';
}

async function refreshStatus(successMessage) {
  setBusy(true);
  if (!successMessage) setStatus('正在读取配置状态…');
  try {
    const [secretResponse, kvResponse] = await Promise.all([
      fetch('/secrets'),
      fetch('/kv')
    ]);
    if (!secretResponse.ok) throw new Error('HTTP ' + secretResponse.status);
    if (!kvResponse.ok) throw new Error('HTTP ' + kvResponse.status);

    const items = await secretResponse.json();
    const config = await kvResponse.json();
    if (!Array.isArray(items)) throw new Error('配置状态格式不正确');

    const item = items.find((entry) => entry.key === key);
    const hasAppId = typeof config.app_id === 'string' && config.app_id.trim();
    appIdInput.value = hasAppId ? config.app_id : '';
    if (item && item.saved && hasAppId) {
      const tail = item.tail ? '（尾号 ' + item.tail + '）' : '';
      appIdInput.placeholder = '已保存；粘贴新值可覆盖';
      secretInput.placeholder = '已保存；粘贴新值可覆盖';
      setStatus(
        successMessage || '配置已保存（App ID + App Secret' + tail + '），Token 将自动续期',
        'success'
      );
      return true;
    }

    appIdInput.placeholder = '飞书 App ID，例如 cli_xxxxx';
    secretInput.placeholder = '粘贴 App Secret';
    setStatus(
      hasAppId ? '尚未配置 App Secret' : '请先配置 App ID 和 App Secret',
      'error'
    );
    return false;
  } catch (error) {
    setStatus('无法读取配置状态，请关闭设置页后重试', 'error');
    return false;
  } finally {
    setBusy(false);
  }
}

saveButton.addEventListener('click', async () => {
  const appId = appIdInput.value.trim();
  const value = secretInput.value.trim();
  if (!/^cli_[A-Za-z0-9]+$/.test(appId)) {
    setStatus('请填写有效的飞书 App ID（通常以 cli_ 开头）', 'error');
    appIdInput.focus();
    return;
  }
  if (!value) {
    setStatus('请先粘贴 App Secret；已保存的密钥不会回填', 'error');
    secretInput.focus();
    return;
  }

  setBusy(true);
  setStatus('正在安全保存…');
  try {
    const kvResponse = await fetch('/kv', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId })
    });
    if (kvResponse.status !== 204) throw new Error('HTTP ' + kvResponse.status);

    const response = await fetch('/secrets/' + key, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    });
    if (response.status !== 204) throw new Error('HTTP ' + response.status);

    secretInput.value = '';
    await refreshStatus('配置已安全保存，Token 将自动续期');
  } catch (error) {
    setStatus('保存失败，请重试（HTTP 请求未成功）', 'error');
  } finally {
    setBusy(false);
  }
});

clearButton.addEventListener('click', async () => {
  setBusy(true);
  setStatus('正在清除…');
  try {
    const [response, kvResponse] = await Promise.all([
      fetch('/secrets/' + key, { method: 'DELETE' }),
      fetch('/kv', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      })
    ]);
    if (response.status !== 204) throw new Error('HTTP ' + response.status);
    if (kvResponse.status !== 204) throw new Error('HTTP ' + kvResponse.status);

    appIdInput.value = '';
    secretInput.value = '';
    appIdInput.placeholder = '飞书 App ID，例如 cli_xxxxx';
    secretInput.placeholder = '粘贴 App Secret';
    setStatus('App ID 和 App Secret 已清除', 'success');
  } catch (error) {
    setStatus('清除失败，请重试（HTTP 请求未成功）', 'error');
  } finally {
    setBusy(false);
  }
});

refreshStatus();
