export function isLoopbackHost(url: string): boolean {
  const hostname = new URL(url).hostname;

  return (
    hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}
