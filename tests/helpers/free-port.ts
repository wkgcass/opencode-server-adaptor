export function reserveFreePort(): number {
  const probe = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("probe"),
  })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("Bun did not allocate a probe port")
  return port
}
