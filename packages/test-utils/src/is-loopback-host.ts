export function isLoopbackHost(url: string): boolean {
  const hostname = new URL(url).hostname;

  return hostname === 'localhost' || hostname === '[::1]' || hostname.startsWith('127.');
}
