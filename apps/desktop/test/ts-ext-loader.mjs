export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) &&
    !specifier.endsWith(".ts") &&
    !specifier.endsWith(".js") &&
    !specifier.endsWith(".mjs") &&
    !specifier.endsWith(".json") &&
    !specifier.includes("node:")
  ) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      // fall through
    }
  }
  return nextResolve(specifier, context);
}
