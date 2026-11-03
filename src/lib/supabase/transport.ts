/** HTTP routing only: keep the SDK constructor URL public so cookie identity,
 * OAuth URLs and signed Storage links retain their existing public origin.
 * Server callers inject this fetch; browser clients must use their public URL. */
export function createSupabaseTransport(configuration: {
  publicUrl: string;
  internalUrl?: string;
  fetch?: typeof fetch;
}): typeof fetch {
  const request = configuration.fetch ?? fetch;
  const publicBase = endpoint(configuration.publicUrl);
  const internalBase = configuration.internalUrl ? endpoint(configuration.internalUrl) : null;
  if (!internalBase) return request;

  return (input, init) => {
    const original = new URL(input instanceof Request ? input.url : input);
    const prefix = publicBase.pathname.replace(/\/$/, "");
    if (original.origin !== publicBase.origin || !(original.pathname === prefix || original.pathname.startsWith(`${prefix}/`))) {
      return request(input, init);
    }
    const target = new URL(internalBase);
    target.pathname = `${internalBase.pathname.replace(/\/$/, "")}${original.pathname.slice(prefix.length)}`;
    target.search = original.search;
    // Do not let native redirect following escape the configured gateway. A
    // failed internal request is never retried against the public endpoint.
    const options = { ...init, redirect: "error" as const };
    return request(input instanceof Request ? new Request(target, input) : target, options);
  };
}

function endpoint(value: string): URL {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid Supabase HTTP endpoint configuration");
  }
  return url;
}
