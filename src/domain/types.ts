export type SegmentKind = 'preparation' | 'outbound' | 'event' | 'return' | 'recovery';

export interface EventType {
  id: string;
  name: string;
  color: string;
  preparationMinutes: number;
  travelMinutes: number;
  recoveryMinutes: number;
  transportCostWon: number;
  mealCostWon: number;
}

export interface CalendarEvent {
  id: string;
  title: string;
  typeId: string;
  location?: string;
  date: string;
  startMinute: number;
  endMinute: number;
  shadow: {
    preparationMinutes: number;
    outboundTravelMinutes: number;
    returnTravelMinutes: number;
    recoveryMinutes: number;
  };
  cost: {
    transportWon: number;
    mealWon: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AppState {
  schemaVersion: 1;
  preferences: {
    locale: 'ko-KR';
    timeZone: 'Asia/Seoul';
    currency: 'KRW';
    weekStartsOn: 1;
  };
  eventTypes: EventType[];
  events: CalendarEvent[];
}

export interface FootprintSegment {
  kind: SegmentKind;
  start: number;
  end: number;
}

export interface EventSummary {
  coreMinutes: number;
  shadowMinutes: number;
  totalMinutes: number;
  totalCostWon: number;
}

export interface Conflict {
  eventId: string;
  otherEventId: string;
  eventSegment: SegmentKind;
  otherSegment: SegmentKind;
  overlapMinutes: number;
}
