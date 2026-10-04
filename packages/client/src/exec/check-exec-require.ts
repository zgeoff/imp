import * as z from 'zod';
import { resolveImpdUrl } from '../resolve-impd-url';
import type { ExecOutcome } from './open-exec-session';

const CHECK_TIMEOUT_MS = 5000;

// the part of a system.info answer the check reads, as `/rpc` sends it
const FeaturesSchema = z.object({ execRequire: z.boolean().optional() });
const InfoAnswerSchema = z.object({ json: z.object({ features: FeaturesSchema.optional() }) });

// An older impd drops `require` unread and runs the command anyway, so a
// start that requires anything asks impd first. Null when impd checks
// requirements; otherwise the outcome that ends the session unstarted.
export async function checkExecRequire(
  baseUrl: string,
  token: string | null,
  customFetch: (request: Request) => Promise<Response> = fetch,
): Promise<ExecOutcome | null> {
  let response: Response;

  try {
    const request = new Request(resolveImpdUrl(baseUrl, '/rpc/system/info').href, {
      method: 'POST',
      headers: token === null ? {} : { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });

    response = await customFetch(request);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    return { kind: 'unreachable', detail: `system.info: ${detail}` };
  }

  if (response.status === 401) {
    await response.body?.cancel();

    return { kind: 'unauthorized' };
  }

  const body: unknown = await response.json().catch(() => null);

  const parsed = InfoAnswerSchema.safeParse(body);

  if (!response.ok || !parsed.success) {
    return {
      kind: 'failed',
      code: null,
      message: `impd answered system.info with ${String(response.status)}; nothing was started`,
    };
  }

  if (parsed.data.json.features?.execRequire === true) {
    return null;
  }

  const detail = 'this impd is older than 0.30.0 and does not check exec requirements';

  return {
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: `nothing was started: ${detail}`,
    data: { reason: 'impd_outdated', detail },
  };
}
