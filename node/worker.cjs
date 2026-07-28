const readline = require('node:readline');
const https = require('node:https');

const APP_ID_PATTERN = /^cli_[A-Za-z0-9]+$/;
const TOKEN_PATH = '/open-apis/auth/v3/tenant_access_token/internal';
const QUERY_PATH = '/open-apis/admin/v1/ai_usage_detail/query';
const USER_PATH = '/open-apis/contact/v3/users/';
const DEPARTMENT_BATCH_PATH = '/open-apis/contact/v3/departments/batch';

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function rpcError(id, code, message) {
  reply({ jsonrpc: '2.0', id, error: { code, message } });
}

function describeFeishuFailure(parsed, statusCode, operation) {
  const code = Number(parsed && parsed.code);
  const rawMessage = String(parsed && (parsed.msg || parsed.message) || '未知错误');
  const lower = rawMessage.toLowerCase();

  if (operation === 'token') {
    return '无法获取 tenant_access_token：请确认 App ID 和 App Secret 属于同一个已发布的飞书自建应用';
  }
  if (code === 41050 || lower.includes('no user authority')) {
    return '通讯录数据权限范围未覆盖目标成员：请在飞书应用的数据权限中设置为全体成员或需要分析的部门，并重新发布';
  }
  if (code === 99991672 || lower.includes('permission denied')
      || lower.includes('forbidden') || lower.includes('scope')) {
    return '飞书应用权限不足：请按插件设置页的权限清单补开所需 Scope，并发布新版本';
  }
  if (operation === 'usage' && (lower.includes('gray') || lower.includes('beta')
      || lower.includes('not open') || lower.includes('not enabled'))) {
    return 'AI 用量查询接口不可用：请确认租户和应用已加入该 OpenAPI 灰度';
  }
  return '飞书请求失败（HTTP ' + statusCode + '，code ' + (Number.isFinite(code) ? code : '未知')
    + '）：' + rawMessage;
}

function requestJson(path, options) {
  const requestOptions = options || {};
  const method = requestOptions.method || 'POST';
  const hasBody = method !== 'GET';
  const body = hasBody ? JSON.stringify(requestOptions.body || {}) : '';
  const headers = Object.assign({}, requestOptions.headers || {});
  if (hasBody) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = Buffer.byteLength(body);
  }

  return new Promise(function (resolve, reject) {
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path,
      method,
      headers,
      timeout: 20000
    }, function (res) {
      const chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          reject(new Error('飞书返回了无法解析的响应（HTTP ' + res.statusCode + '）'));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(describeFeishuFailure(
            parsed,
            res.statusCode,
            requestOptions.operation
          )));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('timeout', function () { req.destroy(new Error('飞书请求超时')); });
    req.on('error', reject);
    if (hasBody) req.end(body);
    else req.end();
  });
}

function getCredentials(params, injectedSecrets) {
  const appId = String(params && params.app_id || '').trim();
  const appSecret = String(injectedSecrets && injectedSecrets.app_secret || '').trim();
  if (!APP_ID_PATTERN.test(appId)) throw new Error('请先在插件设置中填写有效的飞书 App ID');
  if (!appSecret) throw new Error('请先在插件设置中填写飞书 App Secret');
  return { appId, appSecret };
}

async function getTenantToken(appId, appSecret) {
  const response = await requestJson(TOKEN_PATH, {
    operation: 'token',
    body: { app_id: appId, app_secret: appSecret }
  });
  if (response.code !== 0 || !response.tenant_access_token) {
    throw new Error(describeFeishuFailure(response, 200, 'token'));
  }
  return response.tenant_access_token;
}

function validateParams(input) {
  const dateStart = Number(input.date_start);
  const dateEnd = Number(input.date_end);
  if (!Number.isSafeInteger(dateStart) || !Number.isSafeInteger(dateEnd)
      || dateStart <= 0 || dateEnd <= 0) {
    throw new Error('date_start 和 date_end 必须是有效的 Unix 秒时间戳');
  }
  if (dateEnd < dateStart) throw new Error('date_end 不能早于 date_start');
  if (dateEnd - dateStart > 365 * 86400) {
    throw new Error('查询时间跨度不能超过 365 天');
  }

  const subjectType = Number(input.subject_type);
  const allowedBySubjectType = {
    1: new Set([1, 2, 4]),
    2: new Set([1]),
    3: new Set([5, 6, 7, 8])
  };
  if (!allowedBySubjectType[subjectType]) {
    throw new Error('subject_type 仅支持 1、2、3');
  }
  if (!Array.isArray(input.subjects) || input.subjects.length === 0) {
    throw new Error('subjects 不能为空');
  }

  let totalEntities = 0;
  let departmentEntities = 0;
  const subjects = input.subjects.map(function (subject) {
    const entityType = Number(subject && subject.entity_type);
    if (!allowedBySubjectType[subjectType].has(entityType)) {
      throw new Error('entity_type ' + entityType + ' 与 subject_type ' + subjectType + ' 不匹配');
    }
    if (!Array.isArray(subject.entity_ids) || subject.entity_ids.length === 0) {
      throw new Error('每个 subject 的 entity_ids 不能为空');
    }
    const entityIds = subject.entity_ids.map(function (id) {
      const value = String(id);
      if (!value) throw new Error('entity_ids 不能包含空值');
      return value;
    });
    totalEntities += entityIds.length;
    if (entityType === 1) departmentEntities += entityIds.length;
    return { entity_type: entityType, entity_ids: entityIds };
  });

  if (totalEntities > 100) throw new Error('实体总数不能超过 100');
  if (departmentEntities > 1) throw new Error('部门实体最多只能查询 1 个');

  const query = new URLSearchParams();
  if (input.user_id_type) query.set('user_id_type', String(input.user_id_type));
  if (input.department_id_type) {
    query.set('department_id_type', String(input.department_id_type));
  }
  if (input.page_size !== undefined) {
    const pageSize = Number(input.page_size);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new Error('page_size 必须是 1 到 100 的整数');
    }
    query.set('page_size', String(pageSize));
  }
  if (input.page_token) query.set('page_token', String(input.page_token));

  return {
    path: QUERY_PATH + (query.toString() ? '?' + query.toString() : ''),
    body: {
      date_start: dateStart,
      date_end: dateEnd,
      subject_type: subjectType,
      subjects
    }
  };
}

async function queryUsageDetail(input, injectedSecrets) {
  const credentials = getCredentials(input, injectedSecrets);
  const request = validateParams(input);
  const token = await getTenantToken(credentials.appId, credentials.appSecret);
  const response = await requestJson(request.path, {
    operation: 'usage',
    headers: { Authorization: 'Bearer ' + token },
    body: request.body
  });
  if (response.code !== 0) {
    throw new Error(describeFeishuFailure(response, 200, 'usage'));
  }
  return response;
}

async function batchGetDepartments(departmentIds, token) {
  const departmentById = new Map();
  for (let offset = 0; offset < departmentIds.length; offset += 50) {
    const query = new URLSearchParams();
    departmentIds.slice(offset, offset + 50).forEach(function (departmentId) {
      query.append('department_ids', departmentId);
    });
    query.set('department_id_type', 'department_id');
    query.set('user_id_type', 'open_id');

    const response = await requestJson(DEPARTMENT_BATCH_PATH + '?' + query.toString(), {
      method: 'GET',
      operation: 'contact',
      headers: { Authorization: 'Bearer ' + token }
    });
    if (response.code !== 0) {
      throw new Error(describeFeishuFailure(response, 200, 'contact'));
    }
    const departments = response.data && Array.isArray(response.data.items)
      ? response.data.items
      : [];
    departments.forEach(function (department) {
      if (department && department.department_id && department.name) {
        departmentById.set(String(department.department_id), String(department.name));
      }
    });
  }
  return departmentById;
}

async function batchGetUsers(input, injectedSecrets) {
  const credentials = getCredentials(input, injectedSecrets);
  if (!Array.isArray(input.user_ids) || input.user_ids.length < 1
      || input.user_ids.length > 50) {
    throw new Error('user_ids 必须包含 1 到 50 个员工 ID');
  }
  const userIdType = input.user_id_type === 'user_id' ? 'user_id' : 'open_id';
  const token = await getTenantToken(credentials.appId, credentials.appSecret);
  const items = [];

  for (const rawUserId of input.user_ids) {
    const userId = String(rawUserId || '');
    if (!userId) throw new Error('user_ids 不能包含空值');
    const path = USER_PATH + encodeURIComponent(userId)
      + '?user_id_type=' + encodeURIComponent(userIdType)
      + '&department_id_type=department_id';
    const response = await requestJson(path, {
      method: 'GET',
      operation: 'contact',
      headers: { Authorization: 'Bearer ' + token }
    });
    if (response.code !== 0) {
      throw new Error(describeFeishuFailure(response, 200, 'contact'));
    }
    if (response.data && response.data.user) items.push(response.data.user);
  }

  const departmentIds = Array.from(new Set(items.flatMap(function (user) {
    return Array.isArray(user.department_ids)
      ? user.department_ids.map(String).filter(Boolean)
      : [];
  })));
  const departmentById = await batchGetDepartments(departmentIds, token);

  items.forEach(function (user) {
    const userDepartmentIds = Array.isArray(user.department_ids)
      ? user.department_ids.map(String).filter(Boolean)
      : [];
    user.department_names = userDepartmentIds
      .map(function (departmentId) { return departmentById.get(departmentId); })
      .filter(Boolean);

    const primaryOrder = Array.isArray(user.orders)
      ? user.orders.find(function (order) {
        return order && order.is_primary_dept === true && order.department_id;
      })
      : null;
    const primaryDepartmentId = primaryOrder
      ? String(primaryOrder.department_id)
      : userDepartmentIds[0];
    user.primary_department_name = primaryDepartmentId
      ? departmentById.get(primaryDepartmentId) || user.department_names[0] || ''
      : '';
  });

  return { code: 0, data: { items }, msg: 'success' };
}

readline.createInterface({ input: process.stdin }).on('line', async function (line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    rpcError(null, -32700, 'Parse error');
    return;
  }

  const params = request.params || {};
  const secrets = request.cindy && request.cindy.secrets;
  try {
    let result;
    if (request.method === 'query_usage_detail') {
      result = await queryUsageDetail(params, secrets);
    } else if (request.method === 'batch_get_users') {
      result = await batchGetUsers(params, secrets);
    } else {
      rpcError(request.id, -32601, 'Method not found');
      return;
    }
    reply({ jsonrpc: '2.0', id: request.id, result });
  } catch (error) {
    rpcError(request.id, -32001, error && error.message ? error.message : '查询失败');
  }
});
