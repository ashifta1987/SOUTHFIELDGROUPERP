// Minimal Deno globals so `tsc -b` can type-check the Phase 8 Edge Functions without the Deno toolchain
// (tsconfig.functions.json). Not deployed: Edge Functions run on Supabase's Deno runtime, which has the real types.
declare const Deno: {
  env: { get(name: string): string | undefined }
  serve(handler: (req: Request) => Response | Promise<Response>): void
}
