// Every external request in local regression tests must use an explicit fixture.
// Model readiness probes must never contact example domains or real accounts.
globalThis.fetch=async()=>{throw new Error('Unmocked external network access is disabled in local tests.');};
