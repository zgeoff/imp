import { HttpResponse, http } from 'msw';

// what a token endpoint answers a refresh with, in its own field names
export interface StubTokenAnswer {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly id_token?: string;
  readonly expires_in?: number;
}

// one token request as the endpoint received it
interface StubTokenRequest {
  readonly contentType: string | null;
  readonly accept: string | null;
  readonly body: string;

  // the refresh token the body carries, form or JSON
  readonly refreshToken: string | null;
}

// An OAuth token endpoint at `tokenUrl` as an MSW handler, over the answers
// queued for each refresh token, one per request; a token with none left
// gets the 400 invalid_grant a dead one gets. Every request is recorded.
export function buildStubBrokerTokenEndpoint(tokenUrl: string) {
  const answers = new Map<string, StubTokenAnswer[]>();

  const requests: StubTokenRequest[] = [];

  const handler = http.post(tokenUrl, async (info) => {
    const request = info.request;
    const contentType = request.headers.get('content-type');

    const body = await request.text();

    const refreshToken =
      contentType === 'application/json'
        ? readJsonRefreshToken(body)
        : new URLSearchParams(body).get('refresh_token');

    requests.push({ contentType, accept: request.headers.get('accept'), body, refreshToken });

    const answer = answers.get(refreshToken ?? '')?.shift();

    if (answer === undefined) {
      return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
    }

    return HttpResponse.json(answer);
  });

  return {
    handler,
    requests,

    // queues one answer for a refresh with `refreshToken`
    issue: (refreshToken: string, answer: StubTokenAnswer): void => {
      answers.set(refreshToken, [...(answers.get(refreshToken) ?? []), answer]);
    },
  };
}

function readJsonRefreshToken(body: string): string | null {
  const parsed: unknown = JSON.parse(body);

  if (typeof parsed === 'object' && parsed !== null && 'refresh_token' in parsed) {
    return typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null;
  }

  return null;
}
