/**
 * dsh-remote-access — Client 半边（已安装包 bundle 入口）。
 *
 * 在 settings.section 槽位注册「远程访问」选项页：主机名称 / 令牌密钥
 * （含「生成」按钮）/ 网关地址 / 启用开关；启用后调 host 半边的
 * remote-enable 启动隧道客户端，连接成功后展示选择页深链二维码
 * （qrcode-generator 前端动态生成 SVG）与「立即查看」按钮。
 * 通过 /dsh-remote-access/invoke（同源 fetch）与 host 半边通信。
 * enabled 不持久化：面板挂载时若 host 仍有存活连接，先 remote-disable
 * 复位——每次打开都是关闭，必须手动连接。
 */

import { randomToken } from '../shared/random-token';

import { qrModules } from './qrcode-svg';
import { h, React } from './react';

import type { ClientCtx } from './services';
import type { ConnectionStatusDto, RemoteInvokeResult, RemoteStatusDto } from '../shared/types';

const PLUGIN_ID = 'dsh-remote-access';
const INVOKE_PATH = '/dsh-remote-access/invoke';
const LOG_PREFIX = '[dsh-remote-access]';

function logError(msg: string, err?: unknown): void {
  const e = err as Error | null | undefined;
  console.error(LOG_PREFIX + ' [ERROR] ' + msg + (e ? `\n${e.stack ?? e.message}` : ''));
}

/** 调用 host 半边的 remote-* 处理器（POST 到 harness webserver 路由）。 */
function hostCall(
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const base = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
  return fetch(base + INVOKE_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params: params ?? {} }),
  }).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<Record<string, unknown>>;
  });
}

const S: Record<string, React.CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 520, padding: 16, color: '#e6e6eb' },
  field: { display: 'flex', flexDirection: 'column', gap: 6 },
  label: { fontSize: 13, color: '#c9c9d1' },
  input: { background: '#121218', color: '#e6e6eb', border: '1px solid #34343e', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', width: '100%' },
  tokenRow: { display: 'flex', gap: 8 },
  genBtn: { background: 'transparent', color: '#c9c9d1', border: '1px solid #34343e', borderRadius: 8, padding: '0 14px', fontSize: 13, cursor: 'pointer', whiteSpace: 'nowrap' },
  switchRow: { display: 'flex', alignItems: 'center', gap: 10 },
  status: { fontSize: 12, color: '#9fd0ff' },
  error: { fontSize: 12, color: '#f58b8b' },
  warn: { fontSize: 12, color: '#f5c56b' },
  qrWrap: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: 12, background: '#fff', borderRadius: 12, alignSelf: 'flex-start' },
  linkBtn: { background: 'none', border: 'none', color: '#7db4ff', fontSize: 13, cursor: 'pointer', padding: 4, textDecoration: 'underline' },
  hint: { fontSize: 11, color: '#8b8b96', lineHeight: 1.6 },
};

/** 二维码 SVG（白色衬底容器内；cell 4px + 4 模块 quiet zone）。 */
function QrImage(props: { url: string }): React.ReactNode {
  const matrix = React.useMemo(() => qrModules(props.url), [props.url]);
  const quiet = 4;
  const total = matrix.size + quiet * 2;
  const rects: React.ReactNode[] = [];
  for (let r = 0; r < matrix.size; r += 1) {
    for (let c = 0; c < matrix.size; c += 1) {
      if (matrix.isDark(r, c)) {
        rects.push(h('rect', { key: `${r}-${c}`, x: c + quiet, y: r + quiet, width: 1, height: 1 }));
      }
    }
  }
  return h(
    'svg',
    { viewBox: `0 0 ${total} ${total}`, width: total * 4, height: total * 4, shapeRendering: 'crispEdges', role: 'img', 'aria-label': '远程访问二维码' },
    h('rect', { x: 0, y: 0, width: total, height: total, fill: '#fff' }),
    h('g', { fill: '#000' }, rects),
  );
}

/** 设置面板主体。 */
function RemoteAccessSection(): React.ReactNode {
  const el = h;
  const hostnameState = React.useState('');
  const hostname = hostnameState[0];
  const setHostname = hostnameState[1];
  const tokenState = React.useState('');
  const token = tokenState[0];
  const setToken = tokenState[1];
  const gatewayState = React.useState('');
  const gateway = gatewayState[0];
  const setGateway = gatewayState[1];
  const envHostState = React.useState('');
  const envHostname = envHostState[0];
  const setEnvHostname = envHostState[1];
  const enabledState = React.useState(false);
  const enabled = enabledState[0];
  const setEnabled = enabledState[1];
  const connState = React.useState<ConnectionStatusDto>({ state: 'off' });
  const conn = connState[0];
  const setConn = connState[1];
  const errorState = React.useState('');
  const error = errorState[0];
  const setError = errorState[1];
  const warningState = React.useState('');
  const warning = warningState[0];
  const setWarning = warningState[1];
  // 已连接状态下修改配置的保存提示（「修改将在下次启用时生效」）
  const savedHintState = React.useState('');
  const savedHint = savedHintState[0];
  const setSavedHint = savedHintState[1];

  // 挂载：拉取配置与状态；若 host 仍有存活连接（上一轮面板开启未关），
  // 先 disable 复位——「每次打开都是关闭，必须手动连接」
  React.useEffect(() => {
    let cancelled = false;
    hostCall('remote-status')
      .then(async (raw) => {
        const res = raw as unknown as RemoteStatusDto;
        if (cancelled) return;
        setHostname(res.config.hostname);
        setToken(res.config.token);
        setGateway(res.config.gateway);
        setEnvHostname(res.envHostname);
        if (res.warning) setWarning(res.warning);
        if (res.connection.state !== 'off') {
          const off = (await hostCall('remote-disable')) as unknown as RemoteInvokeResult;
          if (!cancelled) setConn(off.connection ?? { state: 'off' });
        } else {
          setConn(res.connection);
        }
      })
      .catch((err) => {
        logError('读取远程访问状态失败', err);
        if (!cancelled) setError('读取配置失败：' + String((err as Error)?.message ?? err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启用期间轮询连接状态（连接中/已连接/失败/断线重连）
  React.useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = (): void => {
      hostCall('remote-status')
        .then((raw) => {
          if (cancelled) return;
          const res = raw as unknown as RemoteStatusDto;
          setConn(res.connection);
        })
        .catch(() => undefined); // 轮询失败静默，下一轮重试
    };
    poll();
    const id = window.setInterval(poll, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  /** 失焦保存（三个字段一起提交，host 侧缺省回落已保存值）。 */
  const saveField = (): void => {
    hostCall('remote-save-config', { hostname, token, gateway })
      .then((raw) => {
        const res = raw as unknown as RemoteInvokeResult;
        setError(res.ok ? '' : (res.error ?? '保存失败'));
        if (res.ok) {
          // 已连接状态下修改配置不自动重连，提示下次启用时生效；
          // onBlur 触发的回调直接读本渲染闭包内的 conn/enabled 即可
          setSavedHint(
            enabled && conn.state === 'connected' ? '已保存。修改将在下次启用时生效' : '',
          );
        } else {
          setSavedHint('');
        }
      })
      .catch((err) => {
        setError('保存失败：' + String((err as Error)?.message ?? err));
        setSavedHint('');
      });
  };

  /** 开关切换：开 = remote-enable（携带当前表单值，未失焦的编辑也生效）。 */
  const onToggle = (next: boolean): void => {
    setEnabled(next);
    setError('');
    setSavedHint(''); // 切换开关后旧的保存提示不再适用
    if (next) {
      setConn({ state: 'connecting' });
      hostCall('remote-enable', { hostname, token, gateway })
        .then((raw) => {
          const res = raw as unknown as RemoteInvokeResult;
          if (!res.ok) {
            setEnabled(false);
            setConn({ state: 'off' });
            setError(res.error ?? '启用失败');
            return;
          }
          if (res.connection) setConn(res.connection);
        })
        .catch((err) => {
          setEnabled(false);
          setConn({ state: 'off' });
          setError('启用失败：' + String((err as Error)?.message ?? err));
        });
    } else {
      hostCall('remote-disable')
        .then((raw) => {
          const res = raw as unknown as RemoteInvokeResult;
          if (res.connection) setConn(res.connection);
        })
        .catch(() => setConn({ state: 'off' }));
    }
  };

  const connected = enabled && conn.state === 'connected' && !!conn.deepLink;
  const statusText = !enabled
    ? ''
    : conn.state === 'connecting'
      ? '连接中…'
      : conn.state === 'connected'
        ? `已连接（tunnelId: ${conn.tunnelId ?? '-'}）`
        : conn.state === 'error'
          ? `连接失败：${conn.error ?? '未知错误'}`
          : '';

  return el(
    'div',
    { style: S.wrap },
    el(
      'div',
      { style: S.field },
      el('label', { style: S.label, htmlFor: 'dsh-ra-hostname' }, '主机名称'),
      el('input', {
        id: 'dsh-ra-hostname',
        style: S.input,
        value: hostname,
        placeholder: envHostname ? `默认为环境主机名：${envHostname}` : '默认为环境主机名',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setHostname(e.target.value),
        onBlur: saveField,
      }),
    ),
    el(
      'div',
      { style: S.field },
      el('label', { style: S.label, htmlFor: 'dsh-ra-token' }, '令牌密钥'),
      el(
        'div',
        { style: S.tokenRow },
        el('input', {
          id: 'dsh-ra-token',
          style: S.input,
          value: token,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setToken(e.target.value),
          onBlur: saveField,
        }),
        el(
          'button',
          {
            type: 'button',
            style: S.genBtn,
            onClick: () => {
              const next = randomToken(8);
              setToken(next);
              // 生成后立即保存（不等失焦）；已连接时同样提示下次启用时生效
              hostCall('remote-save-config', { hostname, token: next, gateway })
                .then((raw) => {
                  const res = raw as unknown as RemoteInvokeResult;
                  setSavedHint(
                    res.ok && enabled && conn.state === 'connected'
                      ? '已保存。修改将在下次启用时生效'
                      : '',
                  );
                })
                .catch(() => undefined);
            },
          },
          '生成',
        ),
      ),
    ),
    el(
      'div',
      { style: S.field },
      el('label', { style: S.label, htmlFor: 'dsh-ra-gateway' }, '网关地址'),
      el('textarea', {
        id: 'dsh-ra-gateway',
        style: { ...S.input, minHeight: 56, resize: 'vertical', lineHeight: 1.5 },
        rows: 2,
        value: gateway,
        placeholder: 'harness-gateway.7qbjs.com',
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setGateway(e.target.value),
        onBlur: saveField,
      }),
    ),
    el(
      'div',
      { style: S.switchRow },
      el('input', {
        id: 'dsh-ra-enabled',
        type: 'checkbox',
        role: 'switch',
        checked: enabled,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => onToggle(e.target.checked),
      }),
      el('label', { style: S.label, htmlFor: 'dsh-ra-enabled' }, '启用'),
      statusText ? el('span', { style: conn.state === 'error' ? S.error : S.status }, statusText) : null,
    ),
    error ? el('div', { style: S.error }, error) : null,
    warning ? el('div', { style: S.warn }, warning) : null,
    savedHint ? el('div', { style: S.hint }, savedHint) : null,
    connected
      ? el(
        'div',
        { style: S.qrWrap },
        el(QrImage, { url: conn.deepLink ?? '' }),
        el(
          'button',
          {
            type: 'button',
            style: { ...S.linkBtn, color: '#1d4ed8' },
            onClick: () => window.open(conn.deepLink, '_blank'),
          },
          '立即查看',
        ),
      )
      : null,
    el(
      'div',
      { style: S.hint },
      '打开「启用」后，本机 DSH 将接入网关；用移动端扫描二维码即可快速进入。每次打开本页开关均为关闭状态，需手动连接。',
    ),
  );
}

/**
 * 插件入口：注册 settings.section 槽位组件。
 * 经 ctx.effect 登记清理器，插件卸载时自动移除。
 */
function apply(ctx: ClientCtx): void {
  ctx.effect(function () {
    return ctx.slots.inject('settings.section', function () {
      return ctx.slots.register(
        { name: 'settings.section', id: 'remote-access', order: 100, label: '远程访问' },
        RemoteAccessSection as unknown as (props: Record<string, unknown>) => unknown,
      );
    });
  }, 'dsh-remote-access: settings section');

  console.info(LOG_PREFIX + ' [INFO] client 插件已加载（槽位 settings.section）');
}

// loader 契约：bundle 外层包裹（tsup banner）提供局部 module/exports，
// 这里导出插件表面供 window.__ModuleLoader__ 读取
module.exports = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply,
};
