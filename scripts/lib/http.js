// 走查脚本公共：HTTP 客户端 + 管理端登录
// consistency-check.js 与 capture-shots.js 原先各自实现了一遍，这里合并。
'use strict';

function makeHttp(base, password) {
  // 通用请求：返回 { status, ok, data }，不抛错（调用方自行判断）
  // options.headers 可附加自定义请求头（安全自检节用它伪造来源 IP，避免打满真实配额）
  async function request(route, options = {}) {
    const headers = {};
    if (options.body) headers['Content-Type'] = 'application/json';
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.headers) Object.assign(headers, options.headers);
    const res = await fetch(base + route, {
      method: options.body ? 'POST' : 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
  }

  async function login() {
    const res = await request('/api/auth/login', { body: { username: 'admin', password } });
    if (!res.ok) {
      // 被限流最容易被误判成「服务没起来」，单独给出可操作的提示
      if (res.status === 429) {
        throw new Error('管理端登录被限流（429）：同一账号/IP 每分钟登录次数超限。'
          + '连着跑多个自检脚本、或短时间反复重试都会撞上，等 1 分钟再试；'
          + '需要临时放宽时用 RATE_LOGIN_PER_MIN=0 RATE_LOGIN_USER_PER_MIN=0 启动服务');
      }
      throw new Error(`管理端登录失败（${res.status}）${res.data && res.data.message ? `：${res.data.message}` : '：请确认服务已启动'}`);
    }
    return res.data.token;
  }

  // 管理端请求：失败即抛错（脚本里属于「不该发生」的情况）
  async function adminFetch(token, route, options = {}) {
    const res = await request(route, { ...options, token });
    if (!res.ok) throw new Error(`${route} -> ${res.status} ${JSON.stringify(res.data)}`);
    return res.data;
  }

  // 绑定 token 的版本：admin('/api/...', { body })
  const bindAdmin = (token) => (route, options = {}) => adminFetch(token, route, options);

  return { request, login, adminFetch, bindAdmin };
}

module.exports = { makeHttp };
