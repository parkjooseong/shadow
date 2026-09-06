import { formatMinutes, getFootprint, summarizeEvent, toAbsoluteMinute } from '../../domain/calendar';
import type { CalendarEvent, EventType } from '../../domain/types';

export function Statistics({ days, events, types }: { days: string[]; events: CalendarEvent[]; types: EventType[] }) {
  const totals = types.map((type) => {
    let core = 0, shadow = 0, cost = 0, count = 0;
    for (const event of events.filter((item) => item.typeId === type.id)) {
      let intersects = false;
      for (const segment of getFootprint(event)) for (const day of days) {
        const start = toAbsoluteMinute(day, 0);
        const minutes = Math.max(0, Math.min(start + 1440, segment.end) - Math.max(start, segment.start));
        if (minutes) intersects = true;
        if (segment.kind === 'event') core += minutes; else shadow += minutes;
      }
      if (intersects) count++;
      if (days.includes(event.date)) cost += summarizeEvent(event).totalCostWon;
    }
    return { type, core, shadow, cost, count };
  });
  const sum = (key: 'core' | 'shadow' | 'cost') => totals.reduce((total, row) => total + row[key], 0);
  return <section className="statistics" aria-label="시간과 비용 통계">
    <h3>선택한 기간의 진짜 가격</h3>
    <div className="stat-cards"><p>일정 본체<strong>{formatMinutes(sum('core'))}</strong></p><p>숨은 시간<strong>{formatMinutes(sum('shadow'))}</strong></p><p>총 예상 비용<strong>{sum('cost').toLocaleString('ko-KR')}원</strong></p></div>
    <p className="panel-description">시간은 기간 내 겹치는 부분만, 비용은 시작일 기준입니다. 겹친 일정은 각각 합산합니다.</p>
    <div className="table-scroll"><table><thead><tr><th>유형</th><th>일정 수</th><th>점유 시간</th><th>비용</th></tr></thead><tbody>
      {totals.filter((row) => row.count).map((row) => <tr key={row.type.id}><th>{row.type.name}</th><td>{row.count}</td><td>{formatMinutes(row.core + row.shadow)}</td><td>{row.cost.toLocaleString('ko-KR')}원</td></tr>)}
    </tbody></table></div>
  </section>;
}
