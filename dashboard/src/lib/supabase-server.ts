import { createClient } from '@supabase/supabase-js'

// Server-only client — uses service key, bypasses RLS.
// NEVER import this in client components ('use client').
export const supabaseServer = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
)
