export interface LossObservation {
  kind: string;
  count: number;
  detail?: string;
}

export interface LossSession {
  sessionId: string;
  /** Adapter- or target-specific losses discovered before planning. */
  losses?: readonly LossObservation[];
}

export interface LossKindSummary {
  kind: string;
  count: number;
  sessionIds: string[];
  details: string[];
}

export interface SessionLossSummary {
  sessionId: string;
  totalCount: number;
  byKind: Array<{ kind: string; count: number }>;
}

export interface LossReport {
  totalSessionCount: number;
  lossySessionCount: number;
  losslessSessionCount: number;
  totalCount: number;
  byKind: LossKindSummary[];
  sessions: SessionLossSummary[];
}

/** Aggregate known losses into stable, machine-readable and human-summarizable groups. */
export function summarizeLosses(sessions: readonly LossSession[]): LossReport {
  const sessionIds = new Set<string>();
  const kinds = new Map<string, { count: number; sessionIds: Set<string>; details: Set<string> }>();
  const perSession = new Map<string, Map<string, number>>();

  for (const session of sessions) {
    sessionIds.add(session.sessionId);
    const observations: LossObservation[] = [...(session.losses ?? [])];

    for (const observation of observations) {
      validateObservation(observation);
      let aggregate = kinds.get(observation.kind);
      if (aggregate == null) {
        aggregate = { count: 0, sessionIds: new Set(), details: new Set() };
        kinds.set(observation.kind, aggregate);
      }
      aggregate.count += observation.count;
      aggregate.sessionIds.add(session.sessionId);
      if (observation.detail != null && observation.detail !== "") {
        aggregate.details.add(observation.detail);
      }

      let sessionKinds = perSession.get(session.sessionId);
      if (sessionKinds == null) {
        sessionKinds = new Map();
        perSession.set(session.sessionId, sessionKinds);
      }
      sessionKinds.set(
        observation.kind,
        (sessionKinds.get(observation.kind) ?? 0) + observation.count,
      );
    }
  }

  const byKind = [...kinds.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([kind, value]) => ({
      kind,
      count: value.count,
      sessionIds: [...value.sessionIds].sort(compareText),
      details: [...value.details].sort(compareText),
    }));
  const perSessionRows = [...perSession.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([sessionId, values]) => ({
      sessionId,
      totalCount: [...values.values()].reduce((sum, count) => sum + count, 0),
      byKind: [...values.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([kind, count]) => ({ kind, count })),
    }));
  const totalCount = byKind.reduce((sum, entry) => sum + entry.count, 0);

  return {
    totalSessionCount: sessionIds.size,
    lossySessionCount: perSession.size,
    losslessSessionCount: sessionIds.size - perSession.size,
    totalCount,
    byKind,
    sessions: perSessionRows,
  };
}

function validateObservation(observation: LossObservation): void {
  if (observation.kind.trim() === "") throw new TypeError("loss kind must not be empty");
  if (!Number.isSafeInteger(observation.count) || observation.count <= 0) {
    throw new RangeError("loss count must be a positive safe integer");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


