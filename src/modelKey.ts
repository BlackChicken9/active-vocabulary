const STORAGE_KEY = 'tianchi.modelkey';

/** 和网关同一套形状要求：短串、纯 key 字符，脏输入在本地就拦掉，别拿它打一次上游。 */
const MODEL_KEY_OK = /^[A-Za-z0-9_\-.]{8,200}$/;

/** 访客自带的模型密钥：只存这台设备，随请求头发给 Function，界面不回显、不写日志。 */
export function loadModelKey(): string {
  return localStorage.getItem(STORAGE_KEY)?.trim() ?? '';
}

export function saveModelKey(raw: string): boolean {
  const key = raw.trim();
  if (!MODEL_KEY_OK.test(key)) return false;
  localStorage.setItem(STORAGE_KEY, key);
  return true;
}

export function clearModelKey(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/** 尾号只留字母数字，用来确认「存进去的是哪一个 key」而不泄露它。 */
export function keyTail(key: string): string {
  return key.slice(-4).replace(/[^A-Za-z0-9]/g, '');
}
