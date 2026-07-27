/* global cindy */

var QUERY_URL = 'https://open.feishu.cn/open-apis/admin/v1/ai_usage_detail/query';
var APP_ID_PATTERN = /^cli_[A-Za-z0-9]+$/;

function fail(message) {
  return { ok: false, message: message };
}

function validateArgs(input) {
  var dateStart = Number(input.date_start);
  var dateEnd = Number(input.date_end);
  if (!Number.isSafeInteger(dateStart) || !Number.isSafeInteger(dateEnd) || dateStart <= 0 || dateEnd <= 0) {
    return fail('date_start 和 date_end 必须是有效的 Unix 秒时间戳');
  }
  if (dateEnd < dateStart) return fail('date_end 不能早于 date_start');
  if (dateEnd - dateStart > 365 * 86400) return fail('查询时间跨度不能超过 365 天');

  var subjectType = Number(input.subject_type);
  var allowed = {
    1: { 1: true, 2: true, 4: true },
    2: { 1: true },
    3: { 5: true, 6: true, 7: true, 8: true }
  };
  if (!allowed[subjectType]) return fail('subject_type 仅支持 1、2、3');
  if (!Array.isArray(input.subjects) || input.subjects.length === 0) return fail('subjects 不能为空');

  var totalEntities = 0;
  var departmentEntities = 0;
  var subjects = [];
  for (var i = 0; i < input.subjects.length; i += 1) {
    var subject = input.subjects[i] || {};
    var entityType = Number(subject.entity_type);
    if (!allowed[subjectType][entityType]) {
      return fail('entity_type ' + entityType + ' 与 subject_type ' + subjectType + ' 不匹配');
    }
    if (!Array.isArray(subject.entity_ids) || subject.entity_ids.length === 0) {
      return fail('每个 subject 的 entity_ids 不能为空');
    }
    var ids = [];
    for (var j = 0; j < subject.entity_ids.length; j += 1) {
      var id = String(subject.entity_ids[j]);
      if (!id) return fail('entity_ids 不能包含空值');
      ids.push(id);
    }
    totalEntities += ids.length;
    if (entityType === 1) departmentEntities += ids.length;
    subjects.push({ entity_type: entityType, entity_ids: ids });
  }
  if (totalEntities > 100) return fail('实体总数不能超过 100');
  if (departmentEntities > 1) return fail('部门实体最多只能查询 1 个');

  var query = [];
  if (input.user_id_type) query.push('user_id_type=' + encodeURIComponent(String(input.user_id_type)));
  if (input.department_id_type) query.push('department_id_type=' + encodeURIComponent(String(input.department_id_type)));
  if (input.page_size !== undefined) {
    var pageSize = Number(input.page_size);
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      return fail('page_size 必须是 1 到 100 的整数');
    }
    query.push('page_size=' + pageSize);
  }
  if (input.page_token) query.push('page_token=' + encodeURIComponent(String(input.page_token)));

  return {
    ok: true,
    url: QUERY_URL + (query.length ? '?' + query.join('&') : ''),
    body: {
      date_start: dateStart,
      date_end: dateEnd,
      subject_type: subjectType,
      subjects: subjects
    }
  };
}

async function readAppId() {
  var response = await fetch('/kv');
  if (!response.ok) throw new Error('无法读取 App ID 配置');
  var config = await response.json();
  var appId = config && typeof config.app_id === 'string' ? config.app_id.trim() : '';
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error('请先在插件设置中填写有效的飞书 App ID');
  }
  return appId;
}

async function callWorker(tool, args) {
  var appId = await readAppId();
  var response = await cindy.node.request({
    method: tool,
    params: Object.assign({}, args || {}, { app_id: appId })
  });
  if (!response.ok) return fail(response.message || '查询失败');
  return { ok: true, result: response.result };
}

async function queryUsageDetail(args) {
  var request = validateArgs(args || {});
  if (!request.ok) return request;
  return callWorker('query_usage_detail', args);
}

async function batchGetUsers(args) {
  var input = args || {};
  if (!Array.isArray(input.user_ids) || input.user_ids.length < 1 || input.user_ids.length > 50) {
    return fail('user_ids 必须包含 1 到 50 个员工 ID');
  }
  var userIdType = input.user_id_type === 'user_id' ? 'user_id' : 'open_id';
  var items = [];
  var userIds = [];
  for (var i = 0; i < input.user_ids.length; i += 1) {
    var userId = String(input.user_ids[i] || '');
    if (!userId) return fail('user_ids 不能包含空值');
    userIds.push(userId);
  }
  return callWorker('batch_get_users', {
    user_ids: userIds,
    user_id_type: userIdType
  });
}

cindy.onHostMessage(async function (msg) {
  if (!msg || msg.type !== 'tool-call') return;
  if (msg.tool !== 'query_usage_detail' && msg.tool !== 'batch_get_users') {
    cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: '未知工具：' + msg.tool });
    return;
  }
  try {
    var result = msg.tool === 'query_usage_detail'
      ? await queryUsageDetail(msg.args || {})
      : await batchGetUsers(msg.args || {});
    if (result.ok) {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: result.result });
    } else {
      cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, message: result.message || '查询失败' });
    }
  } catch (error) {
    cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: false,
      message: '查询失败：' + (error && error.message ? error.message : String(error))
    });
  }
});
