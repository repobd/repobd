// Phase 0: scaffold only. No product behavior, no plaintext handling,
// no D1 binding. Real endpoints land in Phase 2 per
// docs/IMPLEMENTATION_PLAN.md.

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      if (request.method === "GET") {
        return new Response("ok", { status: 200 });
      }
      if (request.method === "HEAD") {
        return new Response(null, { status: 200 });
      }
      return new Response("method not allowed", {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }

    return new Response("not found", { status: 404 });
  },
};
