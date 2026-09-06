import { useApp } from './AppContext';
import { downloadFile } from '../features/calendar/DataPanel';
import { exportBackup } from '../services/interchange';

export function StorageNotice({ onReload }: { onReload: () => void }) {
  const { state, storageError, storageBlocked, storageConflict, storageSupported, storagePending, retrySave, resetData, reloadData } = useApp();
  if (!storageError) return null;
  return <div className="notice warning" role="alert">
    <span>{storageError}</span>
    <div className="actions-wrap">
      <button className="button ghost" onClick={() => downloadFile(exportBackup(state), 'shadow-this-tab.json', 'application/json')}>이 탭 데이터 백업</button>
      {storageConflict && <>
        <button className="button primary" disabled={storagePending} onClick={() => {
          if (window.confirm('최신 저장 데이터로 이 탭을 교체할까요? 이 탭의 미저장 변경과 실행 취소 기록은 사라집니다. 필요한 데이터는 먼저 백업해 주세요.') && reloadData()) onReload();
        }}>최신 데이터 불러오기</button>
      </>}
      {!storageConflict && storageSupported && (storageBlocked
        ? <button className="button danger" disabled={storagePending} onClick={() => { if (window.confirm('브라우저 자동 동기화를 끄고 보존 중인 로컬 저장 데이터를 초기화할까요? 되돌릴 수 없으며 서버의 일정은 유지됩니다.')) void resetData(); }}>데이터 초기화</button>
        : <button className="button ghost" disabled={storagePending} onClick={retrySave}>저장 재시도</button>)}
    </div>
  </div>;
}
