/** Close only resources owned by this backend; retain failed handles for a later close retry. */
export async function closeOwnedResources<T extends { close(): Promise<unknown> }>(
  resources: Map<string, T>,
): Promise<unknown[]> {
  const entries = [...resources.entries()];
  const results = await Promise.allSettled(entries.map(([, resource]) => resource.close()));
  const failures: unknown[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') resources.delete(entries[index][0]);
    else failures.push(result.reason);
  });
  return failures;
}
