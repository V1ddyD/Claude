/**
 * Resolves `server-only` to its no-op build for command-line scripts.
 *
 * `server-only` throws when imported outside a React Server Component graph,
 * which is the point — it is what stops a server module reaching the browser
 * bundle. Scripts (evals, seeds, migrations) have no such graph, so they map it
 * to the package's own empty build.
 *
 * The guard still does its real job, in the Next.js bundler, untouched.
 */
export function resolve(specifier, context, next) {
  if (specifier === 'server-only') {
    return {
      url: new URL('../node_modules/server-only/empty.js', import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
