/**
 * Permission requests that originate in the UI, not in an agent turn.
 *
 * A UI-initiated git write happens outside any agent turn, but the permission
 * trail is turn-scoped by design — both `events` and `permission_audit`
 * reference `turns(id)`, so the request used to carry a fabricated turn id (the
 * session's) and every write failed the foreign key: the prompt never reached
 * the renderer, the invoke hung for the full permission timeout, and the only
 * record was a warning in the log.
 *
 * The operation therefore gets a real turn of its own. No `turn.started` is
 * admitted, so the conversation transcript stays silent about it — the decision
 * is what the trail records. `beginTurn` also refuses while the session is
 * mid-turn (S-1), which is correct here: a git write racing a running agent is
 * exactly what the gate should not allow.
 */

import { ulid } from '@ucad/observability';
import type { PermissionRequest } from '@ucad/contracts';
import type { UcadApp } from './app-container';

export async function requestHighRiskPermission(
  ucad: Pick<UcadApp, 'sessionStore' | 'runtime'>,
  sessionId: string,
  what: string,
  resources: string[],
): Promise<boolean> {
  const session = ucad.sessionStore.getSession(sessionId);
  if (!session) return false;
  const { turnId } = ucad.sessionStore.beginTurn({ sessionId, objective: what });
  const request: PermissionRequest = {
    id: ulid('perm_'),
    sessionId,
    turnId,
    agentId: session.agentId,
    category: 'GIT_WRITE',
    risk: 'high',
    resource: resources.join(', '),
    reason: '该操作会不可逆地修改工作区',
  };
  try {
    const allowed = await ucad.runtime.requestPermission(request);
    ucad.sessionStore.transitionTurn(turnId, 'RUNNING');
    ucad.sessionStore.transitionTurn(turnId, 'COMPLETED');
    return allowed;
  } catch (err) {
    ucad.sessionStore.transitionTurn(turnId, 'RUNNING');
    ucad.sessionStore.transitionTurn(turnId, 'FAILED');
    throw err;
  }
}
