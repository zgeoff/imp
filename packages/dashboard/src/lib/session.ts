// impd's session routes (packages/daemon auth/session-routes.ts). The token
// goes to impd once and the browser keeps only the HttpOnly cookie it sets.

export type LoginResult = 'ok' | 'wrong-token' | 'failed';

export async function sendLogin(token: string): Promise<LoginResult> {
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (response.ok) {
    return 'ok';
  }

  return response.status === 401 ? 'wrong-token' : 'failed';
}

export async function sendLogout(): Promise<void> {
  const response = await fetch('/auth/logout', { method: 'POST' });

  if (response.status !== 204) {
    throw new Error(`impd did not log out (HTTP ${String(response.status)})`);
  }
}
