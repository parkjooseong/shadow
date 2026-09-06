export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new ApiError('계정 서버에 연결할 수 없습니다. 서버 실행과 주소를 확인해 주세요.', response.status);
  const data = await response.json();
  if (!response.ok) throw new ApiError(typeof data.error === 'string' ? data.error : '요청을 처리하지 못했습니다.', response.status);
  return data as T;
}
