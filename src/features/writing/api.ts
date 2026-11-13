/** 同源 Function 请求helper：只暴露已知错误码对应的中文文案，不透传上游报错。 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function requestJson(
  url: string,
  init: RequestInit = {},
  messages: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  } catch {
    throw new ApiError('请求没有完成。', 'network_error');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ApiError('没有访问该服务的权限。', 'access_denied', response.status);
  }
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('服务返回了无法识别的响应。', 'invalid_response', response.status);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError('服务返回了非法 JSON。', 'invalid_response', response.status);
  }
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const code =
    typeof body?.error === 'string'
      ? body.error
      : (!response.ok || body?.ok === false) && typeof body?.code === 'string'
        ? body.code
        : response.ok
          ? null
          : 'request_failed';
  if (!response.ok || body?.ok === false || code) {
    const resolved = code ?? 'request_failed';
    throw new ApiError(
      Object.prototype.hasOwnProperty.call(messages, resolved)
        ? messages[resolved]
        : '服务调用失败。',
      resolved,
      response.status,
    );
  }
  return data;
}
