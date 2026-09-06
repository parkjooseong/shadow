import type { AppState } from '../domain/types';
import { isAppState } from '../domain/validation';
import { api } from './api';

export const CLOUD_SYNC_KEY = 'shadow.cloudSync.v1';
export const CLOUD_SYNC_SETTINGS_EVENT = 'shadow:cloud-sync-settings-changed';
export interface CloudSyncSettings {
  version: 1;
  userId: string;
  baseline: string;
  revision: number;
  paused: boolean;
  lastSyncedAt: string | null;
  pendingPull?: { digest: string; revision: number };
}
export interface CloudState { state: AppState | null; revision: number }
export type SyncStatus = 'disabled' | 'idle' | 'syncing' | 'paused' | 'offline' | 'error';

export function readSyncSettings(): CloudSyncSettings | null {
  const raw = localStorage.getItem(CLOUD_SYNC_KEY);
  if (raw === null) return null;
  const value = JSON.parse(raw);
  if (value?.version !== 1 || typeof value.userId !== 'string' || !value.userId || value.userId.length > 100 || !/^[a-f0-9]{64}$/.test(value.baseline) || !Number.isSafeInteger(value.revision) || value.revision < 0 || typeof value.paused !== 'boolean' || !(value.lastSyncedAt === null || typeof value.lastSyncedAt === 'string')) throw new Error('자동 동기화 설정을 읽지 못했습니다. 끈 뒤 다시 설정해 주세요.');
  if (value.pendingPull && (!/^[a-f0-9]{64}$/.test(value.pendingPull.digest) || !Number.isSafeInteger(value.pendingPull.revision) || value.pendingPull.revision < 0)) throw new Error('자동 동기화 저장 확인 정보를 읽지 못했습니다.');
  return value;
}

export async function stateDigest(state: AppState): Promise<string> {
  return snapshotDigest(JSON.stringify(state));
}
export async function snapshotDigest(snapshot: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function acknowledgePull(settings: CloudSyncSettings, persistedDigest: string): CloudSyncSettings {
  if (!settings.pendingPull || settings.pendingPull.digest !== persistedDigest) return settings;
  const { pendingPull, ...rest } = settings;
  return { ...rest, baseline: pendingPull.digest, revision: pendingPull.revision, lastSyncedAt: new Date().toISOString() };
}

export function validateCloud(value: CloudState): CloudState {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !(value.state === null || isAppState(value.state))) throw new Error('서버 캘린더 형식이 올바르지 않습니다. 자동 동기화를 중지했습니다.');
  return value;
}

export function decideSync(local: string, remote: string | null, baseline: string): 'equal' | 'push' | 'pull' | 'conflict' {
  if (local === remote) return 'equal';
  if (remote === null) return 'conflict';
  if (remote === baseline) return 'push';
  if (local === baseline) return 'pull';
  return 'conflict';
}

interface SyncInput {
  settings: CloudSyncSettings;
  local: AppState;
  isCurrent: () => boolean;
  applyRemote: (state: AppState, expected: AppState) => boolean;
  request?: typeof api;
}

/** One guarded roundtrip; the caller serializes tabs and persists only its own settings. */
export async function synchronizeCloud({ settings, local, isCurrent, applyRemote, request = api }: SyncInput): Promise<{ settings: CloudSyncSettings; message: string }> {
  const options = { accountId: settings.userId };
  const session = await request<{ user: { id: string } | null }>('/api/auth/me');
  if (session.user?.id !== settings.userId) return { settings: { ...settings, paused: true }, message: '로그인이 만료되었거나 계정이 변경되었습니다. 해당 계정으로 로그인 후 다시 켜 주세요.' };
  const remote = validateCloud(await request<CloudState>('/api/state', 'GET', undefined, options));
  const localHash = await stateDigest(local);
  settings = acknowledgePull(settings, localHash);
  const remoteHash = remote.state ? await stateDigest(remote.state) : null;
  if (!isCurrent()) return { settings, message: '로컬 변경 저장 후 다시 확인합니다.' };
  const action = decideSync(localHash, remoteHash, settings.baseline);
  if (action === 'conflict') return { settings: { ...settings, paused: true }, message: '브라우저와 서버가 모두 변경되어 자동 동기화를 멈췄습니다. 백업 후 수동으로 사용할 버전을 선택하고 다시 켜 주세요.' };
  if (action === 'pull') {
    if (!applyRemote(remote.state!, local)) return { settings, message: '로컬 변경 저장 후 다시 확인합니다.' };
    // Only a confirmed local commit acknowledges this pending baseline.
    return { settings: { ...settings, pendingPull: { digest: remoteHash!, revision: remote.revision } }, message: '서버 변경을 가져왔습니다. 브라우저 저장을 확인 중입니다.' };
  }
  let revision = remote.revision;
  if (action === 'push') {
    const saved = await request<{ revision: number }>('/api/state', 'PUT', { state: local, revision }, options);
    if (!Number.isSafeInteger(saved.revision) || saved.revision <= revision) throw new Error('서버 저장 결과를 확인하지 못했습니다.');
    revision = saved.revision;
  }
  return { settings: { ...settings, baseline: localHash, revision, lastSyncedAt: new Date().toISOString() }, message: action === 'push' ? '브라우저 변경을 서버에 저장했습니다.' : '브라우저와 서버가 최신 상태입니다.' };
}
