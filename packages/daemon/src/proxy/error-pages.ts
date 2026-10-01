// Plain HTML answers for requests the proxy cannot forward.

const STATUS_TITLES: Readonly<Record<number, string>> = {
  404: 'No such imp',
  502: 'Nothing answers in the imp',
  503: 'The imp could not wake',
};

export function buildErrorPage(status: number, detail: string): Response {
  const title = STATUS_TITLES[status] ?? 'Proxy error';

  const html = [
    '<!doctype html>',
    `<title>${encodeHtml(title)}</title>`,
    '<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">',
    `<h1>${String(status)} ${encodeHtml(title)}</h1>`,
    `<p>${encodeHtml(detail)}</p>`,
    '</body>',
  ].join('\n');

  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function encodeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
