// SSR behavior tests do not render styles. Production Vite builds validate CSS.
export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return {
    format: 'module', shortCircuit: true,
    source: 'export default new Proxy({}, { get: (_, key) => String(key) });'
  };
  return nextLoad(url, context);
}
