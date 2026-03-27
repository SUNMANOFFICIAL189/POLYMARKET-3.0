import { supabaseServer as supabase } from './supabase-server'
import type { Leader, LeaderHistory, CopyTrade, DailyPerformance, MirofishScan } from './types'

export async function getLeaders(): Promise<Leader[]> {
  const { data, error } = await supabase
    .from('leaders')
    .select('*')
    .order('composite_score', { ascending: false })
    .limit(20)
  if (error) throw error
  return data ?? []
}

export async function getCurrentLeader(): Promise<Leader | null> {
  const { data, error } = await supabase
    .from('leaders')
    .select('*')
    .eq('is_current_leader', true)
    .single()
  if (error) return null
  return data
}

export async function getLeaderHistory(): Promise<LeaderHistory[]> {
  const { data, error } = await supabase
    .from('leader_history')
    .select('*')
    .order('became_leader_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return data ?? []
}

export async function getCopyTrades(limit = 100): Promise<CopyTrade[]> {
  const { data, error } = await supabase
    .from('copy_trades')
    .select('*')
    .in('status', ['open', 'closed', 'stopped', 'pending'])
    .order('entry_time', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function getDailyPerformance(days = 30): Promise<DailyPerformance[]> {
  const since = new Date()
  since.setDate(since.getDate() - days)
  const { data, error } = await supabase
    .from('daily_performance')
    .select('*')
    .gte('date', since.toISOString().split('T')[0])
    .order('date', { ascending: true })
  if (error) throw error
  return data ?? []
}

export async function getMirofishScans(): Promise<MirofishScan[]> {
  try {
    const bridgeUrl = process.env.MIROFISH_BRIDGE_URL || 'http://localhost:5050'
    const res = await fetch(`${bridgeUrl}/api/swarm-scores`, {
      next: { revalidate: 300 },  // 5 min cache — scans run every 90 min
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return []
    const json = await res.json()
    return (json.results ?? []) as MirofishScan[]
  } catch {
    return []
  }
}
