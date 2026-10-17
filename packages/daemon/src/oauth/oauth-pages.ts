import type { Scope } from '@impz/api';

// The sign-in pages of the public MCP route. Every value on them is escaped,
// none runs a script or loads anything, and the forms post only to impd.

// why no redirect may go back: the page says so instead
export type SignInErrorPage =
  | 'expired'
  | 'bad_request'
  | 'unknown_client'
  | 'too_many'
  | 'approver_gone';

const ERROR_TEXT: Readonly<Record<SignInErrorPage, string>> = {
  expired: 'This sign-in ended or is not valid. Start it again from the client.',
  bad_request: 'This request is not valid.',
  unknown_client: 'This client is not one this host knows. Ask its operator to add it.',
  too_many: 'Too many sign-ins wait already. Wait a few minutes, then start again.',
  approver_gone:
    'The token that approved this sign-in is gone or no longer covers it. Start it again from the client.',
};

// What each response of these pages carries: no script, no frame, no form
// target but impd and the client's redirect, and no cache. same-origin, not
// no-referrer: under no-referrer a browser posts the form with Origin null.
export function buildPageHeaders(redirectOrigin: string | null): Headers {
  const formAction = redirectOrigin === null ? "'self'" : `'self' ${redirectOrigin}`;

  return new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
}

interface PendingView {
  // the signed authorization query the form posts back
  readonly oauthQuery: string;
  readonly clientName: string;
  readonly redirectURI: string;
  readonly requestedScope: Scope;

  // as `impz oauth approve` takes it, with its dash
  readonly approvalCode: string;
}

// the login page: the code to approve, and Continue once it is approved
export function renderPendingPage(view: Readonly<PendingView>, issuerHost: string): string {
  const returnsTo = new URL(view.redirectURI).host;

  return renderPage(
    'Approve this sign-in',
    `<p><strong>${encodeHTML(view.clientName)}</strong> asks to use the imps on <strong>${encodeHTML(issuerHost)}</strong>, with up to <strong>${encodeHTML(view.requestedScope)}</strong> scope. It returns to <strong>${encodeHTML(returnsTo)}</strong>.</p>
<p>If you started this sign-in, approve it with a named imp token:</p>
<pre>impz oauth approve ${encodeHTML(view.approvalCode)}</pre>
<p>Then press Continue. Approve only a sign-in you started: anyone can open this page for a client this host knows. The code ends in 10 minutes.</p>
<form method="post" action="/login">${renderHiddenQuery(view.oauthQuery)}<button name="action" value="continue">Continue</button> <button name="action" value="deny">Deny</button></form>`,
  );
}

interface AllowView {
  readonly oauthQuery: string;
  readonly clientName: string;
  readonly redirectURI: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;
}

// the consent page: what the approval gave, to allow or deny
export function renderAllowPage(view: Readonly<AllowView>): string {
  const imps = view.imps === null ? 'every imp, and the host' : view.imps.join(', ');

  return renderPage(
    'Allow this sign-in',
    `<p><strong>${encodeHTML(view.clientName)}</strong> gets <strong>${encodeHTML(view.scope)}</strong> scope on <strong>${encodeHTML(imps)}</strong>, and returns to <strong>${encodeHTML(view.redirectURI)}</strong>.</p>
<form method="post" action="/consent">${renderHiddenQuery(view.oauthQuery)}<button name="action" value="allow">Allow</button> <button name="action" value="deny">Deny</button></form>`,
  );
}

export function renderErrorPage(error: SignInErrorPage): string {
  return renderPage('Sign-in refused', `<p>${encodeHTML(ERROR_TEXT[error])}</p>`);
}

function renderHiddenQuery(oauthQuery: string): string {
  return `<input type="hidden" name="oauth_query" value="${encodeHTML(oauthQuery)}">`;
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${encodeHTML(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}pre{padding:.75rem;background:#eee;font-size:1.25rem}button{font:inherit;padding:.4rem 1rem}</style>
</head><body><h1>${encodeHTML(title)}</h1>
${body}
</body></html>
`;
}

// every character that could end a value or a tag
function encodeHTML(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
