export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(path: string, method = 'GET', body?: unknown, options: { accountId?: string; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.accountId) headers['X-Shadow-Account'] = options.accountId;
  const response = await fetch(path, { method, credentials: 'same-origin', headers, body: body === undefined ? undefined : JSON.stringify(body), signal: options.signal ?? AbortSignal.timeout(30_000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new ApiError('계정 서버에 연결할 수 없습니다. 서버 실행과 주소를 확인해 주세요.', response.status);
  const data = await response.json();
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : '요청을 처리하지 못했습니다.', response.status);
  return data as T;
}
