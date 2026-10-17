#!/usr/bin/env node
/**
 * Kaggle 凭据探针 —— 供 setup-kaggle.ps1 调用，也可单独使用。
 *
 * GET https://www.kaggle.com/api/v1/hello 对有效凭据返回
 * {"userName":"<你的用户名>","time":"..."}，无效凭据返回 401/403。
 * 因此它一次就能回答两件事：密钥是否可用、账号叫什么名字
 * （MCP 服务器解析 `owner` 时正需要用户名）。
 *
 * 用 Node 而不是 Invoke-RestMethod 的原因：Node 自带 TLS 栈，
 * 在受限沙箱 / 老版本 .NET 下都能连通；PS 侧仅作为兜底。
 *
 * 凭据来源（按顺序取第一个）：
 *   --token-file <路径>           纯 token 文件，如 ~/.kaggle/access_token
 *   --json-file  <路径>           {"username":..,"key":..}，如 kaggle.json
 *   环境变量 KAGGLE_HELLO_TOKEN   Bearer Token（KGAT_…）
 *   环境变量 KAGGLE_HELLO_USERNAME + KAGGLE_HELLO_KEY
 *
 * stdout 永远只有一行 JSON；密钥不会被打印或回显。
 * 退出码：0 = 凭据有效，1 = 被拒绝 / 连不通，2 = 没给凭据 / 用法错误。
 */
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';

const HELLO_URL = process.env.KAGGLE_HELLO_URL ?? 'https://www.kaggle.com/api/v1/hello';
const USAGE = '用法: node tools/kaggle-hello.mjs [--token-file <路径> | --json-file <路径>]\n';

/**
 * 用一个专用异常来终止 main()：绝不能在写完 stdout 之后调用 process.exit()。
 *
 * stdout 是管道时（PowerShell 捕获输出就是这种情况），Windows 上的 libuv 会在
 * 句柄仍处于关闭中时断言崩溃：
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
 * 并可能以 0xC0000409 fail-fast 收场。因此这里只抛异常解开调用栈，
 * 让事件循环自然结束、stdout 完整刷出，退出码交给 process.exitCode。
 */
class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`);
    this.code = code;
  }
}

/** 输出唯一那行 JSON，并终止后续流程。 */
function emit(obj, code) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
  throw new Exit(code);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--token-file') out.tokenFile = argv[++i];
    else if (a === '--json-file') out.jsonFile = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/**
 * 一次性的 HTTPS GET。
 *
 * 刻意不用全局 fetch：undici 的连接池会保活、AbortSignal.timeout 还会留下定时器，
 * 进程要多挂十几秒才退出。`agent: false` 让连接用完即关，脚本立刻收尾。
 */
function httpsGet(url, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'GET', headers, agent: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时 (${timeoutMs}ms)`)));
    req.on('error', reject);
    req.end();
  });
}

/** 网络抖动在这个环境里很常见（MCP 服务器本身也带重试），这里重试 3 次。 */
async function getWithRetry(url, headers, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await httpsGet(url, headers);
    } catch (e) {
      lastError = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
  throw lastError;
}

function resolveAuth(args) {
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8').trim();
    } catch {
      return '';
    }
  };

  if (args.tokenFile) {
    const t = read(path.resolve(args.tokenFile));
    if (!t) return { error: `token 文件为空或不可读: ${args.tokenFile}` };
    return { header: `Bearer ${t}`, kind: 'bearer' };
  }

  if (args.jsonFile) {
    try {
      const j = JSON.parse(read(path.resolve(args.jsonFile)));
      if (j?.username && j?.key) {
        return { header: `Basic ${Buffer.from(`${j.username}:${j.key}`).toString('base64')}`, kind: 'basic' };
      }
      return { error: `kaggle.json 缺少 username/key: ${args.jsonFile}` };
    } catch (e) {
      return { error: `kaggle.json 解析失败: ${e.message}` };
    }
  }

  const token = process.env.KAGGLE_HELLO_TOKEN?.trim();
  if (token) return { header: `Bearer ${token}`, kind: 'bearer' };

  const user = process.env.KAGGLE_HELLO_USERNAME?.trim();
  const key = process.env.KAGGLE_HELLO_KEY?.trim();
  if (user && key) {
    return { header: `Basic ${Buffer.from(`${user}:${key}`).toString('base64')}`, kind: 'basic' };
  }

  return { error: '没有拿到凭据' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const auth = resolveAuth(args);
  if (auth.error) emit({ ok: false, status: 0, error: auth.error }, 2);

  let res;
  try {
    res = await getWithRetry(HELLO_URL, {
      Authorization: auth.header,
      Accept: 'application/json',
      'User-Agent': 'kaggle-free-gpu-setup/0.1',
    });
  } catch (e) {
    emit({ ok: false, status: 0, error: `网络不通: ${e.name}: ${e.message}` }, 1);
  }

  const raw = res.body;
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    /* 非 JSON 响应（例如 HTML 错误页） */
  }

  if (res.status < 200 || res.status >= 300) {
    const detail = (json?.message ?? raw.slice(0, 200) ?? '').trim();
    emit({ ok: false, status: res.status, kind: auth.kind, error: detail || `HTTP ${res.status}` }, 1);
  }

  const userName = json?.userName ?? null;
  if (!userName) {
    emit({ ok: false, status: res.status, kind: auth.kind, error: `响应中没有 userName: ${raw.slice(0, 200)}` }, 1);
  }

  emit({ ok: true, status: res.status, kind: auth.kind, userName }, 0);
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof Exit) {
    process.exitCode = e.code;
  } else {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 0, error: `内部错误: ${e?.message ?? e}` })}\n`);
    process.exitCode = 1;
  }
}
