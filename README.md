# 飞书 AI 用量查询

由 XD-GUYI 开发的 Cindy 插件。使用用户自己的飞书企业自建应用，查询部门、成员或应用的 AI 用量，并将成员 ID 映射为真实姓名和邮箱。

## 安装

在 [Releases](../../releases) 下载最新的 `.cindy` 文件并打开，在 Cindy 的确认框中完成安装和启用。

## 使用前准备

在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，并开通：

```text
admin:ai_usage_detail:read
contact:contact.base:readonly
contact:user.base:readonly
contact:user.email:readonly
contact:user.employee_id:readonly
```

还需要：

1. 将应用的通讯录数据权限范围设置为全体成员或需要分析的部门。
2. 发布包含上述权限的应用版本。
3. 确认租户和应用已加入 AI 用量查询 OpenAPI 灰度。

应用可用范围不影响本插件通过 `tenant_access_token` 调用服务端 API；实际可读取范围由应用 Scope 和数据权限范围决定。

## 配置

进入 Cindy 的「插件」→「飞书 AI 用量查询」→「设置」，填写：

- 飞书 App ID
- 飞书 App Secret

App Secret 由 Cindy 加密保存，只在查询时临时注入插件 Worker。插件不会回填密钥，也不需要用户手工维护 `tenant_access_token`。

## 使用示例

```text
查询昨天飞书 AI 通用额度消耗 Top10，显示真实姓名。
```

也可以显式使用：

```text
$feishu-ai-usage 查询昨天的 AI 用量
```

## 源码结构

```text
ghost.json         插件清单、工具声明和权限配置
main.js            Cindy 沙箱入口
node/worker.cjs    飞书 Token 交换与 OpenAPI 调用
settings.html      设置界面
settings.js        设置状态与凭证保存逻辑
```

## 安全说明

- 不要把 App Secret 写入源码、聊天消息或 Git 仓库。
- 每位用户应配置自己有权管理的飞书应用。
- 姓名和邮箱属于组织通讯录数据，请仅在授权范围内使用。
