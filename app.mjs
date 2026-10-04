import { redact, summarize, fetchArchive } from './core.mjs';

const $ = id => document.getElementById(id);
const query = new URLSearchParams(location.search);
$('app').value = query.get('vk_app_id') || '';
$('group').value = query.get('vk_group_id') || '';
let token = '';
let busy = false;
let stopped = false;
let posts = [];
const secrets = new Set();
const report = { bridgeVersion: '3.0.2', checks: [] };

function settings() {
  const app = Number($('app').value);
  const group = Number($('group').value);
  const limit = Number($('limit').value);
  const version = $('version').value.trim();
  if (!Number.isSafeInteger(app) || app <= 0) throw new Error('Укажите положительный ID приложения');
  if (!Number.isSafeInteger(group) || group <= 0) throw new Error('Укажите положительный ID сообщества');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('Лимит: от 1 до 10000 постов');
  if (!/^\d+\.\d+$/.test(version)) throw new Error('Укажите версию API в формате 5.199');
  return { app, group, limit, version, role: $('role').value };
}

function log(check, result, config) {
  report.checks.push(redact({ time: new Date().toISOString(), check, config, result }, [...secrets]));
  $('results').textContent = JSON.stringify(report.checks, null, 2);
}

async function send(method, params = {}) {
  let timer;
  try {
    return await Promise.race([
      window.vkBridge.send(method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('VK не ответил за 30 секунд')), 30000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function api(method, params, config) {
  if (!token) throw new Error('Сначала получите пользовательский токен');
  const data = await send('VKWebAppCallAPIMethod', {
    method, params: { ...params, access_token: token, v: config.version }
  });
  if (data.error) throw data.error;
  if (data.response?.error) throw data.response.error;
  return data.response;
}

function renderCatalog() {
  const term = $('search').value.trim().toLocaleLowerCase('ru');
  const selected = posts.filter(post => (post.text || '').toLocaleLowerCase('ru').includes(term));
  $('catalog-status').textContent = `Найдено ${selected.length} из ${posts.length}. Показаны первые 50. Отсутствие заглушки ещё не доказывает доступность вложений.`;
  $('catalog').replaceChildren();
  for (const post of selected.slice(0, 50)) {
    const card = document.createElement('div');
    card.className = 'card';
    const text = document.createElement('p');
    text.textContent = (post.text || 'Текст не получен').slice(0, 250);
    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `Вложений: ${(post.attachments || []).length}. Заглушка: ${Boolean(post.donut?.placeholder)}.`;
    card.append(text, meta);
    if (Number.isSafeInteger(post.owner_id) && Number.isSafeInteger(post.id)) {
      const link = document.createElement('a');
      link.href = `https://vk.ru/wall${post.owner_id}_${post.id}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Открыть исходный пост VK';
      card.append(link);
    }
    $('catalog').append(card);
  }
}

function updateButtons() {
  for (const id of ['auth', 'wall-auth', 'subscription', 'import']) $(id).disabled = busy;
  if (!token) {
    $('subscription').disabled = true;
    $('import').disabled = true;
  }
  for (const id of ['app', 'group', 'role', 'version', 'limit']) $(id).disabled = busy;
}

async function run(check, work) {
  if (busy) return;
  busy = true;
  updateButtons();
  let config;
  try {
    config = settings();
    $('status').textContent = 'Выполняется проверка…';
    await work(config);
    $('status').textContent = 'Проверка завершена. Смотрите фактический ответ ниже.';
  } catch (error) {
    const detail = redact(error instanceof Error && { message: error.message } || error, [...secrets]);
    log(check, { error: detail }, config);
    $('status').textContent = `Ошибка: ${JSON.stringify(detail)}`;
  } finally {
    busy = false;
    $('stop').disabled = true;
    updateButtons();
  }
}

async function authorize(scope, config) {
  token = '';
  posts = [];
  renderCatalog();
  const result = await send('VKWebAppGetAuthToken', { app_id: config.app, scope });
  if (typeof result.access_token !== 'string' || !result.access_token) throw new Error('VK не выдал access_token');
  token = result.access_token;
  secrets.add(token);
  log('VKWebAppGetAuthToken', { requestedScope: scope, grantedScope: result.scope, expires: result.expires, authorized: true }, config);
  try {
    const users = await api('users.get', {}, config);
    log('Владелец токена', users, config);
  } catch (error) {
    log('users.get', { error: error instanceof Error && error.message || error }, config);
  }
}

$('auth').onclick = () => run('Базовый токен', config => authorize('', config));
$('wall-auth').onclick = () => run('Токен с wall', config => authorize('wall', config));
$('subscription').onclick = () => run('Подписка', async config => {
  for (const method of ['donut.isDon', 'donut.getSubscription']) {
    try {
      const result = await api(method, { owner_id: -config.group }, config);
      log(method, result, config);
    } catch (error) {
      log(method, { error: error instanceof Error && error.message || error }, config);
    }
  }
});
$('import').onclick = () => run('Импорт', async config => {
  stopped = false;
  posts = [];
  $('stop').disabled = false;
  let result;
  try {
    result = await fetchArchive((method, params) => api(method, params, config), -config.group, config.limit, page => {
      posts = page.posts;
      $('status').textContent = `Получено ${page.received}; уникальных ${posts.length}; VK сообщает всего ${page.total}.`;
      renderCatalog();
    }, () => stopped);
  } finally {
    log('wall.get: итог', { ...summarize(posts), total: result?.total, received: result?.received, duplicates: result?.duplicates, reason: result?.reason || 'error', partial: !result || result.reason !== 'end' }, config);
  }
});
$('stop').onclick = () => { stopped = true; $('status').textContent = 'Остановка после текущего запроса…'; };
$('search').oninput = renderCatalog;
$('export').onclick = () => {
  const blob = new Blob([JSON.stringify(redact(report, [...secrets]), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'vk-donut-result.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
try {
  if (!window.vkBridge) throw new Error('VK Bridge не загрузился');
  if (window.vkBridge.isStandalone()) throw new Error('Откройте стенд внутри VK Mini App, а не отдельной вкладкой');
  await send('VKWebAppInit');
  $('status').textContent = 'VK Bridge готов. Укажите сообщество и получите токен.';
} catch (error) {
  $('status').textContent = error.message || JSON.stringify(error);
}
updateButtons();
