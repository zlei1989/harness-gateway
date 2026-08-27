/** 令牌字符集：0-9a-zA-Z（用户需求指定）。 */
const CHARSET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * 生成接入令牌（默认 8 位）。
 * rand 可注入便于测试确定性断言；生产用 Math.random（本地接入令牌，非密码学场景）。
 */
export function randomToken(length = 8, rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const idx = Math.min(Math.floor(rand() * CHARSET.length), CHARSET.length - 1);
    out += CHARSET.charAt(idx);
  }
  return out;
}
