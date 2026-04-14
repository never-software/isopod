import { createResource, onCleanup, type Accessor, type ResourceReturn } from "solid-js";

const DEFAULT_INTERVAL = 5000;

/**
 * Auto-polling resource. Wraps createResource + setInterval + onCleanup.
 *
 * Use `resource.state === "pending"` to gate initial loading — NOT `resource.loading`,
 * which goes true on every refetch and causes UI flicker.
 */
export function createPolledResource<T>(
  fetcher: () => Promise<T>,
  initialValue: T,
  interval = DEFAULT_INTERVAL,
): [ResourceReturn<T, true>[0], () => void] {
  const [resource, { refetch }] = createResource(fetcher, { initialValue });
  const timer = setInterval(() => refetch(), interval);
  onCleanup(() => clearInterval(timer));
  return [resource, refetch];
}

/**
 * Auto-polling keyed resource. Re-fetches when the key signal changes,
 * and also polls on an interval.
 */
export function createPolledKeyedResource<K, T>(
  key: Accessor<K>,
  fetcher: (k: K) => Promise<T>,
  interval = DEFAULT_INTERVAL,
): [ResourceReturn<T, unknown>[0], () => void] {
  const [resource, { refetch }] = createResource(key, fetcher);
  const timer = setInterval(() => refetch(), interval);
  onCleanup(() => clearInterval(timer));
  return [resource, refetch];
}
