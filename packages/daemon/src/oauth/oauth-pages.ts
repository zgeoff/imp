import type { AuthorizeErrorPage, PendingView } from './oauth-service';

// The sign-in pages of the public MCP route. Every value on them is escaped,
// none runs a script or loads anything, and the form posts only to impd.

const ERROR_TEXT: Readonly<Record<AuthorizeErrorPage, string>> = {
  unknown_client: 'This client is not one this host knows. Ask its operator to add it.',
  bad_redirect_uri: 'This client asked to return somewhere it was not added with.',
  expired: 'This sign-in ended or is not valid. Start it again from the client.',
  bad_request: 'This request is not valid.',
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

export function renderPendingPage(view: Readonly<PendingView>, issuerHost: string): string {
  const returnsTo = new URL(view.redirectUri).host;

  const hidden = `<input type="hidden" name="id" value="${encodeHtml(view.id)}"><input type="hidden" name="signature" value="${encodeHtml(view.signature)}">`;
  const approval = view.approval;

  if (approval === null) {
    return renderPage(
      'Approve this sign-in',
      `<p><strong>${encodeHtml(view.clientName)}</strong> asks to use the imps on <strong>${encodeHtml(issuerHost)}</strong>, with up to <strong>${encodeHtml(view.requestedScope)}</strong> scope. It returns to <strong>${encodeHtml(returnsTo)}</strong>.</p>
<p>If you started this sign-in, approve it with a named imp token:</p>
<pre>imp oauth approve ${encodeHtml(view.approvalCode)}</pre>
<p>Then press Continue. Approve only a sign-in you started: anyone can open this page for a client this host knows. The code ends in 10 minutes.</p>
<form method="post" action="/oauth/authorize">${hidden}<button name="action" value="continue">Continue</button> <button name="action" value="deny">Deny</button></form>`,
    );
  }

  const imps = approval.imps === null ? 'every imp, and the host' : approval.imps.join(', ');

  return renderPage(
    'Allow this sign-in',
    `<p><strong>${encodeHtml(view.clientName)}</strong> gets <strong>${encodeHtml(approval.scope)}</strong> scope on <strong>${encodeHtml(imps)}</strong>, and returns to <strong>${encodeHtml(view.redirectUri)}</strong>.</p>
<form method="post" action="/oauth/authorize">${hidden}<button name="action" value="allow">Allow</button> <button name="action" value="deny">Deny</button></form>`,
  );
}

export function renderErrorPage(error: AuthorizeErrorPage): string {
  return renderPage('Sign-in refused', `<p>${encodeHtml(ERROR_TEXT[error])}</p>`);
}

function renderPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${encodeHtml(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}pre{padding:.75rem;background:#eee;font-size:1.25rem}button{font:inherit;padding:.4rem 1rem}</style>
</head><body><h1>${encodeHtml(title)}</h1>
${body}
</body></html>
`;
}

// every character that could end a value or a tag
function encodeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
