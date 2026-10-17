#!/usr/bin/env node
/**
 * 一键创建飞书机器人应用（设备授权流程 / Device Authorization Grant, RFC 8628）
 * One-click Feishu bot app creation.
 *
 * 原理：调用 @larksuiteoapi/node-sdk 的 registerApp()，生成一个授权链接；
 * 用户在飞书里打开链接并确认后，平台自动创建应用（预填权限与事件订阅），
 * 脚本随即拿到 App ID / App Secret。
 *
 * 官方文档：https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/scan-to-create-an-app-in-one-click-nodejs
 * 前提：@larksuiteoapi/node-sdk >= 1.61.1（本项目依赖已满足）
 *
 * 用法：
 *   node scripts/create-feishu-app.mjs ["应用名称"] ["应用描述"]
 *
 * 输出：
 *   - 终端打印授权链接（1 小时内有效），同时写入 .one-click-link.txt
 *   - 用户确认后写入 feishu-app-credentials.json（600 权限，含 App ID / Secret）
 *
 * 进阶：为已有应用增量补权限 —— 在 registerApp 中传入 appId（见下方注释），
 * 用户重新确认配置 diff 即可，不会创建新应用。
 */
import * as lark from '@larksuiteoapi/node-sdk';
import fs from 'node:fs';
import path from 'node:path';

const APP_NAME = process.argv[2] || 'OpenCode Live';
const APP_DESC = process.argv[3] || '实时状态卡片版 opencode 桥接机器人';

// 本项目所需的最小权限集合（与 README「飞书后台配置」一致）
const SCOPES = [
  'im:message:send_as_bot',            // 以应用身份发消息（含卡片）
  'im:message.p2p_msg:readonly',       // 接收单聊消息
  'im:message.group_at_msg:readonly',  // 接收群聊 @ 消息
  'im:message:readonly',               // 读取消息（下载消息中的文件）
  'im:resource',                       // 上传图片/文件资源
];

// 事件订阅：接收消息 v2.0
const EVENTS = ['im.message.receive_v1'];

const outDir = process.cwd();

console.log('=== 一键创建飞书机器人 ===');
console.log(`应用名称: ${APP_NAME}`);
console.log(`应用描述: ${APP_DESC}`);
console.log(`预填权限: ${SCOPES.join(', ')}`);
console.log(`预填事件: ${EVENTS.join(', ')}`);
console.log('');

try {
  const result = await lark.registerApp({
    appPreset: {
      name: APP_NAME,
      desc: APP_DESC,
    },
    addons: {
      // preset:false = 丢弃平台默认模板，确认页只展示下面显式声明的配置
      preset: false,
      scopes: { tenant: SCOPES },
      events: { items: { tenant: EVENTS } },
    },
    // 只允许创建新应用，避免误绑定已有应用
    createOnly: true,
    // 如需为已有应用补权限：去掉 createOnly，改为 appId: 'cli_xxx'
    // 如需自定义认证域名：domain: 'accounts.feishu.cn'（默认）
    onQRCodeReady(info) {
      console.log('请在飞书（手机或桌面端）打开下面的链接并确认授权：');
      console.log('');
      console.log(info.url);
      console.log('');
      console.log(`链接 ${info.expireIn} 秒内有效；确认页会展示上述应用名、权限与事件订阅。`);
      fs.writeFileSync(path.join(outDir, '.one-click-link.txt'), info.url + '\n');
    },
    onStatusChange(info) {
      if (info.status === 'slow_down') {
        console.log('[status] 平台请求降低轮询频率…');
      }
      if (info.status === 'domain_switched') {
        console.log('[status] 检测到 Lark 租户，已自动切换认证域名');
      }
    },
  });

  const outFile = path.join(outDir, 'feishu-app-credentials.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  fs.chmodSync(outFile, 0o600);

  console.log('');
  console.log('✅ 应用创建成功！');
  console.log(`App ID: ${result.client_id}`);
  console.log(`凭证已写入: ${outFile}（权限 600，请勿提交到版本库）`);
  console.log('');
  console.log('下一步：');
  console.log('  1. 把 App ID / Secret 填入 .env.runtime（参考 .env.example）');
  console.log('  2. chmod 600 .env.runtime');
  console.log('  3. npm run build && bash scripts/install-systemd-user.sh');
  console.log('  4. 在飞书里搜索刚创建的应用名，发送 !status 验证联通');
  console.log('');
  console.log('说明：一键创建的应用默认即为「长连接」订阅方式，无需在开发者后台额外设置。');
  console.log('若收不到消息，请到 开发者后台 → 事件与回调 → 订阅方式 确认已选择');
  console.log('「使用长连接接收事件/回调」（保存时 bridge 需处于运行状态）。');
} catch (e) {
  const code = e && e.code ? e.code : 'unknown_error';
  const desc = e && e.description ? e.description : (e && e.message) || String(e);
  console.error('');
  console.error(`❌ 创建失败: ${code} — ${desc}`);
  if (code === 'expired_token') {
    console.error('链接已过期，请重新运行本脚生成新链接。');
  }
  if (code === 'access_denied') {
    console.error('用户在确认页拒绝了授权。');
  }
  process.exit(1);
}
